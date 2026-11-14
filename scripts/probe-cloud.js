// Quick probe script to check cloud node readiness
async function probe() {
  const urls = [
    { name: 'Mumbai', url: 'http://54.210.14.166:5001/health' },
    { name: 'Frankfurt', url: 'http://3.88.2.144:5002/health' },
    { name: 'Virginia', url: 'http://3.92.82.166:5003/health' },
    { name: 'Gateway', url: 'http://3.92.82.166:3000/health' }
  ];

  console.log('--- Probing Cloud Nodes ---');
  for (const u of urls) {
    try {
      const res = await fetch(u.url, { signal: AbortSignal.timeout(3000) });
      const data = await res.json();
      console.log(`✅ [${u.name}] HTTP ${res.status} | Healthy: ${data.healthy !== false} | Details:`, JSON.stringify(data).slice(0, 100));
    } catch (err) {
      console.log(`⏳ [${u.name}] Booting... (${err.message})`);
    }
  }
}

probe();
