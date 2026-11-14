#!/usr/bin/env node
// Active-Active GeoCache Partition & Queue Replay Benchmark
// Simulates high-velocity concurrent writes during a network partition,
// measures outbox queue backlog, triggers healing, and benchmarks fast-forward batch replay.

const baseUrl = process.env.GATEWAY_URL || 'http://localhost:3100';

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function request(path, options = {}) {
  const url = `${baseUrl}${path}`;
  const res = await fetch(url, options);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status} from ${url}: ${text}`);
  }
  return res.json();
}

async function setLink(linkName, enabled) {
  console.log(`[Chaos] Setting replication link ${linkName} -> ${enabled ? 'CONNECTED' : 'PARTITIONED (CUT)'}`);
  return request(`/api/links/${linkName}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled })
  });
}

async function getTopology() {
  return request('/api/topology');
}

async function runBenchmark() {
  console.log('================================================================');
  console.log('🚀 ACTIVE-ACTIVE GEOCACHE: CHAOS & BATCH REPLAY BENCHMARK');
  console.log(`Target Gateway: ${baseUrl}`);
  console.log('================================================================\n');

  // 1. Initial Health Check
  const initialTopo = await getTopology();
  console.log('1. Checking Initial Cluster Health...');
  for (const [r, state] of Object.entries(initialTopo.regions)) {
    console.log(`   - Region [${r}]: ${state.healthy ? 'HEALTHY' : 'DOWN'} (Latency: ${state.latencyMs}ms)`);
  }

  // 2. Cut replication link between Mumbai and Frankfurt
  console.log('\n2. Injecting Network Partition between Mumbai and Frankfurt...');
  await setLink('mumbai-frankfurt', false);
  await setLink('frankfurt-mumbai', false);

  // 3. High-velocity concurrent writes to Mumbai while partitioned
  const writeCount = 50;
  console.log(`\n3. Generating ${writeCount} concurrent shopping cart & inventory writes to partitioned Mumbai...`);
  const writeStart = Date.now();

  const writePromises = [];
  for (let i = 0; i < writeCount; i++) {
    const key = `benchmark:item-${i}`;
    const payload = {
      dataType: 'pn_counter',
      value: {
        type: 'pn_counter',
        P: { mumbai: 10 + i },
        N: { mumbai: 2 }
      }
    };

    writePromises.push(
      request(`/api/records/${encodeURIComponent(key)}?region=mumbai`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      })
    );
  }

  const results = await Promise.all(writePromises);
  const writeDuration = Date.now() - writeStart;
  console.log(`   ✅ Accepted ${results.length} writes in ${writeDuration}ms (${(results.length / (writeDuration / 1000)).toFixed(1)} ops/sec)`);

  // 4. Verify Outbox Queue Accumulation
  console.log('\n4. Verifying Outbox Queue Depth during Partition...');
  await sleep(1000);
  const midTopo = await getTopology();
  const mumbaiOutbox = midTopo.regions.mumbai?.details?.outbox || {};
  console.log(`   - Mumbai Pending Queue Depth: ${mumbaiOutbox.pending || 0} events`);
  console.log(`   - Circuit Breakers:`, JSON.stringify(midTopo.regions.mumbai?.details?.circuitBreakers || {}, null, 2));

  // 5. Heal the partition
  console.log('\n5. Healing Network Partition (Re-enabling links)...');
  await setLink('mumbai-frankfurt', true);
  await setLink('frankfurt-mumbai', true);

  // 6. Benchmark Fast-Forward Batch Replay Rate
  console.log('\n6. Monitoring Fast-Forward Batch Replay & Convergence...');
  const replayStart = Date.now();
  let pending = mumbaiOutbox.pending || writeCount;

  while (pending > 0 && (Date.now() - replayStart) < 20000) {
    await sleep(500);
    const topo = await getTopology();
    pending = topo.regions.mumbai?.details?.outbox?.pending || 0;
    const delivered = topo.regions.mumbai?.details?.outbox?.delivered || 0;
    console.log(`   [Replay Progress] Pending: ${pending} | Delivered: ${delivered}`);
  }

  const replayDuration = Date.now() - replayStart;
  console.log(`\n================================================================`);
  console.log(`🎉 BENCHMARK COMPLETE:`);
  console.log(`   - Total Writes Buffered: ${writeCount}`);
  console.log(`   - Time to Drain Outbox: ${replayDuration}ms`);
  console.log(`   - Replay Throughput: ${((writeCount / (replayDuration / 1000))).toFixed(1)} events/sec`);
  console.log(`   - Final Queue Backlog: ${pending} (0 is optimal)`);
  console.log(`================================================================\n`);
}

runBenchmark().catch(err => {
  console.error('[Benchmark Error]', err.message);
  process.exit(1);
});
