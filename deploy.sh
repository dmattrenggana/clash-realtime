#!/bin/bash
# Clash-Onchain Real-Time Deployment
# Zone: us-central1-f | IP: 34.67.151.45 | Project: project-b4992925-cd2b-4baa-a09
# Run from Google Cloud Shell

set -e

PROJECT="project-b4992925-cd2b-4baa-a09"
ZONE="us-central1-f"
INSTANCE="instance-20260603-123019"
EXTERNAL_IP="34.67.151.45"
REPO="https://github.com/dmattrenggana/clash-realtime.git"

echo "=== STEP 0: Verify VM IP ==="
gcloud compute instances describe "$INSTANCE" \
  --project="$PROJECT" \
  --zone="$ZONE" \
  --format='get(networkInterfaces[0].accessConfigs[0].natIP)'
echo "Expected: $EXTERNAL_IP"

echo ""
echo "=== STEP 1: Open port 2567 (Colyseus WebSocket) ==="
gcloud compute firewall-rules create clash-realtime-ws \
  --project="$PROJECT" \
  --direction=INGRESS \
  --action=ALLOW \
  --rules=tcp:2567 \
  --source-ranges=0.0.0.0/0 \
  --target-tags=http-server \
  --description="Clash-Onchain real-time WebSocket" \
  2>&1 || echo "  (rule may already exist, continuing)"

echo ""
echo "=== STEP 2: SSH + cleanup old + deploy new ==="
gcloud compute ssh "$INSTANCE" \
  --project="$PROJECT" \
  --zone="$ZONE" \
  --command="set -e

echo '--- Stop old agones-clash-colyseus service ---'
if systemctl list-units --type=service 2>/dev/null | grep -q clash-colyseus; then
  sudo systemctl stop clash-colyseus || true
  sudo systemctl disable clash-colyseus || true
  sudo rm -f /etc/systemd/system/clash-colyseus.service
  sudo systemctl daemon-reload || true
fi
fuser -k 8080/tcp 2>/dev/null || true
sleep 1

echo '--- Remove old /opt/clash-colyseus ---'
if [ -d /opt/clash-colyseus ]; then
  sudo rm -rf /opt/clash-colyseus
fi

echo '--- Install Node.js 26 ---'
if ! command -v node &> /dev/null || [[ \"\$(node --version | cut -d. -f1 | tr -d v)\" -lt 26 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_26.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
echo \"Node: \$(node --version)\"

echo '--- Install PM2 ---'
sudo npm install -g pm2 --silent

echo '--- Clone clash-realtime ---'
if [ ! -d /opt/clash-realtime ]; then
  sudo git clone $REPO /opt/clash-realtime
  sudo chown -R \$USER:\$USER /opt/clash-realtime
fi
cd /opt/clash-realtime
git pull

echo '--- Install deps + build ---'
npm install --legacy-peer-deps --silent
npm run build

echo '--- Start with PM2 ---'
pm2 delete clash-realtime 2>/dev/null || true
pm2 start ecosystem.config.cjs
pm2 save 2>&1 | tail -2
pm2 startup 2>&1 | tail -3 || echo '(skip startup)'

echo '--- Verify from inside VM ---'
sleep 4
echo 'HTTP test (port 2567):'
curl -s http://localhost:2567/hi
echo ''
echo 'PM2 status:'
pm2 status
"

echo ""
echo "=== STEP 3: Verify from Cloud Shell (external IP) ==="
sleep 3
HTTP_RESULT=$(curl -s --max-time 5 "http://${EXTERNAL_IP}:2567/hi" 2>&1)
if [ -n "$HTTP_RESULT" ]; then
  echo "HTTP test: $HTTP_RESULT"
  echo "  Passed"
else
  echo "  HTTP test failed (firewall may need 30-60s to propagate)"
fi

echo ""
echo "=== Deployment complete! ==="
echo "WebSocket URL: ws://${EXTERNAL_IP}:2567"
echo "HTTP test:     http://${EXTERNAL_IP}:2567/hi"
echo "Room name:     battle"
