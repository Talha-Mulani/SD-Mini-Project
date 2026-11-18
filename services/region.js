const crypto = require('crypto');
const express = require('express');
const { Pool } = require('pg');
const { createClient } = require('redis');

const HybridLogicalClock = require('../lib/hlc');
const ConsistentHashRing = require('../lib/hashRing');
const { ConflictResolver } = require('../lib/crdt');
const MultiTierGeoCache = require('../lib/cache');
const CloudWatchLogger = require('../lib/logger');
const RegionSecurity = require('../lib/security');
const { ReplicationQueueWorker } = require('../lib/queue');

const region = process.env.REGION || 'unknown-region';
const port = Number(process.env.PORT || 5000);
const peers = JSON.parse(process.env.PEERS || '{}');

const logger = new CloudWatchLogger({ region, service: 'geocache-regional' });
const security = new RegionSecurity(process.env.INTER_REGION_SECRET);
const hlc = new HybridLogicalClock(region);

const pg = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000
});

const redis = createClient({ url: process.env.REDIS_URL });

const cache = new MultiTierGeoCache({
  redisClient: redis,
  l1MaxItems: 1000,
  l1TtlMs: 10000,
  l2TtlSec: 3600,
  beta: 1.0
});

const queueWorker = new ReplicationQueueWorker({
  pgPool: pg,
  peers,
  region,
  logger,
  security,
  batchSize: 50,
  pollIntervalMs: 200
});

const app = express();
app.use(express.json({ limit: '5mb' }));

// Trace correlation middleware
app.use((req, res, next) => {
  req.traceId = req.headers['x-trace-id'] || CloudWatchLogger.generateTraceId();
  res.setHeader('x-trace-id', req.traceId);
  res.setHeader('x-geocache-region', region);
  next();
});

async function loadFromDatabase(key) {
  const result = await pg.query(
    `SELECT key, value, data_type, hlc_time, hlc_count, version, origin_region, updated_at
     FROM records WHERE key = $1`,
    [key]
  );
  return result.rows[0] || null;
}

/**
 * Atomically apply an incoming event or write to the database
 */
async function applyEvent(client, event) {
  const currentResult = await client.query(
    `SELECT key, value, data_type, hlc_time, hlc_count, version, origin_region
     FROM records WHERE key = $1 FOR UPDATE`,
    [event.key]
  );
  const current = currentResult.rows[0];

  const resolution = ConflictResolver.resolve(current, event);

  if (!resolution.applied) {
    logger.recordMetrics('ConflictEngine', [
      { name: 'conflictsResolved', value: 1 }
    ], { key: event.key, outcome: 'suppressed' });
    return { applied: false, resolvedValue: current ? current.value : null };
  }

  const hlcTime = event.hlc?.time || event.version || Date.now();
  const hlcCount = event.hlc?.count || 0;
  const dataType = resolution.resolvedType.includes('pn_counter')
    ? 'pn_counter'
    : resolution.resolvedType.includes('or_set')
    ? 'or_set'
    : 'lww';

  await client.query(
    `INSERT INTO records (key, value, data_type, hlc_time, hlc_count, version, origin_region, updated_at)
     VALUES ($1, $2::jsonb, $3, $4, $5, $6, $7, now())
     ON CONFLICT (key) DO UPDATE SET
       value = EXCLUDED.value,
       data_type = EXCLUDED.data_type,
       hlc_time = EXCLUDED.hlc_time,
       hlc_count = EXCLUDED.hlc_count,
       version = EXCLUDED.version,
       origin_region = EXCLUDED.origin_region,
       updated_at = now()`,
    [
      event.key,
      JSON.stringify(resolution.mergedValue),
      dataType,
      hlcTime,
      hlcCount,
      event.version || hlcTime,
      event.originRegion
    ]
  );

  if (resolution.conflictResolved) {
    logger.recordMetrics('ConflictEngine', [
      { name: 'conflictsResolved', value: 1 }
    ], { key: event.key, outcome: 'merged', dataType });
  }

  return { applied: true, resolvedValue: resolution.mergedValue };
}

// ---------------- REST API ROUTES ----------------

