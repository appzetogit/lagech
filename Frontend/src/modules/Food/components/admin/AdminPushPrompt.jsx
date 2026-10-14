import { useEffect, useState } from "react"
import { registerWebPushForCurrentModule } from "@food/utils/firebaseMessaging"

/**
 * Asks the admin to turn on new-order notifications, like the old panel did.
 *
 * Mobile browsers only show the permission prompt from a tap, so the
 * automatic registration on page load cannot do it there; this bar gives the
 * tap. It hides once the browser has an answer either way.
 */
export default function AdminPushPrompt() {
  const [permission, setPermission] = useState(() => readPermission())
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    // iPhone only allows web push from a home-screen app, which needs a manifest.
    if (!document.querySelector('link[rel="manifest"]')) {
      const link = document.createElement("link")
      link.rel = "manifest"
      link.href = "/admin-manifest.webmanifest"
      document.head.appendChild(link)
    }
  }, [])

  useEffect(() => {
    // The permission can change from the browser's site settings.
    const id = setInterval(() => setPermission(readPermission()), 5000)
    return () => clearInterval(id)
  }, [])

  if (permission === "unsupported" || permission === "granted") return null

  const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent)

  if (permission === "default-ios") {
    return (
      <div className="w-full bg-teal-50 border-b border-teal-200 px-4 py-2 text-center text-xs sm:text-sm text-teal-900">
        For new-order notifications on iPhone: Share → Add to Home Screen, then open the panel from the home screen icon.
      </div>
    )
  }

  if (permission === "denied") {
    return (
      <div className="w-full bg-amber-50 border-b border-amber-200 px-4 py-2 text-center text-xs sm:text-sm text-amber-900">
        New-order notifications are blocked. Allow notifications for this site in the browser settings.
      </div>
    )
  }

  const enable = async () => {
    setBusy(true)
    try {
      await registerWebPushForCurrentModule(window.location.pathname, { force: true })
    } finally {
      setPermission(readPermission())
      setBusy(false)
    }
  }

  return (
    <div className="w-full bg-teal-50 border-b border-teal-200 px-4 py-2 flex flex-wrap items-center justify-center gap-2 text-xs sm:text-sm text-teal-900">
      <span>Turn on notifications to get an alert for every new order.</span>
      <button
        type="button"
        onClick={enable}
        disabled={busy}
        className="rounded bg-teal-700 px-3 py-1 font-medium text-white disabled:opacity-60"
      >
        {busy ? "Turning on…" : "Turn on"}
      </button>
      {isIos && (
        <span className="w-full text-center text-[11px] text-teal-800">
          On iPhone: Share → Add to Home Screen, then open the panel from the home screen icon first.
        </span>
      )}
    </div>
  )
}

function readPermission() {
  if (typeof window === "undefined" || !("Notification" in window) || !("serviceWorker" in navigator)) {
    // iPhone Safari outside a home-screen app has no Notification API.
    return /iPad|iPhone|iPod/.test(navigator?.userAgent || "") ? "default-ios" : "unsupported"
  }
  return Notification.permission
}
