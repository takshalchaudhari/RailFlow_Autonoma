#!/usr/bin/env bash
# ==============================================================================
# RailFlow Autonoma — Automated Cloudflare Tunnel Setup for autonoma.noxverse.in
# Routes https://autonoma.noxverse.in -> http://127.0.0.1:8010 via cloudflared
# No open inbound ports (80/443) or manual SSL certificates required!
# ==============================================================================
set -euo pipefail

DOMAIN="${CF_DOMAIN:-autonoma.noxverse.in}"
TUNNEL_NAME="${CF_TUNNEL_NAME:-railflow-autonoma}"
LOCAL_SERVICE="http://127.0.0.1:8010"

echo "===================================================================="
echo " Cloudflare Tunnel Setup -> https://${DOMAIN}"
echo "===================================================================="

# 1. Install cloudflared binary (supports x86_64 / amd64 and arm64)
if ! command -v cloudflared >/dev/null 2>&1; then
  echo "[1/5] Installing Cloudflare Tunnel (cloudflared)..."
  ARCH=$(dpkg --print-architecture 2>/dev/null || uname -m)
  if [[ "$ARCH" == "aarch64" || "$ARCH" == "arm64" ]]; then
    CF_DEB="cloudflared-linux-arm64.deb"
  else
    CF_DEB="cloudflared-linux-amd64.deb"
  fi
  curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/${CF_DEB}" -o /tmp/cloudflared.deb
  dpkg -i /tmp/cloudflared.deb
  rm -f /tmp/cloudflared.deb
else
  echo "[1/5] cloudflared is already installed ($(cloudflared --version))."
fi

# Option A: If user provided a Zero Trust Tunnel Token (CF_TUNNEL_TOKEN)
if [ -n "${CF_TUNNEL_TOKEN:-}" ]; then
  echo "[2/5] Installing cloudflared service using provided CF_TUNNEL_TOKEN..."
  cloudflared service uninstall 2>/dev/null || true
  cloudflared service install "${CF_TUNNEL_TOKEN}"
  systemctl daemon-reload
  systemctl enable --now cloudflared
  systemctl restart cloudflared
  echo "===================================================================="
  echo " ✅ Cloudflare Tunnel Active via Token!"
  echo " 🌐 Live URL: https://${DOMAIN}"
  echo "===================================================================="
  exit 0
fi

# Option B: CLI-Managed Named Tunnel (Login -> Create -> Route DNS -> Systemd)
if [ ! -f "$HOME/.cloudflared/cert.pem" ] && [ ! -f "/root/.cloudflared/cert.pem" ]; then
  echo "--------------------------------------------------------------------"
  echo "[2/5] ACTION REQUIRED: Authenticate Cloudflare CLI"
  echo "      Copy the URL printed below into your browser and select:"
  echo "      👉 noxverse.in"
  echo "--------------------------------------------------------------------"
  cloudflared tunnel login
else
  echo "[2/5] Cloudflare certificate already present."
fi

echo "[3/5] Creating or locating tunnel '${TUNNEL_NAME}'..."
if ! cloudflared tunnel list | awk '{print $2}' | grep -qx "${TUNNEL_NAME}"; then
  cloudflared tunnel create "${TUNNEL_NAME}"
fi

TUNNEL_UUID=$(cloudflared tunnel list | awk -v name="${TUNNEL_NAME}" '$2 == name {print $1; exit}')
if [ -z "${TUNNEL_UUID}" ]; then
  echo "❌ Error: Could not determine UUID for tunnel ${TUNNEL_NAME}."
  exit 1
fi
echo "      Tunnel UUID: ${TUNNEL_UUID}"

CRED_FILE="/root/.cloudflared/${TUNNEL_UUID}.json"
if [ ! -f "${CRED_FILE}" ] && [ -f "$HOME/.cloudflared/${TUNNEL_UUID}.json" ]; then
  CRED_FILE="$HOME/.cloudflared/${TUNNEL_UUID}.json"
fi

echo "[4/5] Routing DNS ${DOMAIN} -> Tunnel ${TUNNEL_NAME}..."
cloudflared tunnel route dns --overwrite-dns "${TUNNEL_NAME}" "${DOMAIN}"

echo "[5/5] Writing /etc/cloudflared/config.yml and starting systemd daemon..."
mkdir -p /etc/cloudflared
cat >/etc/cloudflared/config.yml <<EOF
tunnel: ${TUNNEL_UUID}
credentials-file: ${CRED_FILE}
protocol: http2

ingress:
  - hostname: ${DOMAIN}
    service: ${LOCAL_SERVICE}
    originRequest:
      noTLSVerify: true
  - service: http_status:404
EOF

cloudflared service uninstall 2>/dev/null || true
cloudflared --config /etc/cloudflared/config.yml service install
systemctl daemon-reload
systemctl enable --now cloudflared
systemctl restart cloudflared

echo "===================================================================="
echo " ✅ Cloudflare Tunnel is LIVE!"
echo " 🌐 Judge Overview:        https://${DOMAIN}/"
echo " 🚆 Live Station Console:  https://${DOMAIN}/app"
echo " ▶  1-Click Judge Demo:    https://${DOMAIN}/app?autodemo=1"
echo "===================================================================="
