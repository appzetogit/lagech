import { useEffect, useRef } from "react"
import io from "socket.io-client"
import { toast } from "sonner"
import { API_BASE_URL } from "@food/api/config"
import { socketAuth, reconnectOnAuthError } from "@food/utils/socketAuth"
import alertSound from "@food/assets/audio/alert.mp3"

/**
 * New-order alerts on every admin page.
 *
 * The Orders page has its own socket with the full alarm loop and list
 * refresh, so this stays quiet there (`onOrdersPage`) and only covers the rest
 * of the panel -- an admin sitting on the dashboard used to hear nothing.
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

    const socket = io(origin, {
      transports: ["websocket", "polling"],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      auth: socketAuth("admin"),
    })
    const stopAuthRetry = reconnectOnAuthError(socket, "admin")

    const seen = new Map()
    const onNewOrder = (payload = {}) => {
      if (onOrdersPageRef.current) return
      const orderId = String(payload.orderId || payload.orderMongoId || "")
      const now = Date.now()
      if (orderId && now - (seen.get(orderId) || 0) < 8000) return
      if (orderId) seen.set(orderId, now)

      const body = [payload.restaurantName, orderId].filter(Boolean).join(" • ") || "A new order arrived"
      toast.info("New order received", {
        description: body,
        action: { label: "View", onClick: () => { window.location.href = "/admin/food/orders/all" } },
      })
      try {
        new Audio(alertSound).play().catch(() => {})
      } catch {
        // Autoplay blocked until the admin interacts with the page.
      }
      try {
        if (typeof Notification !== "undefined" && Notification.permission === "granted") {
          new Notification("New order received", { body, tag: `admin-order-${orderId || now}` })
        }
      } catch {
        // Some browsers only allow notifications from a service worker.
      }
    }

    socket.on("admin_new_order", onNewOrder)
    return () => {
      stopAuthRetry()
      socket.off("admin_new_order", onNewOrder)
      socket.disconnect()
    }
  }, [])
}
