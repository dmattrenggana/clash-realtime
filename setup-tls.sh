#!/bin/bash
# Setup wss://ws.clashonchain.xyz via Caddy reverse proxy
# Run from Cloud Shell (or local with gcloud ssh)
# Prereq: DNS A record ws.clashonchain.xyz -> 34.67.151.45 ALREADY CREATED

set -e

PROJECT="project-b4992925-cd2b-4baa-a09"
ZONE="us-central1-f"
INSTANCE="instance-20260603-123019"
DOMAIN="ws.clashonchain.xyz"
VM_IP="34.67.151.45"

echo "=== STEP 0: Pre-flight: confirm DNS resolves to VM ==="
RESOLVED_IP=$(dig +short "$DOMAIN" 2>/dev/null | tail -1)
echo "DNS $DOMAIN -> $RESOLVED_IP"
if [ "$RESOLVED_IP" != "$VM_IP" ]; then
  echo "WARNING: DNS not pointing to $VM_IP yet. Let's Encrypt will FAIL until it does."
  echo "Add A record at your registrar: $DOMAIN -> $VM_IP"
  echo "Continue? (y/N)"
  read -r ans
  [ "$ans" = "y" ] || { echo "Aborted"; exit 1; }
fi

echo ""
echo "=== STEP 1: Open port 443 (HTTPS/WSS) in firewall ==="
gcloud compute firewall-rules create clash-wss \
  --project="$PROJECT" \
  --direction=INGRESS \
  --action=ALLOW \
  --rules=tcp:443 \
  --source-ranges=0.0.0.0/0 \
  --target-tags=http-server \
  --description="Clash-Onchain WSS via Caddy" \
  2>&1 || echo "  (rule may already exist)"

echo ""
echo "=== STEP 2: SSH to VM, install Caddy, configure reverse proxy ==="
gcloud compute ssh "$INSTANCE" --project="$PROJECT" --zone="$ZONE" << INNER
set -e

# Install Caddy (auto-HTTPS via Let's Encrypt)
if ! command -v caddy >/dev/null 2>&1; then
  echo "Installing Caddy..."
  sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
  sudo apt update
  sudo apt install -y caddy
fi
echo "Caddy: $(caddy version)"

# Caddyfile: reverse proxy + WebSocket + auto HTTPS
sudo tee /etc/caddy/Caddyfile > /dev/null <<CADDY
$DOMAIN {
    reverse_proxy localhost:2567 {
        header_up Host {host}
        header_up X-Real-IP {remote_host}
    }
}
CADDY

# Validate + reload
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
sudo systemctl enable caddy

# Open 443 if ufw is active
if command -v ufw >/dev/null 2>&1; then
  sudo ufw allow 443/tcp 2>/dev/null || true
fi

echo "---"
echo "Caddy listening:"
ss -tlnp 2>/dev/null | grep -E ':(80|443|2567)' || echo "  (none)"
INNER

echo ""
echo "=== STEP 3: Verify TLS + WebSocket from Cloud Shell ==="
sleep 8  # Give Caddy a moment to obtain cert
echo "Test HTTPS (Caddy auto-redirects 80->443):"
curl -sI --max-time 10 "https://$DOMAIN/hi" 2>&1 | head -5
echo ""
echo "If you see 'HTTP/2 200' above, TLS is working!"
echo ""
echo "WebSocket URL: wss://$DOMAIN"
