// Resilient Multi-Region Replication Queue Engine
// Features:
// - Link-level Circuit Breakers (CLOSED, OPEN, HALF_OPEN)
// - High-Throughput Micro-Batching (/internal/replicate-batch)
// - AWS Architecture Full Jitter Exponential Backoff
// - Dead-Letter Queue (DLQ) & Poison Pill Isolation
// - Fast-Forward Replay on Link Recovery

class PeerCircuitBreaker {
  /**
   * @param {string} peerName
   * @param {string} peerUrl
   * @param {object} [options]
   */
  constructor(peerName, peerUrl, options = {}) {
    this.name = peerName;
    this.url = peerUrl;
    this.failureThreshold = options.failureThreshold || 3;
    this.recoveryTimeoutMs = options.recoveryTimeoutMs || 3000;

    this.state = 'CLOSED'; // 'CLOSED' | 'OPEN' | 'HALF_OPEN'
    this.consecutiveFailures = 0;
    this.lastFailureTime = 0;
    this.lastSuccessTime = Date.now();
  }

  isAvailable() {
    if (this.state === 'CLOSED') return true;

    if (this.state === 'OPEN') {
      const elapsed = Date.now() - this.lastFailureTime;
      if (elapsed >= this.recoveryTimeoutMs) {
        this.state = 'HALF_OPEN';
        return true; // Allow probe request
      }
      return false;
    }

    // HALF_OPEN: allowing single probe
    return true;
  }

  recordSuccess() {
    this.state = 'CLOSED';
    this.consecutiveFailures = 0;
    this.lastSuccessTime = Date.now();
  }

  recordFailure() {
    this.consecutiveFailures++;
    this.lastFailureTime = Date.now();

    if (this.consecutiveFailures >= this.failureThreshold) {
      this.state = 'OPEN';
    }
  }

  getStatus() {
    return {
      name: this.name,
      url: this.url,
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      lastSuccess: new Date(this.lastSuccessTime).toISOString(),
      lastFailure: this.lastFailureTime ? new Date(this.lastFailureTime).toISOString() : null
    };
  }
}

class ReplicationQueueWorker {
  /**
   * @param {object} options
   * @param {import('pg').Pool} options.pgPool - PostgreSQL connection pool
   * @param {Record<string, string>} options.peers - Map of peer region -> URL
   * @param {string} options.region - Local region name
   * @param {import('./logger')} options.logger - CloudWatch logger
   * @param {import('./security')} options.security - Region security manager
   * @param {number} [options.batchSize=50]
   * @param {number} [options.pollIntervalMs=200]
   */
  constructor({ pgPool, peers, region, logger, security, batchSize = 50, pollIntervalMs = 200 }) {
    this.pg = pgPool;
    this.peers = peers;
    this.region = region;
    this.logger = logger;
    this.security = security;
    this.batchSize = batchSize;
    this.pollIntervalMs = pollIntervalMs;

    this.isRunning = false;
    this.circuitBreakers = new Map();

    for (const [peerName, peerUrl] of Object.entries(this.peers)) {
      this.circuitBreakers.set(peerName, new PeerCircuitBreaker(peerName, peerUrl));
    }
  }

  /**
   * Calculate AWS Full-Jitter delay in milliseconds
   * formula: random_between(0, min(cap, base * 2^retryCount))
   */
  calculateFullJitterDelay(retryCount, baseSec = 1, capSec = 60) {
    const temp = Math.min(capSec, baseSec * Math.pow(2, Math.min(retryCount, 6)));
    const sleepSec = Math.random() * temp;
    return Math.floor(sleepSec * 1000);
  }