app.get('/health', async (req, res) => {
  try {
    const [outboxRes, dlqRes] = await Promise.all([
      pg.query(
        `SELECT
           count(*) FILTER (WHERE status = 'pending')::int AS pending,
           count(*) FILTER (WHERE status = 'delivered')::int AS delivered,
           count(*) FILTER (WHERE status = 'dead_letter')::int AS dead_letter
         FROM replication_outbox`
      ),
      pg.query(`SELECT count(*)::int AS count FROM replication_dlq`)
    ]);

    const outboxStats = outboxRes.rows[0];
    const dlqCount = dlqRes.rows[0].count;
    const circuitBreakers = queueWorker.getTopologyStatus();

    res.json({
      region,
      healthy: true,
      timestamp: new Date().toISOString(),
      hlc: hlc.now(),
      outbox: outboxStats,
      dlq: { count: dlqCount },
      circuitBreakers,
      metrics: logger.getSnapshot()
    });
  } catch (error) {
    logger.error('HealthCheck', `Health check failed: ${error.message}`, { traceId: req.traceId });
    res.status(503).json({ region, healthy: false, error: error.message });
  }
});

app.get('/metrics', (req, res) => {
  res.setHeader('content-type', 'text/plain; version=0.0.4');
  res.send(logger.toPrometheus());
});

app.post('/internal/partition', (req, res) => {
  const { peer, severed } = req.body;
  if (!peer) return res.status(400).json({ error: 'peer is required' });

  const success = queueWorker.setPeerPartition(peer, !!severed);
  logger.info('Chaos', `Partition for peer [${peer}] set to: ${severed ? 'SEVERED' : 'HEALED'}`);
  res.json({
    region,
    peer,
    severed: !!severed,
    success,
    circuitBreakers: queueWorker.getTopologyStatus()
  });
});

