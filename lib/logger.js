// Enterprise CloudWatch Structured Logger with Embedded Metric Format (EMF)
// Standardized on AWS CloudWatch specification for zero-latency metric extraction and distributed tracing.

const crypto = require('crypto');

class CloudWatchLogger {
  /**
   * @param {object} options
   * @param {string} options.region - Cloud/Geo region (e.g. 'mumbai', 'frankfurt', 'virginia')
   * @param {string} [options.service='geocache']
   * @param {string} [options.namespace='GlobalCart/GeoCache']
   */
  constructor({ region, service = 'geocache', namespace = 'GlobalCart/GeoCache' }) {
    this.region = region || 'unknown-region';
    this.service = service;
    this.namespace = namespace;
    this.recentLogs = []; // In-memory ring buffer of recent logs for live web streaming
    this.maxLogs = 150;

    // Local rolling metrics aggregator for dashboard and Prometheus /metrics
    this.metrics = {
      localWrites: 0,
      localReads: 0,
      cacheHitsL1: 0,
      cacheHitsL2: 0,
      cacheMisses: 0,
      replicatedReceived: 0,
      replicatedSent: 0,
      replicationBatchesSent: 0,
      replicationFailures: 0,
      conflictsResolved: 0,
      deadLetterCount: 0,
      queueDepth: 0,
      replicationLagMs: 0
    };
  }

  /**
   * Generate an AWS X-Ray compatible Trace ID (1-timestamp-guid)
   * @returns {string}
   */
  static generateTraceId() {
    const epochSec = Math.floor(Date.now() / 1000).toString(16);
    const randomHex = crypto.randomBytes(12).toString('hex');
    return `1-${epochSec}-${randomHex}`;
  }

  /**
   * Log an event with optional CloudWatch EMF metrics.
   * @param {'info'|'warn'|'error'|'debug'} level
   * @param {string} component - e.g. 'ReplicationWorker', 'GeoCache', 'Gateway', 'HLC'
   * @param {string} msg
   * @param {object} [context]
   * @param {Array<{ name: string, value: number, unit?: string }>} [emfMetrics]
   */
  log(level, component, msg, context = {}, emfMetrics = []) {
    const timestamp = Date.now();
    const traceId = context.traceId || CloudWatchLogger.generateTraceId();

    const logEntry = {
      timestamp: new Date(timestamp).toISOString(),
      level: level.toUpperCase(),
      region: this.region,
      service: this.service,
      component,
      traceId,
      message: msg,
      ...context
    };

    // If metrics are attached, embed AWS EMF specification
    if (Array.isArray(emfMetrics) && emfMetrics.length > 0) {
      logEntry._aws = {
        Timestamp: timestamp,
        CloudWatchMetrics: [
          {
            Namespace: this.namespace,
            Dimensions: [['Region', 'Component']],
            Metrics: emfMetrics.map(m => ({
              Name: m.name,
              Unit: m.unit || 'Count'
            }))
          }
        ]
      };

      for (const m of emfMetrics) {
        logEntry[m.name] = m.value;
      }
    }

    // Output structured JSON line (ingested by CloudWatch Agent / Container daemon)
    const jsonOutput = JSON.stringify(logEntry);
    if (level === 'error') {
      console.error(jsonOutput);
    } else {
      console.log(jsonOutput);
    }

    // Append to in-memory ring buffer
    this.recentLogs.unshift({
      timestamp: logEntry.timestamp,
      level: logEntry.level,
      region: this.region,
      service: this.service,
      component,
      message: msg,
      traceId,
      context: Object.keys(context).length ? context : undefined
    });
    if (this.recentLogs.length > this.maxLogs) {
      this.recentLogs.pop();
    }
  }

  /**
   * Return recent log entries for web dashboard stream
   * @param {number} [limit=50]
   */
  getRecentLogs(limit = 50) {
    return this.recentLogs.slice(0, limit);
  }

  info(component, msg, context, emfMetrics) {
    this.log('info', component, msg, context, emfMetrics);
  }

  warn(component, msg, context, emfMetrics) {
    this.log('warn', component, msg, context, emfMetrics);
  }

  error(component, msg, context, emfMetrics) {
    this.log('error', component, msg, context, emfMetrics);
  }

  /**
   * Record metric updates locally and emit EMF log line.
   * @param {string} component
   * @param {Array<{ name: string, value: number, unit?: string }>} metricItems
   * @param {object} [context]
   */
  recordMetrics(component, metricItems, context = {}) {
    for (const item of metricItems) {
      if (this.metrics[item.name] !== undefined) {
        this.metrics[item.name] += item.value;
      }
    }
    this.log('info', component, 'Metrics telemetry flush', context, metricItems);
  }

  /**
   * Return current snapshot of metrics for REST API / dashboard.
   */
  getSnapshot() {
    return { ...this.metrics };
  }

  /**
   * Prometheus /metrics text format export
   */
  toPrometheus() {
    const lines = [];
    const r = this.region;
    for (const [k, v] of Object.entries(this.metrics)) {
      lines.push(`# TYPE geocache_${k} gauge`);
      lines.push(`geocache_${k}{region="${r}"} ${v}`);
    }
    return lines.join('\n');
  }
}

module.exports = CloudWatchLogger;
