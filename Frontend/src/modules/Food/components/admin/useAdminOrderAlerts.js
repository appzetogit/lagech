import { useEffect, useRef } from "react"
import io from "socket.io-client"
import { toast } from "sonner"
import { API_BASE_URL } from "@food/api/config"
import { adminAPI } from "@food/api"
import { socketAuth, reconnectOnAuthError } from "@food/utils/socketAuth"
import alertSound from "@food/assets/audio/alert.mp3"

// The old panel kept ringing until someone looked; so does this, up to a limit.
const ALARM_MAX_MS = 2 * 60 * 1000
// A phone that locks with the panel open can lose its socket without noticing;
// the newest order is also checked this often, as the old panel polled.
const POLL_MS = 20 * 1000

/**
 * New-order alerts on every admin page.
 *
 * The Orders page has its own socket with the full alarm loop and list
 * refresh, so this stays quiet there (`onOrdersPage`) and only covers the rest
 * of the panel -- an admin sitting on the dashboard used to hear nothing.
 *
 * A new order rings in a loop until the admin taps the page or the alert (or
 * two minutes pass). An audio element already playing keeps playing on a
 * locked Android phone, which is how the old panel rang with the screen off.
 * The system notification itself comes from the server's FCM push.
 */
export function useAdminOrderAlerts(onOrdersPage) {
  const onOrdersPageRef = useRef(onOrdersPage)
  onOrdersPageRef.current = onOrdersPage

  useEffect(() => {
    let origin = ""
    try {
      origin = new URL(API_BASE_URL, window.location.origin).origin
    } catch {
      return undefined
    }

    let alarm = null
    let alarmTimer = null
    const stopAlarm = () => {
      if (alarmTimer) clearTimeout(alarmTimer)
      alarmTimer = null
      if (alarm) {
        alarm.pause()
        alarm.currentTime = 0
      }
    }
    const startAlarm = () => {
      try {
        if (!alarm) {
          alarm = new Audio(alertSound)
          alarm.loop = true
          alarm.preload = "auto"
        }
        alarm.volume = 1
        alarm.play().catch(() => {
          // Autoplay blocked until the admin has tapped the page once.
        })
        if (alarmTimer) clearTimeout(alarmTimer)
        alarmTimer = setTimeout(stopAlarm, ALARM_MAX_MS)
      } catch {
        // No audio support.
      }
    }
    // Any tap on the panel means someone saw it.
    const onUserTap = () => stopAlarm()
    window.addEventListener("pointerdown", onUserTap, true)

    const socket = io(origin, {
      transports: ["websocket", "polling"],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      auth: socketAuth("admin"),
    })
    const stopAuthRetry = reconnectOnAuthError(socket, "admin")

    const seen = new Map()
    const alertFor = (payload = {}) => {
      if (onOrdersPageRef.current) return
      const orderId = String(payload.orderId || payload.orderMongoId || "")
      const now = Date.now()
      if (orderId && seen.has(orderId)) return
      if (orderId) seen.set(orderId, now)

      const body = [payload.restaurantName, orderId].filter(Boolean).join(" • ") || "A new order arrived"
      toast.info("New order received", {
        description: body,
        duration: ALARM_MAX_MS,
        action: {
          label: "View",
          onClick: () => {
            stopAlarm()
            window.location.href = "/admin/food/orders/all"
          },
        },
        onDismiss: stopAlarm,
      })
      startAlarm()
    }
    socket.on("admin_new_order", alertFor)

    // Fallback: the newest order, compared with the last one seen.
    let newestId = null
    let polling = false
    const poll = async () => {
      if (polling) return
      polling = true
      try {
        const res = await adminAPI.getOrders({ limit: 1, page: 1 }, { force: true })
        const list = res?.data?.data?.orders ?? res?.data?.orders ?? []
        const latest = Array.isArray(list) ? list[0] : null
        const id = latest ? String(latest._id || latest.id || "") : ""
        if (id && newestId !== null && id !== newestId) {
          const createdAt = new Date(latest.createdAt || 0).getTime()
          // Only a genuinely new order, not one that resurfaced in the list.
          if (!createdAt || Date.now() - createdAt < 10 * 60 * 1000) {
            alertFor({
              orderId: String(latest.order_id || latest.orderId || id),
              restaurantName: latest.restaurantName || latest.restaurant?.restaurantName || "",
            })
          }
        }
        if (id) newestId = id
      } catch {
        // Offline or logged out; the next tick tries again.
      } finally {
        polling = false
      }
    }
    poll()
    const pollTimer = setInterval(poll, POLL_MS)
    // Coming back to the tab (unlocking the phone) checks straight away.
    const onVisible = () => {
      if (document.visibilityState === "visible") poll()
    }
    document.addEventListener("visibilitychange", onVisible)

    return () => {
      stopAuthRetry()
      socket.off("admin_new_order", alertFor)
      socket.disconnect()
      clearInterval(pollTimer)
      document.removeEventListener("visibilitychange", onVisible)
      window.removeEventListener("pointerdown", onUserTap, true)
      stopAlarm()
    }
  }, [])
}
