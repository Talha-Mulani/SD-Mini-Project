const path = require('path');
const express = require('express');
const HashRing = require('../common/hash-ring');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'dashboard')));

const nodes = [
  { id: 'node-a', region: 'Mumbai', url: process.env.NODE_A_URL || 'http://localhost:5001' },
  { id: 'node-b', region: 'Frankfurt', url: process.env.NODE_B_URL || 'http://localhost:5002' },
  { id: 'node-c', region: 'Virginia', url: process.env.NODE_C_URL || 'http://localhost:5003' }
];
const ring = new HashRing(nodes, 32);
const partitions = new Set();
const events = [];
const metrics = { gets: 0, sets: 0, cacheHits: 0, cacheMisses: 0 };

function record(message) {
  events.unshift({ at: new Date().toISOString(), message });
  events.splice(50);
}

function primaryAndReplicas(key) {
  return ring.getReplicas(key, 3);
}

async function nodeRequest(node, route, options) {
  const response = await fetch(`${node.url}${route}`, options);
  const body = await response.json();
  return { status: response.status, ...body };
}

app.get('/api/cluster', async (req, res) => {
  const health = await Promise.all(nodes.map(async node => {
    try { return await nodeRequest(node, '/health'); }
    catch { return { id: node.id, region: node.region, healthy: false, error: 'unreachable' }; }
  }));
  res.json({ nodes: health, ring: ring.snapshot(), partitions: [...partitions], metrics, events });
});

app.get('/api/ring/:key', (req, res) => {
  const replicas = primaryAndReplicas(req.params.key);
  res.json({ key: req.params.key, replicas, primary: replicas[0] });
});

app.get('/api/cache/:key', async (req, res) => {
  metrics.gets++;
  const replicas = primaryAndReplicas(req.params.key);
  for (const node of replicas) {
    try {
      const result = await nodeRequest(node, `/cache/${encodeURIComponent(req.params.key)}`);
      if (result.status === 200) {
        metrics.cacheHits++;
        record(`GET ${req.params.key}: hit at ${node.id}`);
        return res.json({ ...result, primary: replicas[0], replicas });
      }
    } catch {}
  }
  metrics.cacheMisses++;
  record(`GET ${req.params.key}: miss`);
  res.status(404).json({ error: 'cache miss', replicas });
});

app.put('/api/cache/:key', async (req, res) => {
  const replicas = primaryAndReplicas(req.params.key);
  const primary = replicas[0];
  metrics.sets++;
  try {
    const result = await nodeRequest(primary, `/cache/${encodeURIComponent(req.params.key)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(req.body)
    });
    record(`SET ${req.params.key}: primary ${primary.id}, replicated to peers`);
    res.status(201).json({ ...result, primary, replicas });
  } catch {
    res.status(503).json({ error: 'primary unavailable', primary, replicas });
  }
});

app.post('/api/partition', async (req, res) => {
  const { from, to, open } = req.body;
  const source = nodes.find(node => node.id === from);
  if (!source || !nodes.some(node => node.id === to)) return res.status(400).json({ error: 'invalid node pair' });
  const key = [from, to].sort().join(':');
  if (open) partitions.delete(key); else partitions.add(key);
  await nodeRequest(source, `/links/${to}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ open }) });
  record(`${open ? 'Healed' : 'Partitioned'} ${from} ↔ ${to}`);
  res.json({ partitions: [...partitions] });
});

app.post('/api/replay', async (req, res) => {
  const results = await Promise.all(nodes.map(node => nodeRequest(node, '/replay', { method: 'POST' }).catch(error => ({ error: error.message }))));
  record('Replay requested on all nodes');
  res.json({ results });
});

app.post('/api/reset', async (req, res) => {
  partitions.clear();
  await Promise.all(nodes.map(node => nodeRequest(node, '/reset', { method: 'POST' }).catch(() => null)));
  record('Cluster reset requested');
  res.json({ ok: true });
});

app.post('/api/crdt/reset', async (req, res) => {
  await Promise.all(nodes.map(node => nodeRequest(node, '/reset', { method: 'POST' }).catch(() => null)));
  record('CRDT counters reset');
  res.json({ ok: true });
});

app.post('/api/crdt/demo', async (req, res) => {
  const states = await Promise.all(nodes.map(async node => {
    await nodeRequest(node, '/crdt/op', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ amount: 1 }) });
    return nodeRequest(node, '/crdt');
  }));
  const merged = states.reduce((state, item) => {
    for (const [nodeId, amount] of Object.entries(item.state.p)) state.p[nodeId] = Math.max(state.p[nodeId] || 0, amount);
    return state;
  }, { p: {}, n: {} });
  await Promise.all(nodes.map(node => nodeRequest(node, '/crdt/merge', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ state: merged }) })));
  const result = await Promise.all(nodes.map(node => nodeRequest(node, '/crdt')));
  record('CRDT demo: three concurrent increments merged without loss');
  res.json({ replicas: result, mergedValue: result[0].value });
});

app.listen(Number(process.env.PORT || 3000), () => console.log('Gateway dashboard listening on port 3000'));
