const express = require('express');
const { createCounter, increment, mergeCounter, value } = require('../common/crdt');

const app = express();
app.use(express.json());

const id = process.env.NODE_ID || 'node-local';
const region = process.env.REGION || 'local';
const port = Number(process.env.PORT || 5001);
const peers = Object.fromEntries((process.env.PEERS || '').split(',').filter(Boolean).map(entry => entry.split('=')));
const store = new Map();
const queue = [];
const links = new Map(Object.keys(peers).map(peer => [peer, true]));
const metrics = { writes: 0, reads: 0, replicationsReceived: 0, replicationsSent: 0, dropped: 0 };
let counter = createCounter();

function now() {
  return Date.now();
}

function validEntry(entry) {
  return entry && entry.expiresAt > now();
}

async function forward(target, payload) {
  if (!links.get(target)) {
    queue.push({ target, payload });
    metrics.dropped++;
    return { queued: true };
  }
  try {
    const response = await fetch(`${peers[target]}/replicate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
    metrics.replicationsSent++;
    return { queued: false, ok: response.ok };
  } catch {
    queue.push({ target, payload });
    metrics.dropped++;
    return { queued: true };
  }
}

app.get('/health', (req, res) => res.json({ id, region, healthy: true, keys: store.size, queue: queue.length, metrics }));

app.get('/state', (req, res) => {
  const entries = [...store.entries()].map(([key, entry]) => ({ key, ...entry }));
  res.json({ id, region, entries, queue: queue.length, links: Object.fromEntries(links), metrics });
});

app.get('/cache/:key', (req, res) => {
  metrics.reads++;
  const entry = store.get(req.params.key);
  if (!validEntry(entry)) return res.status(404).json({ error: 'cache miss', node: id });
  res.json({ key: req.params.key, ...entry, node: id, hit: true });
});

app.put('/cache/:key', async (req, res) => {
  const ttl = Math.max(1000, Number(req.body.ttl || 60000));
  const entry = { value: req.body.value, version: now(), origin: id, expiresAt: now() + ttl };
  store.set(req.params.key, entry);
  metrics.writes++;
  const results = await Promise.all(Object.keys(peers).map(target => forward(target, { key: req.params.key, entry })));
  res.status(201).json({ key: req.params.key, ...entry, node: id, replicated: results });
});

app.post('/replicate', (req, res) => {
  const current = store.get(req.body.key);
  if (!current || req.body.entry.version >= current.version) store.set(req.body.key, req.body.entry);
  metrics.replicationsReceived++;
  res.json({ accepted: true, node: id });
});

app.get('/crdt', (req, res) => res.json({ id, state: counter, value: value(counter) }));

app.post('/crdt/op', (req, res) => {
  counter = increment(counter, id, Number(req.body.amount || 1));
  res.json({ id, state: counter, value: value(counter) });
});

app.post('/crdt/merge', (req, res) => {
  counter = mergeCounter(counter, req.body.state || createCounter());
  res.json({ id, state: counter, value: value(counter) });
});

app.post('/reset', (req, res) => {
  store.clear();
  queue.splice(0);
  counter = createCounter();
  for (const peer of links.keys()) links.set(peer, true);
  res.json({ ok: true, node: id });
});

app.post('/links/:peer', (req, res) => {
  if (!links.has(req.params.peer)) return res.status(404).json({ error: 'unknown peer' });
  links.set(req.params.peer, Boolean(req.body.open));
  res.json({ peer: req.params.peer, open: links.get(req.params.peer) });
});

app.post('/replay', async (req, res) => {
  const pending = queue.splice(0);
  const results = await Promise.all(pending.map(message => forward(message.target, message.payload)));
  res.json({ attempted: pending.length, results });
});

app.listen(port, () => console.log(`[${id}] ${region} listening on ${port}`));
