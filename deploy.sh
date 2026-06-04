#!/bin/bash
# Clash-Onchain Real-Time Deployment (v2 - more robust)
# Zone: us-central1-f | IP: 34.67.151.45 | Project: project-b4992925-cd2b-4baa-a09
# Run from Google Cloud Shell

# NO set -e - we want to continue even if individual steps fail

PROJECT="project-b4992925-cd2b-4baa-a09"
ZONE="us-central1-f"
INSTANCE="instance-20260603-123019"
EXTERNAL_IP="34.67.151.45"
REPO="https://github.com/dmattrenggana/clash-realtime.git"

echo "=== STEP 0: Verify VM ==="
gcloud compute instances describe "$INSTANCE" \
  --project="$PROJECT" \
  --zone="$ZONE" \
  --format='get(networkInterfaces[0].accessConfigs[0].natIP)' || { echo "FAIL: cannot describe VM"; exit 1; }
echo "Expected: $EXTERNAL_IP"

echo ""
echo "=== STEP 1: Open port 2567 ==="
gcloud compute firewall-rules create clash-realtime-ws \
  --project="$PROJECT" \
  --direction=INGRESS \
  --action=ALLOW \
  --rules=tcp:2567 \
  --source-ranges=0.0.0.0/0 \
  --target-tags=http-server \
  --description="Clash-Onchain real-time WebSocket" 2>&1 || echo "  (rule may already exist)"

echo ""
echo "=== STEP 2: SSH + deploy ==="
gcloud compute ssh "$INSTANCE" \
  --project="$PROJECT" \
  --zone="$ZONE" \
  << 'INNER_EOF'

echo "--- Stop old service (best effort) ---"
systemctl list-units --type=service 2>/dev/null | grep -q clash-colyseus && {
  sudo systemctl stop clash-colyseus 2>/dev/null
  sudo systemctl disable clash-colyseus 2>/dev/null
  sudo rm -f /etc/systemd/system/clash-colyseus.service
  sudo systemctl daemon-reload 2>/dev/null
} || echo "  no old service"
fuser -k 8080/tcp 2>/dev/null || true
sleep 1

echo "--- Remove old dir (best effort) ---"
[ -d /opt/clash-colyseus ] && sudo rm -rf /opt/clash-colyseus && echo "  removed /opt/clash-colyseus" || echo "  no old dir"

echo "--- Install Node.js 26 (skip if already >= 26) ---"
if command -v node >/dev/null 2>&1; then
  CURRENT_MAJOR=$(node --version | cut -d. -f1 | tr -d v)
  echo "  Current Node: $(node --version)"
  if [ "$CURRENT_MAJOR" -lt 26 ]; then
    echo "  Upgrading to Node 26..."
    curl -fsSL https://deb.nodesource.com/setup_26.x | sudo -E bash -
    sudo apt-get install -y nodejs
  else
    echo "  Already Node 26+, skip"
  fi
else
  echo "  Installing Node 26..."
  curl -fsSL https://deb.nodesource.com/setup_26.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
echo "  Final Node: $(node --version)"

echo "--- Install PM2 (skip if installed) ---"
if ! command -v pm2 >/dev/null 2>&1; then
  sudo npm install -g pm2 --silent
fi
echo "  PM2: $(pm2 --version)"

echo "--- Clone repo ---"
if [ ! -d /opt/clash-realtime ]; then
  sudo git clone https://github.com/dmattrenggana/clash-realtime.git /opt/clash-realtime
  sudo chown -R $USER:$USER /opt/clash-realtime
  echo "  cloned"
else
  echo "  exists, pulling..."
  cd /opt/clash-realtime && git pull
fi

echo "--- Install deps + build ---"
cd /opt/clash-realtime
npm install --legacy-peer-deps --silent 2>&1 | tail -5
npm run build 2>&1 | tail -5

echo "--- Start with PM2 ---"
pm2 delete clash-realtime 2>/dev/null || true
pm2 start ecosystem.config.cjs
pm2 save --force 2>&1 | tail -2

echo "--- Verify ---"
sleep 4
echo "  HTTP test:"
curl -s http://localhost:2567/hi
echo ""
echo "  PM2 status:"
pm2 status
INNER_EOF

echo ""
echo "=== STEP 3: Verify from Cloud Shell ==="
sleep 5
HTTP_RESULT=$(curl -s --max-time 5 "http://${EXTERNAL_IP}:2567/hi" 2>&1)
if [ -n "$HTTP_RESULT" ]; then
  echo "  HTTP test PASSED: $HTTP_RESULT"
else
  echo "  HTTP test FAILED (wait 30-60s for firewall)"
  echo "  Try: curl http://$EXTERNAL_IP:2567/hi"
fi

echo ""
echo "=== DONE ==="
echo "WebSocket: ws://${EXTERNAL_IP}:2567"
echo "HTTP:      http://${EXTERNAL_IP}:2567/hi"
echo "Room:      battle"
