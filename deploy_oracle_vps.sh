#!/usr/bin/env bash
# ==============================================================================
# RailFlow Autonoma — 1-Command Automated Installer for 1GB RAM / 1 vCPU VPS
# + Cloudflare Tunnel Integration for https://autonoma.noxverse.in
# ==============================================================================
set -euo pipefail

echo "===================================================================="
echo " 🚆 RailFlow Autonoma — Automated 1GB RAM VPS + Tunnel Installer"
echo "===================================================================="

# 1. Create 2GB Swap File (prevents OOM on 1GB RAM VPS during npm build)
if ! swapon --show | grep -q '/swapfile'; then
  echo "[1/7] Creating 2GB swapfile for 1GB RAM safety..."
  fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
else
  echo "[1/7] 2GB swapfile already active."
fi

# 2. Install System Dependencies, Node.js 20 & cloudflared
echo "[2/7] Installing Python 3, Nginx, Git, Node.js 20, and cloudflared..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y python3 python3-venv python3-pip nginx git curl iptables

if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

if ! command -v cloudflared >/dev/null 2>&1; then
  ARCH=$(dpkg --print-architecture 2>/dev/null || uname -m)
  if [[ "$ARCH" == "aarch64" || "$ARCH" == "arm64" ]]; then
    CF_DEB="cloudflared-linux-arm64.deb"
  else
    CF_DEB="cloudflared-linux-amd64.deb"
  fi
  curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/${CF_DEB}" -o /tmp/cloudflared.deb
  dpkg -i /tmp/cloudflared.deb
  rm -f /tmp/cloudflared.deb
fi

# 3. Clone or Update Repository
echo "[3/7] Fetching RailFlow_Autonoma into /opt/railflow..."
if [ -d "/opt/railflow/.git" ]; then
  cd /opt/railflow
  git fetch origin main
  git reset --hard origin/main
else
  rm -rf /opt/railflow
  git clone https://github.com/takshalchaudhari/RailFlow_Autonoma.git /opt/railflow
  cd /opt/railflow
fi
chmod +x /opt/railflow/*.sh || true

# 4. Install Python Backend Dependencies
echo "[4/7] Setting up Python virtual environment & backend packages..."
python3 -m venv /opt/railflow/.venv
/opt/railflow/.venv/bin/pip install --upgrade pip
/opt/railflow/.venv/bin/pip install -r /opt/railflow/requirements.txt

# 5. Build Frontend Static Assets (Capped at 512MB RAM for 1GB VPS)
echo "[5/7] Building React frontend with 512MB RAM limit..."
cd /opt/railflow/frontend
NODE_OPTIONS="--max-old-space-size=512" npm install --no-audit --no-fund
NODE_OPTIONS="--max-old-space-size=512" npm run build
cd /opt/railflow

# 6. Configure .env and systemd Service (Single Process ~85MB RAM)
echo "[6/7] Configuring .env and systemd service on 127.0.0.1:8010..."
if [ ! -f /opt/railflow/.env ]; then
  cp /opt/railflow/.env.example /opt/railflow/.env
fi
if [ -n "${ELEVENLABS_API_KEY:-}" ]; then
  sed -i "s|^ELEVENLABS_API_KEY=.*|ELEVENLABS_API_KEY=${ELEVENLABS_API_KEY}|" /opt/railflow/.env || true
fi

cat >/etc/systemd/system/railflow.service <<'EOF'
[Unit]
Description=RailFlow Autonoma Single-Process FastAPI + SPA Server
After=network.target

[Service]
User=root
WorkingDirectory=/opt/railflow
EnvironmentFile=/opt/railflow/.env
ExecStart=/opt/railflow/.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8010 --workers 1 --limit-concurrency 64
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now railflow
systemctl restart railflow

# 7. Configure Nginx Reverse Proxy & Cloudflare Tunnel
echo "[7/7] Configuring local Nginx proxy and checking Cloudflare Tunnel..."
cat >/etc/nginx/sites-available/railflow <<'EOF'
server {
    listen 80;
    server_name autonoma.noxverse.in _;

    client_max_body_size 5M;

    location / {
        proxy_pass http://127.0.0.1:8010;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
EOF

ln -sf /etc/nginx/sites-available/railflow /etc/nginx/sites-enabled/railflow
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl restart nginx
iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT || true

# If CF_TUNNEL_TOKEN was provided, activate the tunnel immediately!
if [ -n "${CF_TUNNEL_TOKEN:-}" ]; then
  bash /opt/railflow/setup_cloudflare_tunnel.sh
fi

PUBLIC_IP=$(curl -s --max-time 4 ifconfig.me || hostname -I | awk '{print $1}')
echo "===================================================================="
echo " ✅ RailFlow Autonoma Backend + SPA Server is RUNNING on :8010!"
echo " 👉 Direct IP URL:   http://${PUBLIC_IP}/app"
echo " 👉 To bind Cloudflare Tunnel to https://autonoma.noxverse.in, run:"
echo "    sudo bash /opt/railflow/setup_cloudflare_tunnel.sh"
echo "===================================================================="
