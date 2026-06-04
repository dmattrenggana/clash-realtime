module.exports = {
  apps: [{
    name: 'clash-realtime',
    script: './build/index.js',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '512M',
    env: {
      NODE_ENV: 'production',
      PORT: 2567,
    },
  }],
};
