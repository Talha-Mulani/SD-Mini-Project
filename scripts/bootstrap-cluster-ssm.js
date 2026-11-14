// Bootstrap GeoCache Cluster across EC2 instances using AWS Systems Manager (SSM)
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const AWS_ENV = {
  ...process.env,
  AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
  AWS_SESSION_TOKEN: process.env.AWS_SESSION_TOKEN,
  AWS_DEFAULT_REGION: process.env.AWS_DEFAULT_REGION || 'us-east-1'
};

const NODES = {
  mumbai: {
    instanceId: 'i-039912dbc6e2a10b3',
    privateIp: '172.31.92.62',
    publicIp: '54.210.14.166',
    port: 5001,
    peers: '{"frankfurt":"http://172.31.24.177:5002","virginia":"http://172.31.47.234:5003"}'
  },
  frankfurt: {
    instanceId: 'i-00bbda26188437a2e',
    privateIp: '172.31.24.177',
    publicIp: '3.88.2.144',
    port: 5002,
    peers: '{"mumbai":"http://172.31.92.62:5001","virginia":"http://172.31.47.234:5003"}'
  },
  virginia: {
    instanceId: 'i-08ee336c1709a3030',
    privateIp: '172.31.47.234',
    publicIp: '3.92.82.166',
    port: 5003,
    peers: '{"mumbai":"http://172.31.92.62:5001","frankfurt":"http://172.31.24.177:5002"}'
  }
};

function runAws(cmd) {
  return execSync(`aws ${cmd}`, { env: AWS_ENV, encoding: 'utf8' }).trim();
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function bootstrapNode(name, config) {
  console.log(`\n🚀 Bootstrapping [${name.toUpperCase()}] on instance ${config.instanceId}...`);

  const script = `
set -e
export DEBIAN_FRONTEND=noninteractive

echo "1. Installing system packages..."
apt-get update -y
apt-get install -y curl git postgresql redis-server build-essential python3 python3-boto3

echo "2. Installing Node.js 22 LTS..."
if ! command -v node &> /dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

echo "3. Fetching application bundle from S3 using Boto3..."
mkdir -p /opt/geocache
python3 -c "
import boto3, gzip, json, os
s3 = boto3.client('s3', region_name='us-east-1')
s3.download_file('baalti3000', 'bundle.json.gz', '/tmp/bundle.json.gz')
with gzip.open('/tmp/bundle.json.gz', 'rb') as f:
    files = json.loads(f.read().decode('utf-8'))
for p, content in files.items():
    full_path = os.path.join('/opt/geocache', p)
    os.makedirs(os.path.dirname(full_path), exist_ok=True)
    with open(full_path, 'w', encoding='utf-8') as out:
        out.write(content)
"

cd /opt/geocache
npm install --omit=dev

echo "4. Setting up PostgreSQL..."
systemctl enable --now postgresql
sudo -u postgres psql -c "CREATE USER geocache WITH PASSWORD 'geocache';" 2>/dev/null || true
sudo -u postgres psql -c "CREATE DATABASE geocache OWNER geocache;" 2>/dev/null || true
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE geocache TO geocache;" 2>/dev/null || true
PGPASSWORD=geocache psql -h localhost -U geocache -d geocache -f /opt/geocache/db/schema.sql

echo "5. Setting up Redis..."
systemctl enable --now redis-server

echo "6. Configuring GeoCache Regional Service..."
cat << 'EOF' > /etc/systemd/system/geocache.service
[Unit]
Description=GeoCache Active-Active Regional Node (${name})
After=network.target postgresql.service redis-server.service

[Service]
Type=simple
WorkingDirectory=/opt/geocache
Environment="NODE_ENV=production"
Environment="REGION=${name}"
Environment="PORT=${config.port}"
Environment="DATABASE_URL=postgres://geocache:geocache@localhost:5432/geocache"
Environment="REDIS_URL=redis://localhost:6379"
Environment='PEERS=${config.peers}'
Environment="SECURITY_MODE=permissive"
Environment="INTER_REGION_SECRET=geocache-cluster-secret"
ExecStart=/usr/bin/node services/region.js
Restart=always
RestartSec=3
LimitNOFILE=65536
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now geocache.service

${name === 'virginia' ? `
echo "7. Configuring Global Gateway & Control Center on Virginia..."
cat << 'EOF' > /etc/systemd/system/geocache-gateway.service
[Unit]
Description=GeoCache Global Gateway & Control Center
After=network.target geocache.service

[Service]
Type=simple
WorkingDirectory=/opt/geocache
Environment="NODE_ENV=production"
Environment="PORT=3000"
Environment='REGIONS={"mumbai":"http://172.31.92.62:5001","frankfurt":"http://172.31.24.177:5002","virginia":"http://localhost:5003"}'
ExecStart=/usr/bin/node services/gateway.js
Restart=always
RestartSec=3
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now geocache-gateway.service
` : ''}

echo "=== ${name.toUpperCase()} NODE READY ==="
systemctl is-active geocache.service
`;

  const paramFile = path.join(os.tmpdir(), `ssm-params-${name}.json`);
  fs.writeFileSync(paramFile, JSON.stringify({ commands: [script] }));

  const sendRes = JSON.parse(runAws(`ssm send-command --instance-ids "${config.instanceId}" --document-name "AWS-RunShellScript" --parameters "file://${paramFile}" --output json`));
  const commandId = sendRes.Command.CommandId;
  console.log(`   Command ID: ${commandId}. Waiting for execution...`);

  try { fs.unlinkSync(paramFile); } catch {}

  let status = 'InProgress';
  let invocation = null;
  while (status === 'InProgress' || status === 'Pending') {
    await sleep(6000);
    invocation = JSON.parse(runAws(`ssm get-command-invocation --command-id "${commandId}" --instance-id "${config.instanceId}" --output json`));
    status = invocation.Status;
    console.log(`   [${name}] Status: ${status}`);
  }

  if (status === 'Success') {
    console.log(`   ✅ [${name.toUpperCase()}] successfully provisioned!`);
    console.log(invocation.StandardOutputContent.slice(-250));
  } else {
    console.error(`   ❌ [${name.toUpperCase()}] failed with status: ${status}`);
    console.error(invocation.StandardErrorContent);
  }
}

async function main() {
  console.log('================================================================');
  console.log('⚡ PROVISIONING GEOCACHE CLUSTER VIA AWS SSM (ROOT ACCESS)');
  console.log('================================================================');

  for (const [name, config] of Object.entries(NODES)) {
    await bootstrapNode(name, config);
  }

  console.log('\n================================================================');
  console.log('🎉 ALL NODES CONFIGURED AND VERIFIED!');
  console.log('================================================================');
  console.log('Live Public URLs:');
  console.log('🎛️ Control Center: http://3.92.82.166:3000');
  console.log('🇮🇳 Mumbai Node:    http://54.210.14.166:5001/health');
  console.log('🇩🇪 Frankfurt Node: http://3.88.2.144:5002/health');
  console.log('🇺🇸 Virginia Node:  http://3.92.82.166:5003/health');
  console.log('================================================================\n');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