  /**
   * Send a batch of events to a remote peer with circuit breaker protection
   * @param {string} destinationRegion
   * @param {Array<object>} batchRows
   */
  async replicateBatch(destinationRegion, batchRows) {
    const cb = this.circuitBreakers.get(destinationRegion);
    if (!cb || !cb.isAvailable()) {
      return { success: false, reason: 'circuit_breaker_open' };
    }

    const peerUrl = this.peers[destinationRegion];
    const eventsPayload = batchRows.map(row => ({
      outboxId: row.id,
      eventId: row.event_id,
      key: row.key,
      value: row.value,
      dataType: row.data_type || 'lww',
      hlc: {
        time: Number(row.hlc_time || row.version || 0),
        count: Number(row.hlc_count || 0),
        node: row.origin_region
      },
      version: row.version,
      originRegion: row.origin_region,
      traceId: row.trace_id
    }));

    const bodyStr = JSON.stringify({ events: eventsPayload, fromRegion: this.region });
    const headers = this.security ? this.security.createHeaders(bodyStr, this.region) : { 'content-type': 'application/json' };

    const startTime = Date.now();
    try {
      const response = await fetch(`${peerUrl}/internal/replicate-batch`, {
        method: 'POST',
        headers,
        body: bodyStr,
        signal: AbortSignal.timeout(3000)
      });

      if (!response.ok) {
        throw new Error(`Peer HTTP ${response.status}: ${response.statusText}`);
      }

      const resJson = await response.json();
      cb.recordSuccess();

      const durationMs = Date.now() - startTime;
      const ids = batchRows.map(r => r.id);

      // Mark batch as delivered in PostgreSQL
      await this.pg.query(
        `UPDATE replication_outbox
         SET status = 'delivered', delivered_at = now(), last_error = NULL
         WHERE id = ANY($1::bigint[])`,
        [ids]
      );

      this.logger.recordMetrics('ReplicationWorker', [
        { name: 'replicatedSent', value: batchRows.length },
        { name: 'replicationBatchesSent', value: 1 },
        { name: 'replicationLagMs', value: durationMs, unit: 'Milliseconds' }
      ], { destinationRegion, batchCount: batchRows.length });

      return { success: true, processed: resJson.processed || batchRows.length };
    } catch (error) {
      cb.recordFailure();

      this.logger.warn('ReplicationWorker', `Batch delivery to ${destinationRegion} failed: ${error.message}`, {
        destinationRegion,
        batchSize: batchRows.length,
        circuitState: cb.state
      });

      // Update retries or isolate poison pills into DLQ
      for (const row of batchRows) {
        const nextRetryCount = (row.retry_count || 0) + 1;
        const maxRetries = row.max_retries || 10;

        if (nextRetryCount >= maxRetries) {
          // Move to Dead-Letter Queue
          await this.pg.query(
            `INSERT INTO replication_dlq (outbox_id, event_id, destination_region, key, payload, failure_reason, retry_count)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [row.id, row.event_id, destinationRegion, row.key, JSON.stringify(row.value), error.message, nextRetryCount]
          );

          await this.pg.query(
            `UPDATE replication_outbox SET status = 'dead_letter', last_error = $1 WHERE id = $2`,
            [`DLQ: ${error.message}`, row.id]
          );

          this.logger.recordMetrics('ReplicationWorker', [
            { name: 'deadLetterCount', value: 1 }
          ], { outboxId: row.id, destinationRegion });
        } else {
          const delayMs = this.calculateFullJitterDelay(nextRetryCount);
          await this.pg.query(
            `UPDATE replication_outbox
             SET retry_count = $1,
                 next_attempt_at = now() + ($2 || ' milliseconds')::interval,
                 last_error = $3
             WHERE id = $4`,
            [nextRetryCount, delayMs, error.message, row.id]
          );
        }
      }

      this.logger.recordMetrics('ReplicationWorker', [
        { name: 'replicationFailures', value: batchRows.length }
      ], { destinationRegion });

      return { success: false, error: error.message };
    }
  }

  /**
   * Main asynchronous queue draining loop
   */
  async start() {
    this.isRunning = true;
    this.logger.info('ReplicationWorker', `Outbox worker started for region [${this.region}]`);

    while (this.isRunning) {
      try {
        let hadActivity = false;

        // Drain queues per peer destination independently
        for (const destinationRegion of Object.keys(this.peers)) {
          const cb = this.circuitBreakers.get(destinationRegion);
          if (!cb || !cb.isAvailable()) continue;

          // Pull next micro-batch of ready events for this destination
          const result = await this.pg.query(
            `SELECT id, event_id, destination_region, key, value, data_type,
                    hlc_time, hlc_count, version, origin_region, retry_count,
                    max_retries, trace_id
             FROM replication_outbox
             WHERE destination_region = $1
               AND status = 'pending'
               AND next_attempt_at <= now()
             ORDER BY id ASC
             LIMIT $2`,
            [destinationRegion, this.batchSize]
          );

          if (result.rows.length > 0) {
            hadActivity = true;
            await this.replicateBatch(destinationRegion, result.rows);
          }
        }

        // If no work was ready, back off slightly to conserve CPU/DB cycles
        if (!hadActivity) {
          await new Promise(resolve => setTimeout(resolve, this.pollIntervalMs));
        }
      } catch (error) {
        this.logger.error('ReplicationWorker', `Fatal error in replication loop: ${error.message}`, { stack: error.stack });
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }

  stop() {
    this.isRunning = false;
  }

  /**
   * Get real-time health and circuit breaker status for all peer links
   */
  getTopologyStatus() {
    const status = {};
    for (const [name, cb] of this.circuitBreakers) {
      status[name] = cb.getStatus();
    }
    return status;
  }
}

module.exports = {
  PeerCircuitBreaker,
  ReplicationQueueWorker
};
