import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'

// Trailing slashes matter below, so build these as plain strings: passing
// 'services/api/' through path.resolve would normalise the slash away and
// splice '@food/api/axios' into '.../services/apiaxios'.
const SRC = path.resolve(import.meta.dirname, 'src')

// The path aliases the source has always assumed. jsconfig.json declares them
// for the editor, but the editor is not the bundler: without them here, the
// ~1700 `@food/...` imports resolve to nothing and the build fails on the first
// one it reaches.
//
// Order is load-bearing. Vite matches these in sequence, so `@food/api` has to
// come before `@food` — it is the one segment that does NOT live under
// modules/Food, and a broader `@food` rule above it would swallow the match.
export default defineConfig(({ mode }) => {
  // Where the dev server forwards /api and /uploads.
  //
  // Defaults to a backend on this machine. Point it at a deployed API when
  // there is no local one -- the browser then only ever talks to the dev
  // server, so the deployed API needs no CORS entry for localhost, which is a
  // production setting and not something a developer should have to widen to
  // run the app.
  const env = loadEnv(mode, import.meta.dirname, "")
  const apiProxyTarget = env.DEV_API_PROXY_TARGET || "http://localhost:5000"

  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: [
        { find: /^@food\/api$/,  replacement: `${SRC}/services/api` },
        { find: /^@food\/api\//, replacement: `${SRC}/services/api/` },
        { find: /^@food\//,      replacement: `${SRC}/modules/Food/` },
        { find: /^@delivery\//,  replacement: `${SRC}/modules/DeliveryV2/` },
        { find: /^@\//,          replacement: `${SRC}/` },
      ],
    },
    server: {
      // mediaUrl.js serves /uploads from the same origin in dev to avoid a
      // cross-origin-resource-policy block on the images.
      proxy: {
        '/api': { target: apiProxyTarget, changeOrigin: true },
        '/uploads': { target: apiProxyTarget, changeOrigin: true },
      },
    },
  }
})
