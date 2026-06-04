#!/bin/bash
# Diagnose: cek apa yang sebenernya terjadi di VM
PROJECT="project-b4992925-cd2b-4baa-a09"
ZONE="us-central1-f"
INSTANCE="instance-20260603-123019"

gcloud compute ssh "$INSTANCE" --project="$PROJECT" --zone="$ZONE" << 'INNER'
echo "=== 1. cek /opt/clash-realtime exists? ==="
ls -ld /opt/clash-realtime 2>&1
echo ""

echo "=== 2. cek PM2 status ==="
pm2 status 2>&1
echo ""

echo "=== 3. cek port 2567 listening? ==="
ss -tlnp 2>/dev/null | grep 2567 || echo "  (port 2567 NOT listening)"
echo ""

echo "=== 4. cek port 8080 masih ada? ==="
ss -tlnp 2>/dev/null | grep 8080 || echo "  (port 8080 free)"
echo ""

echo "=== 5. cek Node version ==="
node --version 2>&1
echo ""

echo "=== 6. cek PM2 logs (last 30 lines) ==="
pm2 logs clash-realtime --lines 30 --nostream 2>&1 | tail -40 || echo "  (no PM2 logs)"
echo ""

echo "=== 7. cek build output exists? ==="
ls -la /opt/clash-realtime/build/ 2>&1 | head -10
echo ""

echo "=== 8. try start manually to see error ==="
cd /opt/clash-realtime 2>/dev/null && timeout 5 node build/index.js 2>&1 | head -20
INNER
