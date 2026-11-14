#!/usr/bin/env bash
# Generic Linux VM Bootstrap Script for Active-Active GeoCache
# Supports Ubuntu 22.04 / 24.04 and Debian 12

set -euo pipefail

TARGET_REGION="${1:-mumbai}"
TARGET_PORT="${2:-5001}"
PEERS_JSON="${3:-'{}'}"

echo "=========================================================="
echo "⚡ Setting up GeoCache Active-Active Node on Linux VM"
echo "Region: ${TARGET_REGION} | Port: ${TARGET_PORT}"
echo "=========================================================="

# Check root
if [ "$EUID" -ne 0 ]; then
  echo "[-] Please run as root (e.g., sudo ./setup-vm.sh)"
  exit 1
fi

# 1. Base packages
apt-get update -y
apt-get install -y curl git postgresql redis-server build-essential

# 2. Node.js 22 LTS
if ! command -v node &> /dev/null; then
  echo "[+] Installing Node.js 22 LTS..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

# 3. PostgreSQL Database setup
echo "[+] Configuring PostgreSQL..."
systemctl enable --now postgresql
sudo -u postgres psql -c "CREATE USER geocache WITH PASSWORD 'geocache';" 2>/dev/null || true
sudo -u postgres psql -c "CREATE DATABASE geocache OWNER geocache;" 2>/dev/null || true
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE geocache TO geocache;" 2>/dev/null || true

# 4. Redis setup
echo "[+] Configuring Redis..."
systemctl enable --now redis-server

# 5. Application setup
APP_DIR="/opt/active-active-geocache"
if [ ! -d "$APP_DIR" ]; then
  echo "[+] Creating application directory at $APP_DIR..."
  mkdir -p "$APP_DIR"
  cp -r . "$APP_DIR" 2>/dev/null || true
fi

cd "$APP_DIR"
npm ci --omit=dev || npm install --omit=dev

# Apply schema
PGPASSWORD=geocache psql -h localhost -U geocache -d geocache -f db/schema.sql

# 6. Install systemd service
SERVICE_NAME="geocache-${TARGET_REGION}"
echo "[+] Installing systemd service ${SERVICE_NAME}..."

cat <<EOF > "/etc/systemd/system/${SERVICE_NAME}.service"
[Unit]
Description=GeoCache Active-Active Regional Node (${TARGET_REGION})
After=network.target postgresql.service redis-server.service

[Service]
Type=simple
WorkingDirectory=${APP_DIR}
Environment="NODE_ENV=production"
Environment="REGION=${TARGET_REGION}"
Environment="PORT=${TARGET_PORT}"
Environment="DATABASE_URL=postgres://geocache:geocache@localhost:5432/geocache"
Environment="REDIS_URL=redis://localhost:6379"
Environment="PEERS=${PEERS_JSON}"
Environment="SECURITY_MODE=permissive"
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
systemctl enable --now "${SERVICE_NAME}"

echo "=========================================================="
echo "✅ GeoCache Node (${TARGET_REGION}) is LIVE!"
echo "Check status: systemctl status ${SERVICE_NAME}"
echo "View live logs: journalctl -u ${SERVICE_NAME} -f"
echo "Health endpoint: curl http://localhost:${TARGET_PORT}/health"
echo "=========================================================="
