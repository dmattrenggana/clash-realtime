// PM2 config for clash-realtime game server.
//
// Uses dotenv-flow (via app.config.ts loading .env.production) instead of
// hard-coding env in this file, so secrets don't leak into git.
//
// If you need to inject env vars at PM2 level, use `pm2 start ecosystem.config.cjs --env KEY=VAL`
// (NOT here — that would commit secrets to git).
module.exports = {
  apps: [{
    name: 'clash-realtime',
    script: './build/index.js',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '512M',
    // Hard-coded env (non-secret only)
    env: {
      NODE_ENV: 'production',
      PORT: 2567,
    },
    // PM2 reads .env.production from CWD. Secrets like SUPABASE_SERVICE_ROLE_KEY
    // and GAME_SERVER_SECRET go there, NOT in this file.
  }],
};
