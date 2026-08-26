// UAT process set — runs alongside production on the same box.
//
// Every port is production's + 100 and every process name carries a `uat-`
// prefix, so `pm2 restart uat-...` can never touch a live process. Point
// `cwd` at the UAT checkout; UAT reads its own Backend/.env (its own
// DATABASE_URL — it must never share production's database).
//
//   pm2 start deploy/ecosystem.uat.config.cjs
const path = require('node:path')

// PM2 resolves a relative `cwd` against the directory holding this file,
// not the directory you run pm2 from -- './Backend' would resolve to
// deploy/Backend. Compute it so the config works from anywhere.
const BACKEND = path.join(__dirname, '..', 'Backend')

module.exports = {
  apps: [
    {
      name: 'uat-minto-api',
      cwd: BACKEND,
      script: 'server.js',
      // Fixed at 2, not 'max': UAT shares the box and must leave production
      // its cores.
      instances: 2,
      exec_mode: 'cluster',
      autorestart: true,
      max_memory_restart: '400M',
      env: {
        NODE_ENV: 'production',
        PORT: 5100,
        SOCKET_PORT: 5101,
        SERVER_BACKGROUND_JOBS_ENABLED: 'false',
        SERVER_QUEUE_BOOTSTRAP_ENABLED: 'false'
      }
    },
    {
      name: 'uat-minto-socket',
      cwd: BACKEND,
      script: 'socket-server.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production',
        SOCKET_PORT: 5101
      }
    },
    {
      name: 'uat-minto-scheduler',
      cwd: BACKEND,
      script: 'scripts/run-scheduled-jobs.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '250M',
      env: {
        NODE_ENV: 'production'
      }
    },
    {
      name: 'uat-minto-worker-order',
      cwd: BACKEND,
      script: 'src/queues/workers/order.worker.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production'
      }
    },
    {
      name: 'uat-minto-worker-tracking',
      cwd: BACKEND,
      script: 'src/queues/workers/tracking.worker.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production'
      }
    }
  ]
};
