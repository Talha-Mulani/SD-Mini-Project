const links = [
  ['mumbai-frankfurt', 6001, 'region-frankfurt:5002'],
  ['mumbai-virginia', 6002, 'region-virginia:5003'],
  ['frankfurt-mumbai', 6003, 'region-mumbai:5001'],
  ['frankfurt-virginia', 6004, 'region-virginia:5003'],
  ['virginia-mumbai', 6005, 'region-mumbai:5001'],
  ['virginia-frankfurt', 6006, 'region-frankfurt:5002']
];

async function main() {
  for (const [name, port, upstream] of links) {
    const response = await fetch('http://toxiproxy:8474/proxies', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, listen: `0.0.0.0:${port}`, upstream })
    });
    if (response.status === 409) {
      const reset = await fetch(`http://toxiproxy:8474/proxies/${name}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: true })
      });
      if (!reset.ok) throw new Error(`failed to enable ${name}: ${reset.status}`);
    } else if (!response.ok) {
      throw new Error(`failed to create ${name}: ${response.status}`);
    }
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
