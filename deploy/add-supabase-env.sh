#!/bin/bash
# JALANKAN INI DI VM SETELAH git pull & npm run build
# Goal: create /opt/clash-realtime/.env.production with secrets

set -e

ENV_FILE="/opt/clash-realtime/.env.production"

echo "=== Create .env.production with Supabase + match recording env ==="

# Get values from environment if set, otherwise prompt
if [ -z "$SUPABASE_URL" ]; then
  read -p "SUPABASE_URL [https://ktrwdkrxsttdadqvudco.supabase.co]: " INPUT_URL
  SUPABASE_URL=${INPUT_URL:-https://ktrwdkrxsttdadqvudco.supabase.co}
fi

if [ -z "$SUPABASE_SERVICE_ROLE_KEY" ]; then
  echo ""
  echo "  Get this from: Supabase Dashboard → Settings → API → service_role (secret)"
  echo "  (NEVER commit this to git!)"
  read -p "SUPABASE_SERVICE_ROLE_KEY: " SUPABASE_SERVICE_ROLE_KEY
fi

if [ -z "$GAME_SERVER_SECRET" ]; then
  # Auto-generate a strong random secret if not provided
  read -p "GAME_SERVER_SECRET [Enter = auto-generate]: " GAME_SERVER_SECRET
  if [ -z "$GAME_SERVER_SECRET" ]; then
    GAME_SERVER_SECRET=$(openssl rand -hex 32)
    echo "  Auto-generated: $GAME_SERVER_SECRET"
  fi
fi

cat > "$ENV_FILE" <<EOF
# /opt/clash-realtime/.env.production
# Generated: $(date)
# DO NOT COMMIT THIS FILE TO GIT

# Clash-Onchain Supabase project
SUPABASE_URL=$SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY=$SUPABASE_SERVICE_ROLE_KEY

# M2M secret for record-match edge function
# (must match the value configured in Supabase secrets)
GAME_SERVER_SECRET=$GAME_SERVER_SECRET

# Optional: keep anon auth disabled once agent flow is verified
ALLOW_ANON_USERS=false
EOF

# Set permissions (game server user reads it; nobody else should)
chmod 600 "$ENV_FILE"
chown clashonchain:clashonchain "$ENV_FILE" 2>/dev/null || true

echo ""
echo "=== Created $ENV_FILE (chmod 600) ==="
ls -la "$ENV_FILE"
echo ""
echo "=== NEXT STEPS ==="
echo "1. In Supabase Dashboard: Settings → Edge Functions → Secrets"
echo "   Add GAME_SERVER_SECRET = $GAME_SERVER_SECRET"
echo "2. cd /opt/clash-realtime && sudo pm2 restart clash-realtime"
echo "3. Verify in logs:"
echo "   sudo pm2 logs clash-realtime --lines 30 --nostream | grep -E 'config|Supabase'"
echo "   Should show: '[config] Loaded env from .env.production (SUPABASE_URL set)'"
