async function testCrossRegion() {
  console.log('1. Submitting write to MUMBAI VM (http://54.210.14.166:5001)...');
  const writeRes = await fetch('http://54.210.14.166:5001/internal/records/cart:cloud-user-1', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      dataType: 'or_set',
      value: {
        type: 'or_set',
        elements: [{ item: { sku: 'shoe-101', qty: 2 }, tag: 'tag-cloud-1' }],
        tombstones: []
      }
    })
  });
  const writeData = await writeRes.json();
  console.log('   ✅ Accepted by:', writeData.acceptedBy, '| HLC:', writeData.hlc);

  console.log('\n2. Waiting 800ms for asynchronous outbox replication...');
  await new Promise(r => setTimeout(r, 800));

  console.log('\n3. Reading from FRANKFURT VM (http://3.88.2.144:5002)...');
  const readFra = await (await fetch('http://3.88.2.144:5002/internal/records/cart:cloud-user-1')).json();
  console.log('   ✅ Frankfurt value:', JSON.stringify(readFra.value), '| Source:', readFra.source);

  console.log('\n4. Reading from VIRGINIA VM (http://3.92.82.166:5003)...');
  const readVir = await (await fetch('http://3.92.82.166:5003/internal/records/cart:cloud-user-1')).json();
  console.log('   ✅ Virginia value:', JSON.stringify(readVir.value), '| Source:', readVir.source);

  console.log('\n5. Querying Global Gateway Topology (http://3.92.82.166:3000/api/topology)...');
  const topo = await (await fetch('http://3.92.82.166:3000/api/topology')).json();
  console.log('   ✅ Active Gateway Topology:');
  for (const [r, s] of Object.entries(topo.regions)) {
    console.log(`      - ${r.toUpperCase()}: ${s.healthy ? 'HEALTHY' : 'DOWN'} (Latency: ${s.latencyMs}ms | Outbox Delivered: ${s.details?.outbox?.delivered || 0})`);
  }
}

testCrossRegion().catch(err => {
  console.error('Error:', err.message);
});
