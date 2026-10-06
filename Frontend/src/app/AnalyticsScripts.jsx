import { useEffect, useState } from "react"
import { useLocation } from "react-router-dom"
import apiClient from "@food/api/axios.js"

/**
 * Loads the tracking tools the admin switched on (System Settings -> Analytics
 * Script) on the customer website only: never on the admin, restaurant or
 * rider panels. The backend hands over ids that already passed a strict
 * format check; the snippets are the tools' standard loaders, built here.
 */

const PANEL_PREFIXES = ["/admin", "/food/admin", "/food/restaurant", "/food/delivery", "/delivery", "/restaurant"]
const isCustomerPage = (pathname = "") => !PANEL_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))

const SAFE_ID = /^[A-Z0-9-]{4,40}$/

function addScript(src, id) {
  if (document.getElementById(id)) return
  const script = document.createElement("script")
  script.id = id
  script.async = true
  script.src = src
  document.head.appendChild(script)
}

function loadGoogleAnalytics(id) {
  window.dataLayer = window.dataLayer || []
  window.gtag = window.gtag || function gtag() { window.dataLayer.push(arguments) }
  window.gtag("js", new Date())
  // Page views are sent on every route change below; this is a single-page app.
  window.gtag("config", id, { send_page_view: false })
  addScript(`https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(id)}`, "lagech-ga")
}

function loadTagManager(id) {
  window.dataLayer = window.dataLayer || []
  window.dataLayer.push({ "gtm.start": Date.now(), event: "gtm.js" })
  addScript(`https://www.googletagmanager.com/gtm.js?id=${encodeURIComponent(id)}`, "lagech-gtm")
}

function loadMetaPixel(id) {
  if (!window.fbq) {
    const fbq = function fbq() {
      fbq.callMethod ? fbq.callMethod.apply(fbq, arguments) : fbq.queue.push(arguments)
    }
    fbq.push = fbq
    fbq.loaded = true
    fbq.version = "2.0"
    fbq.queue = []
    window.fbq = fbq
    window._fbq = fbq
    addScript("https://connect.facebook.net/en_US/fbevents.js", "lagech-fbq")
  }
  window.fbq("init", id)
}

export default function AnalyticsScripts() {
  const { pathname, search } = useLocation()
  const customer = isCustomerPage(pathname)
  const [ids, setIds] = useState(null)

  // Fetched the first time a customer page is shown, and loaded once.
  useEffect(() => {
    if (!customer || ids) return
    let alive = true
    apiClient
      // Tracking is optional: a failed read must not show the customer an error.
      .get("/food/public/analytics", { suppressErrorToast: true })
      .then((res) => {
        if (!alive) return
        const data = res?.data?.data || {}
        const clean = Object.fromEntries(
          Object.entries(data).filter(([, id]) => SAFE_ID.test(String(id || ""))),
        )
        if (clean.googleAnalytics) loadGoogleAnalytics(clean.googleAnalytics)
        if (clean.googleTagManager) loadTagManager(clean.googleTagManager)
        if (clean.metaPixel) loadMetaPixel(clean.metaPixel)
        setIds(clean)
      })
      .catch(() => alive && setIds({}))
    return () => {
      alive = false
    }
  }, [customer, ids])

  // One page view per customer route.
  useEffect(() => {
    if (!customer || !ids) return
    if (ids.googleAnalytics && window.gtag) {
      window.gtag("event", "page_view", { page_path: `${pathname}${search}`, send_to: ids.googleAnalytics })
    }
    if (ids.googleTagManager && window.dataLayer) {
      window.dataLayer.push({ event: "page_view", page_path: `${pathname}${search}` })
    }
    if (ids.metaPixel && window.fbq) window.fbq("track", "PageView")
  }, [customer, ids, pathname, search])

  return null
}
