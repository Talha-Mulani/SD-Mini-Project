#!/bin/bash
# Production Bootstrap Script for GeoCache Node on Ubuntu 24.04 LTS (AWS EC2 / Cloud VM)
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive
REGION="${REGION}"
PORT="${PORT}"
INTER_REGION_SECRET="${INTER_REGION_SECRET}"
CLOUDWATCH_NAMESPACE="${CLOUDWATCH_NAMESPACE}"

echo "=== [1/6] Installing Base Dependencies ==="
apt-get update -y
apt-get install -y curl git build-essential postgresql redis-server amazon-cloudwatch-agent

echo "=== [2/6] Installing Node.js 22 LTS ==="
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs

echo "=== [3/6] Configuring PostgreSQL ==="
sudo -u postgres psql -c "CREATE USER geocache WITH PASSWORD 'geocache';" || true
sudo -u postgres psql -c "CREATE DATABASE geocache OWNER geocache;" || true
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE geocache TO geocache;" || true

# Apply GeoCache schema
mkdir -p /opt/geocache
cd /opt/geocache
if [ ! -d ".git" ]; then
  git clone https://github.com/your-org/active-active-geocache.git /opt/geocache || true
fi

PGPASSWORD=geocache psql -h localhost -U geocache -d geocache -f /opt/geocache/db/schema.sql || true

echo "=== [4/6] Configuring Redis ==="
systemctl enable --now redis-server

echo "=== [5/6] Setting up Systemd Service ==="
cat <<EOF > /etc/systemd/system/geocache.service
[Unit]
Description=GeoCache Active-Active Regional Node (${REGION})
After=network.target postgresql.service redis-server.service

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/opt/geocache
Environment="NODE_ENV=production"
Environment="REGION=${REGION}"
Environment="PORT=${PORT}"
Environment="DATABASE_URL=postgres://geocache:geocache@localhost:5432/geocache"
Environment="REDIS_URL=redis://localhost:6379"
Environment="INTER_REGION_SECRET=${INTER_REGION_SECRET}"
Environment="CLOUDWATCH_NAMESPACE=${CLOUDWATCH_NAMESPACE}"
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

echo "=== [6/6] Configuring AWS CloudWatch Agent ==="
cat <<EOF > /opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json
{
  "logs": {
    "logs_collected": {
      "files": {
        "collect_list": [
          {
            "file_path": "/var/log/journal/*",
            "log_group_name": "/aws/geocache/${REGION}",
            "log_stream_name": "{instance_id}",
            "auto_removal": true
          }
        ]
      }
    }
  },
  "metrics": {
    "namespace": "${CLOUDWATCH_NAMESPACE}",
    "metrics_collected": {
      "cpu": { "measurement": ["cpu_usage_idle", "cpu_usage_iowait", "cpu_usage_user", "cpu_usage_system"] },
      "mem": { "measurement": ["mem_used_percent"] },
      "net": { "measurement": ["bytes_sent", "bytes_recv"] }
    }
  }
}
EOF

/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl \
  -a fetch-config -m ec2 -s -c file:/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json || true

echo "=== GeoCache Node (${REGION}) Provisioning Complete! ==="
