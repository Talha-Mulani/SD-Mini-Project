// Automated AWS Academy Deployer for GeoCache Active-Active
// Bundles the application, uploads to S3, provisions EC2 instances across 3 AZs,
// configures PostgreSQL/Redis/Systemd, and links the distributed cluster.

const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const { execSync } = require('child_process');

const AWS_ENV = {
  ...process.env,
  AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
  AWS_SESSION_TOKEN: process.env.AWS_SESSION_TOKEN,
  AWS_DEFAULT_REGION: process.env.AWS_DEFAULT_REGION || 'us-east-1'
};

const S3_BUCKET = 'baalti3000';

function runAws(cmd) {
  return execSync(`aws ${cmd}`, { env: AWS_ENV, encoding: 'utf8' }).trim();
}

async function main() {
  console.log('================================================================');
  console.log('⚡ GeoCache Active-Active: Automatic AWS Academy Cloud Deployer');
  console.log('================================================================\n');

  // 1. Verify caller identity
  console.log('1. Verifying AWS Academy credentials...');
  const identity = JSON.parse(runAws('sts get-caller-identity'));
  console.log(`   ✅ Connected to Account ${identity.Account} (${identity.Arn})`);

  // 2. Discover default VPC and Subnets
  console.log('\n2. Discovering networking topology...');
  const vpcData = JSON.parse(runAws('ec2 describe-vpcs --filters "Name=isDefault,Values=true"'));
  const vpcId = vpcData.Vpcs[0].VpcId;
  console.log(`   - Default VPC: ${vpcId}`);

  const subnetsData = JSON.parse(runAws(`ec2 describe-subnets --filters "Name=vpc-id,Values=${vpcId}"`));
  const subnetsByAz = {};
  for (const s of subnetsData.Subnets) {
    subnetsByAz[s.AvailabilityZone] = s.SubnetId;
  }
  console.log(`   - Subnets found in AZs: ${Object.keys(subnetsByAz).join(', ')}`);

  // 3. Security Group setup
  console.log('\n3. Configuring Security Group (geocache-sg)...');
  let sgId = '';
  try {
    const existing = runAws('ec2 describe-security-groups --filters "Name=group-name,Values=geocache-sg" --query "SecurityGroups[0].GroupId" --output text');
    if (existing && existing !== 'None') {
      sgId = existing;
      console.log(`   - Using existing Security Group: ${sgId}`);
    }
  } catch {}

  if (!sgId) {
    const createSg = JSON.parse(runAws(`ec2 create-security-group --group-name geocache-sg --description "Active-Active GeoCache Cluster" --vpc-id ${vpcId}`));
    sgId = createSg.GroupId;
    console.log(`   - Created new Security Group: ${sgId}`);

    // Authorize ports
    runAws(`ec2 authorize-security-group-ingress --group-id ${sgId} --protocol tcp --port 22 --cidr 0.0.0.0/0`);
    runAws(`ec2 authorize-security-group-ingress --group-id ${sgId} --protocol tcp --port 3000 --cidr 0.0.0.0/0`);
    runAws(`ec2 authorize-security-group-ingress --group-id ${sgId} --protocol tcp --port 5001 --cidr 0.0.0.0/0`);
    runAws(`ec2 authorize-security-group-ingress --group-id ${sgId} --protocol tcp --port 5002 --cidr 0.0.0.0/0`);
    runAws(`ec2 authorize-security-group-ingress --group-id ${sgId} --protocol tcp --port 5003 --cidr 0.0.0.0/0`);
    console.log('   ✅ Inbound rules added for ports 22, 3000, 5001, 5002, 5003');
  }

  // 4. Bundle application files and upload to S3
  console.log(`\n4. Bundling application files and uploading to s3://${S3_BUCKET}/bundle.json.gz...`);
  const filesToBundle = [
    'package.json',
    'lib/hlc.js',
    'lib/hashRing.js',
    'lib/crdt.js',
    'lib/cache.js',
    'lib/queue.js',
    'lib/logger.js',
    'lib/security.js',
    'services/region.js',
    'services/gateway.js',
    'db/schema.sql',
    'public/index.html',
    'public/mumbai.html',
    'public/frankfurt.html',
    'public/virginia.html',
    'public/store.js',
    'public/store.css'
  ];

  const bundle = {};
  const rootDir = path.resolve(__dirname, '..');
  for (const rel of filesToBundle) {
    const abs = path.join(rootDir, rel);
    bundle[rel] = fs.readFileSync(abs, 'utf8');
  }

  const jsonStr = JSON.stringify(bundle);
  const gzipped = zlib.gzipSync(Buffer.from(jsonStr, 'utf8'));
  const tempBundleGz = path.join(os.tmpdir(), 'bundle.json.gz');
  fs.writeFileSync(tempBundleGz, gzipped);

  runAws(`s3 cp "${tempBundleGz}" "s3://${S3_BUCKET}/bundle.json.gz"`);
  console.log(`   ✅ Uploaded bundle (${(gzipped.length / 1024).toFixed(1)} KB) to S3.`);
  try { fs.unlinkSync(tempBundleGz); } catch {}

  const ami = 'ami-08b275ac6cc5dbefb'; // Ubuntu 24.04 LTS Noble
  const instanceType = 't3.small';

  const regionsToDeploy = [
    { name: 'mumbai', port: 5001, az: 'us-east-1a' },
    { name: 'frankfurt', port: 5002, az: 'us-east-1b' },
    { name: 'virginia', port: 5003, az: 'us-east-1c' }
  ];

  console.log('\n5. Launching 3 EC2 Virtual Machines in AWS Academy...');
  const launchedInstances = {};

  for (const r of regionsToDeploy) {
    const subnetId = subnetsByAz[r.az] || Object.values(subnetsByAz)[0];
    console.log(`   - Launching [geocache-${r.name}] on ${r.az} (subnet: ${subnetId})...`);

    const userData = `#!/bin/bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

# 1. Base packages
apt-get update -y
apt-get install -y curl git postgresql redis-server build-essential awscli jq

# 2. Node.js 22 LTS
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs

# 3. Create app dir & download bundle from S3
mkdir -p /opt/geocache
aws s3 cp s3://${S3_BUCKET}/bundle.json.gz /tmp/bundle.json.gz
gunzip /tmp/bundle.json.gz

node -e '
  const fs = require("fs"), path = require("path");
  const files = JSON.parse(fs.readFileSync("/tmp/bundle.json", "utf8"));
  for (const [p, c] of Object.entries(files)) {
    const full = path.join("/opt/geocache", p);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, c);
  }
'

cd /opt/geocache
npm install --omit=dev

# 4. PostgreSQL setup
systemctl enable --now postgresql
sudo -u postgres psql -c "CREATE USER geocache WITH PASSWORD 'geocache';" 2>/dev/null || true
sudo -u postgres psql -c "CREATE DATABASE geocache OWNER geocache;" 2>/dev/null || true
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE geocache TO geocache;" 2>/dev/null || true
PGPASSWORD=geocache psql -h localhost -U geocache -d geocache -f /opt/geocache/db/schema.sql

# 5. Redis setup
systemctl enable --now redis-server

# 6. Dynamic Peer Discovery Script
cat << 'EOF' > /opt/geocache/start-node.sh
#!/bin/bash
set -euo pipefail

MUMBAI_IP=""
FRANKFURT_IP=""
VIRGINIA_IP=""

for i in {1..40}; do
  MUMBAI_IP=$(aws ec2 describe-instances --region us-east-1 --filters "Name=tag:Name,Values=geocache-mumbai" "Name=instance-state-name,Values=running,pending" --query "Reservations[0].Instances[0].PrivateIpAddress" --output text 2>/dev/null || echo "")
  FRANKFURT_IP=$(aws ec2 describe-instances --region us-east-1 --filters "Name=tag:Name,Values=geocache-frankfurt" "Name=instance-state-name,Values=running,pending" --query "Reservations[0].Instances[0].PrivateIpAddress" --output text 2>/dev/null || echo "")
  VIRGINIA_IP=$(aws ec2 describe-instances --region us-east-1 --filters "Name=tag:Name,Values=geocache-virginia" "Name=instance-state-name,Values=running,pending" --query "Reservations[0].Instances[0].PrivateIpAddress" --output text 2>/dev/null || echo "")

  if [ -n "$MUMBAI_IP" ] && [ "$MUMBAI_IP" != "None" ] && [ -n "$FRANKFURT_IP" ] && [ "$FRANKFURT_IP" != "None" ] && [ -n "$VIRGINIA_IP" ] && [ "$VIRGINIA_IP" != "None" ]; then
    break
  fi
  sleep 4
done

MY_REGION="${r.name}"
MY_PORT="${r.port}"

if [ "$MY_REGION" = "mumbai" ]; then
  PEERS="{\\"frankfurt\\":\\"http://$FRANKFURT_IP:5002\\",\\"virginia\\":\\"http://$VIRGINIA_IP:5003\\"}"
elif [ "$MY_REGION" = "frankfurt" ]; then
  PEERS="{\\"mumbai\\":\\"http://$MUMBAI_IP:5001\\",\\"virginia\\":\\"http://$VIRGINIA_IP:5003\\"}"
else
  PEERS="{\\"mumbai\\":\\"http://$MUMBAI_IP:5001\\",\\"frankfurt\\":\\"http://$FRANKFURT_IP:5002\\"}"
fi

export NODE_ENV=production
export REGION=$MY_REGION
export PORT=$MY_PORT
export DATABASE_URL="postgres://geocache:geocache@localhost:5432/geocache"
export REDIS_URL="redis://localhost:6379"
export PEERS="$PEERS"
export SECURITY_MODE="permissive"
export INTER_REGION_SECRET="geocache-cluster-secret"

exec /usr/bin/node services/region.js
EOF

chmod +x /opt/geocache/start-node.sh

# 7. Install GeoCache systemd service
cat << 'EOF' > /etc/systemd/system/geocache.service
[Unit]
Description=GeoCache Active-Active Regional Node (${r.name})
After=network.target postgresql.service redis-server.service

[Service]
Type=simple
WorkingDirectory=/opt/geocache
ExecStart=/opt/geocache/start-node.sh
Restart=always
RestartSec=4
LimitNOFILE=65536
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now geocache.service

# On Virginia node, launch Global Gateway & Control Center
${r.name === 'virginia' ? `
cat << 'EOF' > /opt/geocache/start-gateway.sh
#!/bin/bash
set -euo pipefail

sleep 15
MUMBAI_IP=$(aws ec2 describe-instances --region us-east-1 --filters "Name=tag:Name,Values=geocache-mumbai" "Name=instance-state-name,Values=running,pending" --query "Reservations[0].Instances[0].PrivateIpAddress" --output text)
FRANKFURT_IP=$(aws ec2 describe-instances --region us-east-1 --filters "Name=tag:Name,Values=geocache-frankfurt" "Name=instance-state-name,Values=running,pending" --query "Reservations[0].Instances[0].PrivateIpAddress" --output text)

export NODE_ENV=production
export PORT=3000
export REGIONS="{\\"mumbai\\":\\"http://$MUMBAI_IP:5001\\",\\"frankfurt\\":\\"http://$FRANKFURT_IP:5002\\",\\"virginia\\":\\"http://localhost:5003\\"}"

exec /usr/bin/node services/gateway.js
EOF

chmod +x /opt/geocache/start-gateway.sh

cat << 'EOF' > /etc/systemd/system/geocache-gateway.service
[Unit]
Description=GeoCache Global Gateway & Control Center
After=network.target geocache.service

[Service]
Type=simple
WorkingDirectory=/opt/geocache
ExecStart=/opt/geocache/start-gateway.sh
Restart=always
RestartSec=4
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now geocache-gateway.service
` : ''}

echo "=== GeoCache Node ${r.name} Provisioning Finished ==="
`;

    const tempUdPath = path.join(os.tmpdir(), `geocache-userdata-${r.name}.sh`);
    fs.writeFileSync(tempUdPath, userData);

    const runCmd = `ec2 run-instances ` +
      `--image-id ${ami} ` +
      `--instance-type ${instanceType} ` +
      `--key-name vockey ` +
      `--security-group-ids ${sgId} ` +
      `--subnet-id ${subnetId} ` +
      `--iam-instance-profile Name=LabInstanceProfile ` +
      `--user-data "file://${tempUdPath}" ` +
      `--tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=geocache-${r.name}},{Key=Project,Value=GeoCache},{Key=Region,Value=${r.name}}]"`;

    const instanceData = JSON.parse(runAws(runCmd));
    const instId = instanceData.Instances[0].InstanceId;
    launchedInstances[r.name] = { id: instId, port: r.port };
    console.log(`     -> Instance ID: ${instId}`);

    try { fs.unlinkSync(tempUdPath); } catch {}
  }

  // 6. Wait for instances to boot and retrieve public IPs
  console.log('\n6. Waiting for instances to transition to RUNNING state...');
  const ids = Object.values(launchedInstances).map(i => i.id).join(' ');
  runAws(`ec2 wait instance-running --instance-ids ${ids}`);
  console.log('   ✅ All 3 EC2 instances are RUNNING!');

  // Retrieve public IPs
  console.log('\n7. Fetching assigned Public IP addresses...');
  const desc = JSON.parse(runAws(`ec2 describe-instances --instance-ids ${ids}`));
  const ips = {};

  for (const res of desc.Reservations) {
    for (const inst of res.Instances) {
      const regTag = inst.Tags.find(t => t.Key === 'Region');
      if (regTag) {
        ips[regTag.Value] = inst.PublicIpAddress;
      }
    }
  }

  console.log('\n================================================================');
  console.log('🎉 ACTIVE-ACTIVE GEOCACHE CLUSTER IS LIVE ON AWS CLOUD!');
  console.log('================================================================\n');

  console.log('📍 REAL CLOUD VM TOPOLOGY:');
  console.log(`   - 🇮🇳 Mumbai Node:    http://${ips.mumbai}:5001`);
  console.log(`   - 🇩🇪 Frankfurt Node: http://${ips.frankfurt}:5002`);
  console.log(`   - 🇺🇸 Virginia Node:  http://${ips.virginia}:5003`);
  console.log(`\n🎛️ GLOBAL CONTROL CENTER & DASHBOARD:`);
  console.log(`   👉 http://${ips.virginia}:3000`);
  console.log(`\n🛍️ LIVE STOREFRONTS:`);
  console.log(`   - Mumbai Store:    http://${ips.virginia}:3000/mumbai.html`);
  console.log(`   - Frankfurt Store: http://${ips.virginia}:3000/frankfurt.html`);
  console.log(`   - Virginia Store:  http://${ips.virginia}:3000/virginia.html`);
  console.log('\n⏳ Note: Cloud-init takes approximately 90-120 seconds to finish');
  console.log('   installing Node.js, Redis, and PostgreSQL packages on the VMs.');
  console.log('================================================================');

  // Save topology to cloud-topology.json
  const topologyFile = path.join(rootDir, 'cloud-topology.json');
  fs.writeFileSync(topologyFile, JSON.stringify({
    deployedAt: new Date().toISOString(),
    account: identity.Account,
    securityGroupId: sgId,
    instances: launchedInstances,
    publicIps: ips,
    gatewayUrl: `http://${ips.virginia}:3000`,
    nodes: {
      mumbai: `http://${ips.mumbai}:5001`,
      frankfurt: `http://${ips.frankfurt}:5002`,
      virginia: `http://${ips.virginia}:5003`
    }
  }, null, 2));
  console.log(`\nSaved live deployment details to ${topologyFile}`);
}

main().catch(err => {
  console.error('\n❌ Deployment failed:', err.message);
  process.exit(1);
});
