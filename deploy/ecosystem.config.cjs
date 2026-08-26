const path = require('node:path')
const fs = require('node:fs')

// PM2 resolves a relative `cwd` against the directory holding this file,
// not the directory you run pm2 from -- './Backend' would resolve to
// deploy/Backend. Compute it so the config works from anywhere.
const BACKEND = path.join(__dirname, '..', 'Backend')

// The queue workers exit immediately when BullMQ is off: startWorker() returns
// null, no listener is registered, nothing holds the event loop open, and the
// process ends with status 0. PM2 reads a clean exit under `autorestart: true`
// as work finished and starts it again -- a restart loop that burns CPU and
// fills the logs while looking, in `pm2 list`, like a service that is running.
//
// So they are only included when BullMQ is actually enabled. Read from
// Backend/.env rather than process.env: pm2 is started from a shell that has
// not sourced it, and dotenv only runs once the worker itself is up.
const backendEnv = (key) => {
  try {
    const text = fs.readFileSync(path.join(BACKEND, '.env'), 'utf8')
    const match = new RegExp('^' + key + '=(.*)$', 'm').exec(text)
    return match ? match[1].trim() : ''
  } catch {
    return ''
  }
}
const QUEUES_ENABLED = backendEnv('BULLMQ_ENABLED') === 'true'

module.exports = {
  apps: [
    {
      name: 'minto-api',
      cwd: BACKEND,
      script: 'server.js',
      instances: 'max',
      exec_mode: 'cluster',
      autorestart: true,
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'production',
        PORT: 5000,
        SOCKET_PORT: 5001,
        SERVER_BACKGROUND_JOBS_ENABLED: 'false',
        SERVER_QUEUE_BOOTSTRAP_ENABLED: 'false'
      }
    },
    {
      name: 'minto-socket',
      cwd: BACKEND,
      script: 'socket-server.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '350M',
      env: {
        NODE_ENV: 'production',
        SOCKET_PORT: 5001
      }
    },
    {
      name: 'minto-scheduler',
      cwd: BACKEND,
      script: 'scripts/run-scheduled-jobs.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production'
      }
    },
  ],
}

if (QUEUES_ENABLED) {
  module.exports.apps.push(
      {
        name: 'minto-worker-order',
        cwd: BACKEND,
        script: 'src/queues/workers/order.worker.js',
        instances: 1,
        exec_mode: 'fork',
        autorestart: true,
        max_memory_restart: '350M',
        env: {
          NODE_ENV: 'production'
        }
      },
      {
        name: 'minto-worker-tracking',
        cwd: BACKEND,
        script: 'src/queues/workers/tracking.worker.js',
        instances: 1,
        exec_mode: 'fork',
        autorestart: true,
        max_memory_restart: '350M',
        env: {
          NODE_ENV: 'production'
        }
      }
  )
}