app.get('/internal/recent-keys', async (req, res) => {
  try {
    const result = await pg.query(
      `SELECT key, data_type, origin_region, updated_at
       FROM records
       ORDER BY updated_at DESC
       LIMIT 25`
    );
    res.json({ region, keys: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/internal/records/:key', async (req, res) => {
  const key = req.params.key;
  logger.recordMetrics('GeoCache', [{ name: 'localReads', value: 1 }]);

  try {
    const result = await cache.getOrLoad(key, () => loadFromDatabase(key));

    if (!result.record) {
      logger.recordMetrics('GeoCache', [{ name: 'cacheMisses', value: 1 }]);
      return res.status(404).json({ error: 'not found', region });
    }

    if (result.source === 'l1') {
      logger.recordMetrics('GeoCache', [{ name: 'cacheHitsL1', value: 1 }]);
    } else if (result.source === 'redis') {
      logger.recordMetrics('GeoCache', [{ name: 'cacheHitsL2', value: 1 }]);
    } else {
      logger.recordMetrics('GeoCache', [{ name: 'cacheMisses', value: 1 }]);
    }

    res.json({
      ...result.record,
      source: result.source,
      xfetchTriggered: result.xfetchTriggered,
      region
    });
  } catch (error) {
    logger.error('GeoCache', `Read error for key [${key}]: ${error.message}`, { traceId: req.traceId });
    res.status(500).json({ error: error.message });
  }
});

app.put('/internal/records/:key', async (req, res) => {
  if (req.body.value === undefined) {
    return res.status(400).json({ error: 'value is required' });
  }

  const key = req.params.key;
  const eventHlc = hlc.now();
  const eventId = crypto.randomUUID();
  const dataType = req.body.dataType || (req.body.value && req.body.value.type) || 'lww';

  const event = {
    eventId,
    key,
    value: req.body.value,
    dataType,
    hlc: eventHlc,
    version: eventHlc.time,
    originRegion: region,
    traceId: req.traceId
  };

  const client = await pg.connect();
  try {
    await client.query('BEGIN');

    // 1. Persist local record
    const { applied, resolvedValue } = await applyEvent(client, event);

    // 2. Persist replication outbox events for all configured peer regions
    for (const destinationRegion of Object.keys(peers)) {
      await client.query(
        `INSERT INTO replication_outbox
          (event_id, destination_region, key, value, data_type, hlc_time, hlc_count, version, origin_region, trace_id)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (event_id, destination_region) DO NOTHING`,
        [
          event.eventId,
          destinationRegion,
          key,
          JSON.stringify(event.value),
          dataType,
          eventHlc.time,
          eventHlc.count,
          event.version,
          region,
          req.traceId
        ]
      );
    }

    await client.query('COMMIT');

    // 3. Hydrate multi-tier cache (L1 Memory + L2 Redis)
    const cachedRecord = {
      key,
      value: resolvedValue || event.value,
      dataType,
      hlc_time: eventHlc.time,
      hlc_count: eventHlc.count,
      version: event.version,
      origin_region: region
    };
    await cache.set(key, cachedRecord);

    logger.recordMetrics('GeoCache', [{ name: 'localWrites', value: 1 }]);
    res.status(201).json({
      ...event,
      acceptedBy: region,
      replication: 'asynchronous-outbox'
    });
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error('GeoCache', `Write transaction failed: ${error.message}`, { traceId: req.traceId });
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

/**
 * High-Throughput Micro-Batch Replication Endpoint
 */
app.post('/internal/replicate-batch', async (req, res) => {
  const auth = security.verifyRequest(req);
  if (!auth.valid) {
    logger.warn('Security', `Unauthorized batch replication attempt: ${auth.reason}`, { traceId: req.traceId });
    return res.status(401).json({ error: auth.reason });
  }

  const { events, fromRegion } = req.body;
  if (!Array.isArray(events) || events.length === 0) {
    return res.status(400).json({ error: 'events array required' });
  }

  const client = await pg.connect();
  let appliedCount = 0;
  let duplicateCount = 0;

  try {
    await client.query('BEGIN');

    for (const event of events) {
      // Advance local HLC with remote clock
      if (event.hlc) {
        hlc.update(event.hlc);
      }

      // Check deduplication
      const inserted = await client.query(
        `INSERT INTO applied_events (event_id, origin_region, key, hlc_time)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (event_id) DO NOTHING
         RETURNING event_id`,
        [event.eventId, event.originRegion, event.key, event.hlc?.time || event.version || 0]
      );

      if (inserted.rowCount > 0) {
        const { applied, resolvedValue } = await applyEvent(client, event);
        if (applied) {
          appliedCount++;
          // Update cache
          await cache.set(event.key, {
            key: event.key,
            value: resolvedValue || event.value,
            dataType: event.dataType,
            hlc_time: event.hlc?.time || event.version,
            hlc_count: event.hlc?.count || 0,
            version: event.version,
            origin_region: event.originRegion
          });
        }
      } else {
        duplicateCount++;
      }
    }

    await client.query('COMMIT');

    logger.recordMetrics('ReplicationWorker', [
      { name: 'replicatedReceived', value: appliedCount }
    ], { fromRegion, totalBatch: events.length, appliedCount, duplicateCount });

    res.json({
      accepted: true,
      processed: events.length,
      applied: appliedCount,
      duplicates: duplicateCount,
      region
    });
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error('ReplicationWorker', `Batch apply failed: ${error.message}`, { traceId: req.traceId });
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

// Single event replication (for backward compatibility)
app.post('/internal/replicate', async (req, res) => {
  const event = req.body;
  if (!event?.eventId || !event.key) {
    return res.status(400).json({ error: 'invalid replication event' });
  }

  if (event.hlc) {
    hlc.update(event.hlc);
  }

  const client = await pg.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query(
      `INSERT INTO applied_events (event_id, origin_region, key, hlc_time)
       VALUES ($1, $2, $3, $4) ON CONFLICT (event_id) DO NOTHING RETURNING event_id`,
      [event.eventId, event.originRegion, event.key, event.hlc?.time || event.version || 0]
    );

    if (inserted.rowCount > 0) {
      const { applied, resolvedValue } = await applyEvent(client, event);
      await client.query('COMMIT');
      if (applied) {
        await cache.set(event.key, {
          key: event.key,
          value: resolvedValue || event.value,
          dataType: event.dataType,
          hlc_time: event.hlc?.time || event.version,
          hlc_count: event.hlc?.count || 0,
          version: event.version,
          origin_region: event.originRegion
        });
      }
      logger.recordMetrics('ReplicationWorker', [{ name: 'replicatedReceived', value: 1 }]);
      return res.json({ accepted: true, applied, region });
    }

    await client.query('ROLLBACK');
    res.json({ accepted: true, duplicate: true, region });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

// Dead-Letter Queue Inspection Endpoint
app.get('/internal/dlq', async (req, res) => {
  try {
    const result = await pg.query(
      `SELECT id, outbox_id, event_id, destination_region, key, payload, failure_reason, retry_count, failed_at
       FROM replication_dlq
       ORDER BY id DESC
       LIMIT 50`
    );
    res.json({ region, dlq: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Startup sequence
async function start() {
  try {
    await redis.connect();
    logger.info('System', `Connected to Redis cluster in region [${region}]`);
  } catch (err) {
    logger.warn('System', `Redis connect warning (operating in degraded L1-only mode): ${err.message}`);
  }

  await pg.query('SELECT 1');
  logger.info('System', `PostgreSQL connected for region [${region}]`);

  app.listen(port, () => {
    logger.info('System', `GeoCache regional service listening on port ${port}`);
  });

  // Start background resilient replication worker
  queueWorker.start().catch(err => {
    logger.error('ReplicationWorker', `Queue worker failed: ${err.message}`, { stack: err.stack });
  });
}

start().catch(error => {
  logger.error('System', `Startup failed: ${error.message}`, { stack: error.stack });
  process.exitCode = 1;
});
