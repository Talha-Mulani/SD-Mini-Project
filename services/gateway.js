const express = require('express');
const path = require('path');
const ConsistentHashRing = require('../lib/hashRing');
const CloudWatchLogger = require('../lib/logger');

const regions = JSON.parse(process.env.REGIONS || '{}');
const toxiproxyUrl = process.env.TOXIPROXY_URL || 'http://localhost:8474';
const port = Number(process.env.PORT || 3000);

const logger = new CloudWatchLogger({ region: 'global-gateway', service: 'geocache-gateway' });
const hashRing = new ConsistentHashRing(Object.keys(regions), { vnodes: 128 });

// Regional health cache (polled in background to avoid synchronous hop overhead)
const healthState = {};
for (const r of Object.keys(regions)) {
  healthState[r] = { healthy: true, latencyMs: 0, lastCheck: Date.now(), details: null };
}

async function pollRegionalHealth() {
  for (const [r, url] of Object.entries(regions)) {
    const start = Date.now();
    try {
      const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(800) });
      const latencyMs = Date.now() - start;
      if (response.ok) {
        const body = await response.json();
        healthState[r] = {
          healthy: true,
          latencyMs,
          lastCheck: Date.now(),
          details: body
        };
      } else {
        healthState[r] = { healthy: false, latencyMs, lastCheck: Date.now(), details: null };
      }
    } catch {
      healthState[r] = { healthy: false, latencyMs: 9999, lastCheck: Date.now(), details: null };
    }
  }
}

// Background health poller every 1500ms
setInterval(pollRegionalHealth, 1500);
pollRegionalHealth();

function selectTargetRegion(requested, key) {
  // If user explicitly pinned a region, prioritize it
  if (requested && healthState[requested]?.healthy) {
    return { region: requested, failover: false, reason: 'explicit_request' };
  }

  // Otherwise, use Consistent Hashing to find the primary shard for this key
  const primaryShard = hashRing.getNode(key) || Object.keys(regions)[0];
  if (!requested && healthState[primaryShard]?.healthy) {
    return { region: primaryShard, failover: false, reason: 'hash_ring_primary' };
  }

  // If primary or requested region is down, fail over using hash ring preference list
  const prefList = hashRing.getPreferenceList(key, Object.keys(regions).length);
  for (const fallback of prefList) {
    if (healthState[fallback]?.healthy) {
      return {
        region: fallback,
        failover: true,
        reason: requested
          ? `failover_from_${requested}_to_${fallback}`
          : `failover_primary_${primaryShard}_to_${fallback}`
      };
    }
  }

  // Any remaining healthy region
  for (const [r, state] of Object.entries(healthState)) {
    if (state.healthy) {
      return { region: r, failover: true, reason: 'any_available_fallback' };
    }
  }

  throw new Error('All multi-region clusters are currently unreachable');
}

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// Trace correlation middleware
app.use((req, res, next) => {
  req.traceId = req.headers['x-trace-id'] || CloudWatchLogger.generateTraceId();
  res.setHeader('x-trace-id', req.traceId);
  next();
});

async function proxy(request, response, method, key) {
  const traceId = request.traceId;
  const requested = request.get('x-region') || request.query.region;

  try {
    const selection = selectTargetRegion(requested, key);
    const targetUrl = regions[selection.region];

    const options = {
      method,
      headers: {
        'x-trace-id': traceId,
        'x-forwarded-for-region': selection.region
      },
      signal: AbortSignal.timeout(4000)
    };

    if (method === 'PUT') {
      options.headers['content-type'] = 'application/json';
      options.body = JSON.stringify(request.body);
    }

    const upstream = await fetch(`${targetUrl}/internal/records/${encodeURIComponent(key)}`, options);
    const body = await upstream.json();

    response.status(upstream.status).json({
      ...body,
      routedTo: selection.region,
      failover: selection.failover,
      routingReason: selection.reason,
      traceId
    });
  } catch (error) {
    logger.error('Gateway', `Proxy error for key [${key}]: ${error.message}`, { traceId });
    response.status(503).json({ error: error.message, traceId });
  }
}

app.get('/health', (req, res) => {
  res.json({
    status: 'online',
    gatewayRegion: 'global',
    regions: healthState
  });
});

app.get('/api/records/:key', (req, res) => proxy(req, res, 'GET', req.params.key));
app.put('/api/records/:key', (req, res) => proxy(req, res, 'PUT', req.params.key));

app.get('/api/topology', (req, res) => {
  res.json({ regions: healthState });
});

app.get('/api/ring', (req, res) => {
  const sampleKey = req.query.key || 'cart:sample';
  const primary = hashRing.getNode(sampleKey);
  const preferenceList = hashRing.getPreferenceList(sampleKey, 3);
  res.json({
    key: sampleKey,
    primaryNode: primary,
    preferenceList,
    nodes: Array.from(hashRing.nodes),
    vnodesPerNode: hashRing.vnodes
  });
});

app.post('/api/links/:link', async (req, res) => {
  const enabled = req.body.enabled !== false;
  try {
    const response = await fetch(`${toxiproxyUrl}/proxies/${req.params.link}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled })
    });
    if (!response.ok) {
      return res.status(502).json({ error: `Link update failed with status ${response.status}` });
    }
    res.json({ link: req.params.link, enabled });
  } catch (err) {
    res.status(502).json({ error: `Toxiproxy unreachable: ${err.message}` });
  }
});

app.listen(port, () => {
  logger.info('Gateway', `Active-Active Global GeoCache Gateway listening on port ${port}`);
});
