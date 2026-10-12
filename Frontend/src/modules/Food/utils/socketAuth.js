import { ensureValidAccessToken } from "@food/utils/auth"

/**
 * Socket.IO `auth` option for a panel's socket.
 *
 * Access tokens live 15 minutes, and a fixed `auth: { token }` object keeps
 * sending the one from page load: after the first network blip, laptop sleep
 * or server restart past that, every reconnect is refused (AUTH_INVALID).
 * As a function it runs on every connect attempt and refreshes first.
 */
export const socketAuth = (module) => (cb) => {
  ensureValidAccessToken(module).then(
    (token) => cb({ token: token || "" }),
    () => cb({ token: "" }),
  )
}

/**
 * Reconnects after the server refuses the token.
 *
 * Socket.IO retries dropped connections on its own, but not one the server's
 * auth middleware rejected -- that socket just stays down, and alerts stop
 * with nothing on screen saying so. Backs off to a minute; stops once the
 * session itself is gone (the panel then sends the user to log in anyway).
 */
export function reconnectOnAuthError(socket, module) {
  let attempt = 0
  let timer = null
  socket.on("connect", () => { attempt = 0 })
  socket.on("connect_error", async (err) => {
    if (!/^AUTH_/.test(String(err?.message || ""))) return
    const token = await ensureValidAccessToken(module)
    if (!token || timer) return
    const delay = Math.min(60000, 2000 * 2 ** attempt++)
    timer = setTimeout(() => {
      timer = null
      if (!socket.connected) socket.connect()
    }, delay)
  })
  return () => clearTimeout(timer)
}
