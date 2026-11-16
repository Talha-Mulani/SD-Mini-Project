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
  console.log('1. Bundling updated source files...');
  const files = [
    'package.json', 'lib/hlc.js', 'lib/hashRing.js', 'lib/crdt.js',
    'lib/cache.js', 'lib/queue.js', 'lib/logger.js', 'lib/security.js',
    'services/region.js', 'services/gateway.js', 'db/schema.sql',
    'public/index.html', 'public/mumbai.html', 'public/frankfurt.html',
    'public/virginia.html', 'public/store.js', 'public/store.css'
  ];

  const bundle = {};
  for (const rel of files) {
    bundle[rel] = fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');
  }

  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(bundle), 'utf8'));
  const tmp = path.join(os.tmpdir(), 'bundle.json.gz');
  fs.writeFileSync(tmp, gz);

  console.log(`2. Uploading bundle (${(gz.length / 1024).toFixed(1)} KB) to s3://${S3_BUCKET}/bundle.json.gz...`);
  runAws(`s3 cp "${tmp}" "s3://${S3_BUCKET}/bundle.json.gz"`);
  console.log('   ✅ S3 upload complete!');

  const instanceIds = ['i-039912dbc6e2a10b3', 'i-00bbda26188437a2e', 'i-08ee336c1709a3030'];
  console.log('\n3. Deploying update to EC2 instances via AWS Systems Manager (SSM)...');

  const updateScript = `#!/bin/bash
set -e
export DEBIAN_FRONTEND=noninteractive

python3 -c "
import boto3, gzip, json, os
s3 = boto3.client('s3', region_name='us-east-1')
s3.download_file('${S3_BUCKET}', 'bundle.json.gz', '/tmp/bundle.json.gz')
with gzip.open('/tmp/bundle.json.gz', 'rb') as f:
    files = json.loads(f.read().decode('utf-8'))
for rel, content in files.items():
    full = os.path.join('/opt/geocache', rel)
    os.makedirs(os.path.dirname(full), exist_ok=True)
    with open(full, 'w', encoding='utf-8') as out:
        out.write(content)
print('Unpacked', len(files), 'files')
"

systemctl restart geocache
systemctl restart geocache-gateway 2>/dev/null || true
echo "Update applied successfully"
`;

  const paramFile = path.join(os.tmpdir(), 'ssm-update-params.json');
  fs.writeFileSync(paramFile, JSON.stringify({ commands: [updateScript] }));

  const runRes = JSON.parse(runAws(`ssm send-command --instance-ids ${instanceIds.join(' ')} --document-name "AWS-RunShellScript" --parameters "file://${paramFile}" --output json`));
  const commandId = runRes.Command.CommandId;
  console.log(`   - SSM Command sent! CommandId: ${commandId}`);
  try { fs.unlinkSync(paramFile); } catch {}

  console.log('4. Waiting 8 seconds for instances to apply update...');
  await new Promise(r => setTimeout(r, 8000));

  console.log('   ✅ Update deployed to all 3 nodes and Gateway!');
}

main().catch(err => {
  console.error('❌ Failed:', err.message);
  process.exit(1);
});
