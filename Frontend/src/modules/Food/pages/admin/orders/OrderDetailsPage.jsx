import { useCallback, useEffect, useRef, useState } from "react"
import { Link, useNavigate, useParams } from "react-router-dom"
import { Loader } from "@googlemaps/js-api-loader"
import { toast } from "sonner"
import {
  ChevronLeft,
  ChevronRight,
  Image as ImageIcon,
  Loader2,
  Mail,
  MapPin,
  Package,
  Phone,
  Pencil,
  Printer,
  ShoppingBasket,
  Store,
  User,
} from "@food/components/admin/theme/icons"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@food/components/ui/dialog"
import { adminAPI } from "@food/api"
import { getGoogleMapsApiKey } from "@food/utils/googleMapsApiKey"
import { printOrderInvoice } from "@food/utils/printInvoice"
import CancelOrderDialog from "@food/components/admin/orders/CancelOrderDialog"
import OfflinePaymentPanel from "@food/components/admin/orders/OfflinePaymentPanel"
import EditOrderItemsDialog from "@food/components/admin/orders/EditOrderItemsDialog"
import {
  EditDeliveryInfoDialog,
  EditOrderNoteDialog,
  PaymentStatusDialog,
  RescheduleOrderDialog,
  formatTime12,
} from "@food/components/admin/orders/EditOrderInfoDialogs"
import bikeLogo from "@food/assets/bikelogo.png"

/**
 * Admin Order Details, as the old panel's /admin/order/details/{id}: the order
 * with its items and bill on the left; Order Setup (status), Deliveryman, Last
 * location, Customer, Delivery Info and Store cards on the right. One column
 * on phones.
 */

const TERMINAL = ["delivered", "cancelled_by_user", "cancelled_by_restaurant", "cancelled_by_admin"]

/** Backend status -> the old panel's order step. */
function stepOf(status) {
  const s = String(status || "").toLowerCase()
  if (s === "pending_payment") return "pending_payment"
  if (!s || s === "created") return "pending"
  if (s === "confirmed") return "confirmed"
  if (s === "preparing") return "processing"
  if (s === "ready_for_pickup" || s === "reached_pickup") return "handover"
  if (s === "picked_up" || s === "reached_drop") return "picked_up"
  if (s === "delivered") return "delivered"
  if (s.startsWith("cancelled")) return "canceled"
  return s
}

const STEPS = [
  { value: "pending", label: "Pending", badge: "bg-blue-50 text-blue-600 border-blue-200" },
  { value: "confirmed", label: "Confirmed", badge: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  { value: "processing", label: "Processing", badge: "bg-amber-50 text-amber-600 border-amber-200" },
  { value: "handover", label: "Ready For Delivery", badge: "bg-amber-50 text-amber-600 border-amber-200" },
  { value: "picked_up", label: "Food On The Way", badge: "bg-yellow-50 text-yellow-700 border-yellow-200" },
  { value: "delivered", label: "Delivered", badge: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  { value: "canceled", label: "Canceled", badge: "bg-rose-50 text-rose-600 border-rose-200" },
]
const PENDING_PAYMENT = { value: "pending_payment", label: "Pending Payment", badge: "bg-slate-100 text-slate-600 border-slate-200" }
const stepInfo = (value) => STEPS.find((s) => s.value === value) || (value === "pending_payment" ? PENDING_PAYMENT : { value, label: value, badge: "bg-slate-100 text-slate-600 border-slate-200" })

/** "₹ 80" / "₹ 12.50", as the old panel and the receipt print it. */
const rupee = (value) => {
  const v = Math.round((Number(value) || 0) * 100) / 100
  return `₹ ${Number.isInteger(v) ? v : v.toFixed(2)}`
}

/** "14 Oct 2026, 03:50 PM" */
const formatPlaced = formatTime12

/** On/off switch, the admin panel's usual one. */
function Switch({ checked, onChange, disabled, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onChange}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${checked ? "bg-emerald-600" : "bg-slate-300"}`}
    >
      <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${checked ? "translate-x-4" : "translate-x-0.5"}`} />
    </button>
  )
}

/** Small "Edit"/"Change" link-button next to a value. */
function EditLink({ onClick, children = "Edit", title }) {
  return (
    <button type="button" onClick={onClick} title={title} className="inline-flex items-center gap-1 rounded border border-blue-200 bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-600 hover:bg-blue-100">
      <Pencil className="w-3 h-3" /> {children}
    </button>
  )
}

const formatAddress = (a) => {
  if (!a) return ""
  return [a.street, a.additionalDetails, a.city, a.state, a.zipCode]
    .map((v) => String(v || "").trim())
    .filter(Boolean)
    .join(", ")
}

/** [lng, lat] GeoJSON point -> { lat, lng }. */
const fromGeo = (point) => {
  const c = point?.coordinates
  if (!Array.isArray(c) || c.length < 2) return null
  const [lng, lat] = c.map(Number)
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null
}

const mapsLink = ({ lat, lng }) => `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`

/** The payment's own reference, when the order carries one: what the customer typed for an offline payment, or Razorpay's id. */
function referenceOf(order) {
  const fields = Array.isArray(order?.offlinePayment?.fields) ? order.offlinePayment.fields : []
  const ref = fields.find((f) => /ref|transaction|txn|utr/i.test(`${f.key} ${f.label}`))
  if (ref?.value) return { label: "Customer ref", value: String(ref.value) }
  const paymentId = order?.payment?.razorpay?.paymentId
  return paymentId ? { label: "Razorpay", value: String(paymentId) } : null
}

/** Order Details "Reference Code": the admin's own payment reference for the order. */
function ReferenceCodeDialog({ orderId, displayId, current, onClose, onSaved }) {
  const [value, setValue] = useState(current || "")
  const [saving, setSaving] = useState(false)

  const submit = async (code) => {
    setSaving(true)
    try {
      const res = await adminAPI.setOrderReferenceCode(orderId, code)
      const saved = res?.data?.data?.referenceCode ?? null
      toast.success(saved ? "Reference code saved" : "Reference code removed")
      onSaved(saved)
    } catch (err) {
      toast.error(err?.response?.data?.message || "Could not save the reference code")
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !saving && onClose()}>
      <DialogContent className="max-w-md w-[calc(100vw-32px)] bg-white">
        <DialogHeader>
          <DialogTitle>Reference code</DialogTitle>
          <DialogDescription>Order #{displayId}. For example the UPI or bank transaction reference of the payment.</DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (!saving) submit(value.trim())
          }}
          className="space-y-3"
        >
          <input
            autoFocus
            value={value}
            maxLength={100}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Reference code"
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
            {current ? (
              <button type="button" disabled={saving} onClick={() => submit("")} className="rounded-lg border border-rose-200 px-4 py-2 text-sm text-rose-600 disabled:opacity-50">Remove</button>
            ) : <span />}
            <div className="flex flex-col-reverse gap-2 sm:flex-row">
              <button type="button" onClick={onClose} disabled={saving} className="rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-700">Cancel</button>
              <button type="submit" disabled={saving || !value.trim() || value.trim() === (current || "")} className="inline-flex items-center justify-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
                {saving && <Loader2 className="w-4 h-4 animate-spin" />}
                Save
              </button>
            </div>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function Avatar({ src, alt, rounded = "rounded-full" }) {
  const [broken, setBroken] = useState(false)
  if (!src || broken) {
    return (
      <span className={`flex h-16 w-16 shrink-0 items-center justify-center ${rounded} bg-emerald-50 text-emerald-300`}>
        <ImageIcon className="w-6 h-6" />
      </span>
    )
  }
  return <img src={src} alt={alt} onError={() => setBroken(true)} className={`h-16 w-16 shrink-0 object-cover ${rounded} border border-slate-200`} />
}

function Card({ title, icon: Icon, action, children }) {
  return (
    <div className="rounded-xl bg-white border border-slate-200 shadow-sm p-4 sm:p-5">
      {title && (
        <div className="mb-3 flex items-center justify-between gap-2">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
            {Icon && <Icon className="w-4 h-4" />}
            {title}
          </h3>
          {action}
        </div>
      )}
      {children}
    </div>
  )
}

function ContactLines({ phone, email }) {
  return (
    <>
      {phone && (
        <a href={`tel:${phone}`} className="flex items-center gap-2 text-xs text-slate-600 hover:text-blue-600 break-all">
          <Phone className="w-3.5 h-3.5 shrink-0" /> {phone}
        </a>
      )}
      {email && (
        <a href={`mailto:${email}`} className="flex items-center gap-2 text-xs text-slate-600 hover:text-blue-600 break-all">
          <Mail className="w-3.5 h-3.5 shrink-0" /> {email}
        </a>
      )}
    </>
  )
}

/** Restaurant, customer drop and the rider's last position on one Google map. */
function LocationsMap({ points }) {
  const mapRef = useRef(null)
  const [state, setState] = useState("loading")

  useEffect(() => {
    let cancelled = false
    const draw = (google) => {
      if (cancelled || !mapRef.current) return
      const map = new google.maps.Map(mapRef.current, {
        center: points[0]?.position || { lat: 20.5937, lng: 78.9629 },
        zoom: 14,
        mapTypeControl: false,
        streetViewControl: false,
      })
      const bounds = new google.maps.LatLngBounds()
      points.forEach((p) => {
        const marker = new google.maps.Marker({
          position: p.position,
          map,
          title: p.label,
          ...(p.icon
            ? { icon: { url: p.icon, scaledSize: new google.maps.Size(40, 40), anchor: new google.maps.Point(20, 20) } }
            : { label: { text: p.letter, color: "#fff", fontWeight: "600" } }),
        })
        const info = new google.maps.InfoWindow({ content: `<div style="font-size:13px;font-weight:600">${p.label}</div>` })
        marker.addListener("click", () => info.open({ map, anchor: marker }))
        bounds.extend(p.position)
      })
      if (points.length > 1) map.fitBounds(bounds, 48)
      setState("ready")
    }
    ;(async () => {
      try {
        if (window.google?.maps) return draw(window.google)
        const apiKey = await getGoogleMapsApiKey()
        if (!apiKey) {
          if (!cancelled) setState("nokey")
          return
        }
        // Same options as the other admin maps; the loader refuses a second set.
        const google = await new Loader({ apiKey, version: "weekly", libraries: ["places", "drawing", "geometry"] }).load()
        draw(google)
      } catch {
        if (!cancelled) setState("error")
      }
    })()
    return () => {
      cancelled = true
    }
    // Drawn once per opening: the parent rebuilds `points` on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="relative h-[60vh] max-h-[480px] min-h-[280px] w-full overflow-hidden rounded-lg bg-slate-100">
      <div ref={mapRef} className="absolute inset-0" />
      {state !== "ready" && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-slate-500">
          {state === "loading" ? <Loader2 className="w-6 h-6 animate-spin" /> : state === "nokey" ? "Google Maps is not configured." : "The map could not be loaded."}
        </div>
      )}
    </div>
  )
}

/** Choose an online rider for the order (the Dispatch board's rider list). */
function AssignRiderDialog({ order, onClose, onAssigned }) {
  const [riders, setRiders] = useState(null)
  const [riderId, setRiderId] = useState("")
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    adminAPI
      .getDispatchBoard()
      .then((res) => setRiders(res?.data?.data?.riders || []))
      .catch(() => setRiders([]))
  }, [])

  const submit = async () => {
    if (!riderId) return
    setSaving(true)
    try {
      await adminAPI.assignRider(order._id || order.id, riderId)
      toast.success("Order offered to the rider")
      onAssigned()
    } catch (err) {
      toast.error(err?.response?.data?.message || "Failed to assign the rider")
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md bg-white">
        <DialogHeader>
          <DialogTitle>Assign deliveryman</DialogTitle>
          <DialogDescription>Order #{order.orderId}. Riders online now.</DialogDescription>
        </DialogHeader>
        {riders === null ? (
          <div className="py-6 text-center"><Loader2 className="w-5 h-5 animate-spin inline" /></div>
        ) : riders.length === 0 ? (
          <p className="py-4 text-sm text-slate-500">No rider is online right now.</p>
        ) : (
          <div className="max-h-[50vh] space-y-2 overflow-y-auto">
            {riders.map((r) => (
              <label key={r.id} className={`flex cursor-pointer items-center justify-between gap-3 rounded-lg border p-3 text-sm ${riderId === r.id ? "border-blue-500 bg-blue-50" : "border-slate-200"}`}>
                <span className="flex items-center gap-2 min-w-0">
                  <input type="radio" name="rider" checked={riderId === r.id} onChange={() => setRiderId(r.id)} />
                  <span className="truncate font-medium text-slate-900">{r.name}</span>
                </span>
                <span className={`shrink-0 text-xs ${r.cashSuspended ? "text-rose-600" : r.activeOrders ? "text-amber-700" : "text-emerald-700"}`}>
                  {r.cashSuspended ? "over cash limit" : r.activeOrders ? `${r.activeOrders} on trip` : "free"}
                </span>
              </label>
            ))}
          </div>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-700">Cancel</button>
          <button type="button" disabled={!riderId || saving} onClick={submit} className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : "Assign"}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export default function OrderDetailsPage() {
  const { orderId } = useParams()
  const navigate = useNavigate()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const [printing, setPrinting] = useState(false)
  const [mapOpen, setMapOpen] = useState(false)
  const [assignOpen, setAssignOpen] = useState(false)
  const [cancelOpen, setCancelOpen] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const [refOpen, setRefOpen] = useState(false)
  const [deliveryOpen, setDeliveryOpen] = useState(false)
  const [noteOpen, setNoteOpen] = useState(false)
  const [scheduleOpen, setScheduleOpen] = useState(false)
  // null, or the payment status being switched to (true = paid).
  const [paymentTo, setPaymentTo] = useState(null)
  const [cutleryBusy, setCutleryBusy] = useState(false)

  const load = useCallback(
    async (quiet = false) => {
      if (!quiet) setLoading(true)
      try {
        const res = await adminAPI.getOrderDetails(orderId)
        setData(res?.data?.data || null)
        setError("")
      } catch (err) {
        setError(err?.response?.data?.message || "Could not load the order")
      } finally {
        setLoading(false)
      }
    },
    [orderId],
  )

  useEffect(() => {
    load()
  }, [load])

  if (loading && !data) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Loader2 className="w-7 h-7 animate-spin text-blue-600" />
      </div>
    )
  }
  if (!data?.order) {
    return (
      <div className="p-4 lg:p-6">
        <div className="rounded-xl bg-white border border-slate-200 p-8 text-center">
          <p className="text-sm text-slate-600">{error || "Order not found"}</p>
          <button type="button" onClick={() => navigate(-1)} className="mt-4 rounded-lg border border-slate-300 px-4 py-2 text-sm">Back</button>
        </div>
      </div>
    )
  }

  const { order, details = {}, bill = {} } = data
  const id = order._id || order.id
  const status = String(order.orderStatus || order.status || "").toLowerCase()
  const step = stepOf(status)
  const stepMeta = stepInfo(step)
  const isTerminal = TERMINAL.includes(status)
  const isTakeaway = order.orderType === "takeaway"
  const dispatchAccepted = order.dispatch?.status === "accepted"

  // The same moves the order list allows: Accept a pending order, mark
  // delivered or cancel an open one. The rest is the restaurant's and rider's.
  const allowed = {
    confirmed: step === "pending",
    delivered: !isTerminal && step !== "pending_payment",
    canceled: !isTerminal && step !== "pending_payment",
  }
  const canAssign = !isTakeaway && !isTerminal && step !== "pending_payment" && !dispatchAccepted
  const canDeassign =
    dispatchAccepted &&
    ["confirmed", "preparing", "ready_for_pickup", "reached_pickup"].includes(status) &&
    !order.deliveryState?.pickedUpAt

  const items = Array.isArray(bill.items) ? bill.items : []
  const lines = Array.isArray(bill.lines) ? bill.lines : []
  const payment = bill.payment || {}
  const paymentRef = referenceOf(order)
  const referenceCode = details.referenceCode ?? order.referenceCode ?? null
  const address = order.deliveryAddress || {}
  const dropPoint = fromGeo(address.location)
  const restaurant = details.restaurant
  const customer = details.customer
  const rider = details.deliveryPartner
  const lastLocation = details.lastLocation
  // What else may change on the order (the server decides): delivery info,
  // note, cutlery, schedule, payment status.
  const infoEdit = details.infoEdit || {}
  const can = (key) => Boolean(infoEdit[key]?.editable)
  const payEdit = infoEdit.payment || {}
  const isPaid = payment.statusLabel === "Paid"

  /** An edit's response carries the fresh details payload; otherwise reload. */
  const applyPayload = (payload) => {
    if (payload?.order) setData({ order: payload.order, details: payload.details, bill: payload.bill })
    else load(true)
  }

  const toggleCutlery = async () => {
    if (cutleryBusy) return
    setCutleryBusy(true)
    try {
      const res = await adminAPI.setOrderCutlery(id, !order.sendCutlery)
      toast.success(order.sendCutlery ? "No cutlery for this order" : "Cutlery will be sent")
      applyPayload(res?.data?.data)
    } catch (err) {
      toast.error(err?.response?.data?.message || "Could not change the cutlery")
    } finally {
      setCutleryBusy(false)
    }
  }

  const mapPoints = [
    restaurant?.location && { position: restaurant.location, label: restaurant.name || "Restaurant", letter: "R" },
    !isTakeaway && dropPoint && { position: dropPoint, label: "Customer drop", letter: "C" },
    lastLocation && { position: { lat: lastLocation.lat, lng: lastLocation.lng }, label: rider?.name || "Deliveryman", icon: bikeLogo },
  ].filter(Boolean)

  const changeStatus = async (next) => {
    if (next === step || busy) return
    if (next === "canceled") {
      setCancelOpen(true)
      return
    }
    try {
      setBusy(true)
      if (next === "confirmed") {
        await adminAPI.acceptOrder(id)
        toast.success(`Order ${order.orderId} accepted`)
      } else if (next === "delivered") {
        if (!window.confirm(`Mark order ${order.orderId} as delivered? This will complete the order at its current stage.`)) return
        await adminAPI.markOrderDelivered(id)
        toast.success(`Order ${order.orderId} marked as delivered`)
      }
      await load(true)
    } catch (err) {
      toast.error(err?.response?.data?.message || "Failed to update the order")
    } finally {
      setBusy(false)
    }
  }

  const confirmCancel = async (reason) => {
    try {
      const res = await adminAPI.rejectOrder(id, reason)
      if (res?.data?.success === false) throw new Error(res.data.message)
      toast.success(`Order ${order.orderId} ${step === "pending" ? "rejected" : "cancelled"}`)
      setCancelOpen(false)
      await load(true)
    } catch (err) {
      toast.error(err?.response?.data?.message || err?.message || "Failed to cancel the order")
    }
  }

  const deassign = async () => {
    if (!window.confirm(`Take order ${order.orderId} off ${rider?.name || "the deliveryman"} and offer it to other riders?`)) return
    try {
      setBusy(true)
      await adminAPI.deassignAndResendOrder(id)
      toast.success("Deliveryman removed; the order is offered again")
      await load(true)
    } catch (err) {
      toast.error(err?.response?.data?.message || "Failed to change the deliveryman")
    } finally {
      setBusy(false)
    }
  }

  const print = async () => {
    if (printing) return
    setPrinting(true)
    try {
      await printOrderInvoice((params) => adminAPI.getOrderInvoice(id, params), { size: "thermal" })
    } catch {
      toast.error("Could not load the invoice")
    } finally {
      setPrinting(false)
    }
  }

  const goTo = (ref) => ref && navigate(`/admin/food/orders/details/${ref.id}`)
  const metaRow = (label, value) => (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm sm:justify-end">
      <span className="text-slate-600">{label} :</span>
      {value}
    </div>
  )

  return (
    <div className="p-4 lg:p-6 bg-slate-50 min-h-screen overflow-x-hidden">
      <div className="max-w-7xl mx-auto space-y-4">
        {/* Header */}
        <div className="space-y-3">
          <h1 className="flex items-center gap-2 text-xl font-bold text-slate-900">
            <ShoppingBasket className="w-6 h-6" />
            Order Details
            <span className="rounded bg-slate-200 px-2 py-0.5 text-xs font-semibold text-slate-700">{items.length}</span>
          </h1>
          <div className="flex items-center gap-2">
            <button
              type="button"
              title="Previous order"
              disabled={!details.previousOrder}
              onClick={() => goTo(details.previousOrder)}
              className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-200 text-slate-700 disabled:opacity-40"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <button
              type="button"
              title="Next order"
              disabled={!details.nextOrder}
              onClick={() => goTo(details.nextOrder)}
              className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-200 text-slate-700 disabled:opacity-40"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          {/* Left: the order */}
          <div className="min-w-0 space-y-4 lg:col-span-2">
            <div className="rounded-xl bg-white border border-slate-200 shadow-sm p-4 sm:p-5">
              <div className="flex flex-col gap-4 sm:flex-row sm:justify-between">
                <div className="min-w-0 space-y-2">
                  <div className="flex items-start justify-between gap-3">
                    <h2 className="text-lg font-semibold text-slate-900 break-all">Order #{order.orderId}</h2>
                    <button
                      type="button"
                      onClick={print}
                      disabled={printing}
                      title="Print invoice"
                      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-slate-900 text-white sm:hidden disabled:opacity-60"
                    >
                      {printing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Printer className="w-4 h-4" />}
                    </button>
                  </div>
                  <p className="text-xs text-slate-600">{formatPlaced(order.createdAt)}</p>
                  <p className="flex items-center gap-2 text-xs text-slate-600">
                    <Store className="w-4 h-4 text-slate-800" />
                    <span className="font-semibold text-slate-800">Store :</span>
                    {restaurant ? (
                      <Link to={`/admin/food/restaurants/view/${restaurant.id}`} className="hover:text-blue-600 truncate">{restaurant.name}</Link>
                    ) : "—"}
                  </p>
                  {mapPoints.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setMapOpen(true)}
                      className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800"
                    >
                      <MapPin className="w-3.5 h-3.5" /> Show Locations On Map
                    </button>
                  )}
                </div>

                <div className="space-y-2 sm:text-right">
                  <div className="hidden justify-end sm:flex">
                    <button
                      type="button"
                      onClick={print}
                      disabled={printing}
                      className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-60"
                    >
                      {printing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Printer className="w-4 h-4" />}
                      Print Invoice
                    </button>
                  </div>
                  {metaRow("Status", <span className={`rounded border px-2 py-0.5 text-xs font-medium ${stepMeta.badge}`}>{stepMeta.label}</span>)}
                  {metaRow("Payment Method", <span className="text-slate-800">{payment.methodLabel || "—"}</span>)}
                  {metaRow(
                    "Reference Code",
                    <span className="inline-flex flex-wrap items-center gap-2">
                      {referenceCode && <span className="text-slate-800 break-all">{referenceCode}</span>}
                      <button type="button" onClick={() => setRefOpen(true)} className="rounded border border-blue-200 bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-600 hover:bg-blue-100">
                        {referenceCode ? "Edit" : "Add"}
                      </button>
                    </span>,
                  )}
                  {paymentRef && paymentRef.value !== referenceCode &&
                    metaRow(paymentRef.label, <span className="text-xs text-slate-700 break-all">{paymentRef.value}</span>)}
                  {metaRow("Order Type", <span className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-700">{isTakeaway ? "Takeaway" : "Delivery"}</span>)}
                  {metaRow(
                    "Payment Status",
                    <span className="inline-flex items-center gap-2">
                      <span className={`font-semibold ${isPaid ? "text-emerald-600" : payment.statusLabel === "Refunded" ? "text-sky-600" : "text-rose-600"}`}>
                        {payment.statusLabel || "Unpaid"}
                      </span>
                      {/* 6amMart's paid/unpaid switch, for cash orders only */}
                      {payEdit.applies && (
                        <Switch
                          checked={Boolean(payEdit.paid)}
                          disabled={payEdit.paid ? !payEdit.canMarkUnpaid : !payEdit.canMarkPaid}
                          label={payEdit.paid ? "Mark as unpaid" : "Mark as paid"}
                          onChange={() => setPaymentTo(!payEdit.paid)}
                        />
                      )}
                    </span>,
                  )}
                  {payEdit.applies && payEdit.reason && (
                    <p className="text-[11px] leading-snug text-slate-500 sm:ml-auto sm:max-w-xs">{payEdit.reason}</p>
                  )}
                  {payEdit.markedPaidByAdmin && (
                    <p className="text-[11px] leading-snug text-emerald-700 sm:ml-auto sm:max-w-xs">Marked paid by the admin: the rider does not collect cash for it.</p>
                  )}
                  {metaRow(
                    "Cutlery",
                    <span className="inline-flex items-center gap-2">
                      <span className={`rounded border px-2 py-0.5 text-xs ${order.sendCutlery ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-rose-200 bg-rose-50 text-rose-600"}`}>
                        {order.sendCutlery ? "Yes" : "No"}
                      </span>
                      {can("cutlery") && (
                        <Switch checked={Boolean(order.sendCutlery)} disabled={cutleryBusy} label={order.sendCutlery ? "Do not send cutlery" : "Send cutlery"} onChange={toggleCutlery} />
                      )}
                    </span>,
                  )}
                  {order.isScheduled && order.scheduledAt && metaRow(
                    "Scheduled At",
                    <span className="inline-flex flex-wrap items-center gap-2">
                      <span className="text-slate-800">{formatPlaced(order.scheduledAt)}</span>
                      {can("schedule") && <EditLink onClick={() => setScheduleOpen(true)}>Change</EditLink>}
                    </span>,
                  )}
                  {order.cancellationReason && metaRow("Cancel Reason", <span className="text-rose-600">{order.cancellationReason}</span>)}
                </div>
              </div>

              {(order.note || order.deliveryInstructions || can("note")) && (
                <div className="mt-4 flex items-start justify-between gap-3 rounded-lg bg-slate-50 p-3 text-sm text-slate-700">
                  <div className="min-w-0 break-words">
                    {order.note && <p><span className="font-semibold">Order Note :</span> {order.note}</p>}
                    {order.deliveryInstructions && <p className="mt-1"><span className="font-semibold">Delivery Instructions :</span> {order.deliveryInstructions}</p>}
                    {!order.note && !order.deliveryInstructions && <p className="text-slate-500">No order note.</p>}
                  </div>
                  {can("note") && (
                    <EditLink onClick={() => setNoteOpen(true)}>{order.note || order.deliveryInstructions ? "Edit" : "Add"}</EditLink>
                  )}
                </div>
              )}

              {order.offlinePayment && (
                <div className="mt-4">
                  <OfflinePaymentPanel
                    orderId={id}
                    offlinePayment={order.offlinePayment}
                    awaiting={status === "pending_payment"}
                    onChanged={() => load(true)}
                  />
                </div>
              )}

              {/* Items header; "Edit" while the order can still change (the server decides) */}
              <div className="mt-5 flex flex-wrap items-center justify-between gap-2">
                <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                  <Package className="w-4 h-4" /> Order Items
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-semibold text-slate-600">{items.length}</span>
                </h3>
                {details.editable ? (
                  <button
                    type="button"
                    onClick={() => setEditOpen(true)}
                    className="inline-flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-1.5 text-xs font-semibold text-blue-700 hover:bg-blue-100"
                  >
                    <Pencil className="w-3.5 h-3.5" /> Edit items
                  </button>
                ) : details.editReason ? (
                  <span className="text-[11px] text-slate-500">{details.editReason}</span>
                ) : null}
              </div>
              <div className="mt-3 -mx-4 overflow-x-auto sm:-mx-5">
                <table className="w-full min-w-[480px] text-sm">
                  <thead>
                    <tr className="border-y border-slate-200 bg-slate-50 text-left">
                      <th className="px-4 py-3 w-10">#</th>
                      <th className="px-2 py-3">Item Details</th>
                      <th className="px-2 py-3">Addons</th>
                      <th className="px-4 py-3 text-right">Price</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {items.map((item, index) => {
                      const image = order.items?.[index]?.image
                      return (
                        <tr key={index} className="align-middle">
                          <td className="px-4 py-3 text-slate-600">{item.sl || index + 1}</td>
                          <td className="px-2 py-3">
                            <div className="flex items-center gap-3">
                              {image ? (
                                <img src={image} alt="" className="h-14 w-14 shrink-0 rounded-lg object-cover border border-slate-200" />
                              ) : (
                                <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-300"><Package className="w-5 h-5" /></span>
                              )}
                              <div className="min-w-0">
                                <p className="font-medium text-slate-900 line-clamp-2">{item.name}</p>
                                <p className="text-xs text-slate-500">{item.quantity} x {rupee(item.basePrice)}</p>
                                {item.variantName && <p className="text-xs text-slate-500">Variation : {item.variantName}</p>}
                                {item.notes && <p className="text-xs text-slate-400">{item.notes}</p>}
                              </div>
                            </div>
                          </td>
                          <td className="px-2 py-3 text-xs text-slate-600">
                            {item.addons?.length
                              ? item.addons.map((a, i) => <p key={i}>{a.name} ({item.quantity} x {rupee(a.price)})</p>)
                              : null}
                          </td>
                          <td className="px-4 py-3 text-right font-medium text-slate-900 whitespace-nowrap">{rupee(item.basePrice * item.quantity)}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>

              {/* Totals, the receipt's lines */}
              <div className="mt-4 ml-auto max-w-sm space-y-2 text-sm">
                {lines.map((line) => (
                  <div key={line.key} className={`flex justify-between gap-4 ${line.key === "subtotal" ? "border-t border-slate-200 pt-3 mt-3" : ""}`}>
                    <span className="text-slate-600">{line.label} :</span>
                    <span className="text-slate-900 whitespace-nowrap">
                      {line.display || `${line.info ? "" : line.sign === "-" ? "- " : line.sign === "+" ? "+ " : ""}${rupee(Math.abs(line.amount))}`}
                    </span>
                  </div>
                ))}
                <div className="flex justify-between gap-4 border-t border-slate-200 pt-3 text-base font-semibold text-slate-900">
                  <span>Total :</span>
                  <span>{rupee(bill.total ?? order.pricing?.total)}</span>
                </div>
                {payment.split?.map((s) => (
                  <div key={s.key} className="flex justify-between gap-4 text-xs text-slate-500">
                    <span>{s.label}</span>
                    <span>{rupee(s.amount)}</span>
                  </div>
                ))}
                {payment.refund && (
                  <div className="flex justify-between gap-4 text-xs text-sky-700">
                    <span>Refund ({String(payment.refund.status || "").replace(/_/g, " ")})</span>
                    <span>{rupee(payment.refund.amount)}</span>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Right: setup and people */}
          <div className="min-w-0 space-y-4">
            <Card title="Order Setup" icon={Package}>
              <div className="relative">
                <select
                  value={step}
                  disabled={busy || isTerminal}
                  onChange={(e) => changeStatus(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-800 disabled:bg-slate-50"
                  aria-label="Order status"
                >
                  {step === "pending_payment" && <option value="pending_payment">{PENDING_PAYMENT.label}</option>}
                  {STEPS.map((s) => (
                    <option key={s.value} value={s.value} disabled={s.value !== step && !allowed[s.value]}>
                      {s.label}
                    </option>
                  ))}
                </select>
                {busy && <Loader2 className="absolute right-8 top-3 w-4 h-4 animate-spin text-slate-400" />}
              </div>
              {!isTerminal && (
                <p className="mt-2 text-[11px] text-slate-500">Processing, ready and on-the-way steps are set by the restaurant and the deliveryman.</p>
              )}
            </Card>

            {!isTakeaway && (
              <Card
                title="Deliveryman"
                icon={User}
                action={
                  rider && canAssign ? (
                    <button type="button" onClick={() => setAssignOpen(true)} className="text-sm font-medium text-blue-600 hover:underline">Change</button>
                  ) : rider && canDeassign ? (
                    <button type="button" disabled={busy} onClick={deassign} className="text-sm font-medium text-blue-600 hover:underline disabled:opacity-50">Change</button>
                  ) : null
                }
              >
                {rider ? (
                  <>
                    <div className="flex items-center gap-3 rounded-lg bg-slate-50 p-3">
                      <Avatar src={rider.image} alt={rider.name} />
                      <div className="min-w-0 space-y-1">
                        <p className="text-sm font-medium text-slate-800 break-words">{rider.name}</p>
                        <p className="flex items-center gap-2 text-xs text-slate-600">
                          <ShoppingBasket className="w-3.5 h-3.5" /> {rider.deliveredCount} Orders delivered
                        </p>
                        <ContactLines phone={rider.phone} email={rider.email} />
                        {!dispatchAccepted && <p className="text-[11px] text-amber-700">Offered; not accepted yet</p>}
                      </div>
                    </div>
                    <div className="mt-4">
                      <p className="mb-1 text-sm font-semibold text-slate-900">Last location</p>
                      {lastLocation ? (
                        <a href={mapsLink(lastLocation)} target="_blank" rel="noopener noreferrer" className="flex items-start gap-2 text-sm text-blue-600 hover:underline">
                          <MapPin className="mt-0.5 w-4 h-4 shrink-0" />
                          <span className="break-all">
                            {lastLocation.lat.toFixed(5)}, {lastLocation.lng.toFixed(5)}
                            {lastLocation.at && <span className="block text-xs text-slate-500">{formatPlaced(lastLocation.at)}</span>}
                          </span>
                        </a>
                      ) : (
                        <p className="text-xs text-slate-500">Not known yet.</p>
                      )}
                    </div>
                  </>
                ) : canAssign ? (
                  <button type="button" onClick={() => setAssignOpen(true)} className="w-full rounded-lg bg-slate-900 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-800">
                    Assign Deliveryman
                  </button>
                ) : (
                  <p className="text-sm text-slate-500">No deliveryman assigned.</p>
                )}
              </Card>
            )}

            <Card title="Customer Information" icon={User}>
              {customer ? (
                <div className="flex items-center gap-3 rounded-lg bg-slate-50 p-3">
                  <Avatar src={customer.image} alt={customer.name} />
                  <div className="min-w-0 space-y-1">
                    <Link to={`/admin/food/customers/${customer.id}`} className="block text-sm font-medium text-slate-800 hover:text-blue-600 break-words">
                      {customer.name || order.customerName || "Customer"}
                    </Link>
                    <p className="text-xs text-slate-500">{customer.orderCount} Orders</p>
                    <ContactLines phone={customer.phone} email={customer.email} />
                  </div>
                </div>
              ) : (
                <p className="text-sm text-slate-500">{order.customerName || "Customer not found"}</p>
              )}

              <div className="mt-4">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <h4 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                    <User className="w-4 h-4" /> Delivery Info
                  </h4>
                  {can("address") && (
                    <button
                      type="button"
                      onClick={() => setDeliveryOpen(true)}
                      title="Edit delivery info"
                      aria-label="Edit delivery info"
                      className="flex h-8 w-8 items-center justify-center rounded-lg border border-blue-200 bg-blue-50 text-blue-600 hover:bg-blue-100"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
                {isTakeaway ? (
                  <p className="text-sm text-slate-600">Takeaway: the customer collects it from the store.</p>
                ) : (
                  <div className="space-y-1 text-sm">
                    <p className="grid grid-cols-[72px_1fr] gap-2">
                      <span className="text-slate-500">Name :</span>
                      <span className="text-slate-800 break-words">{address.fullName || address.name || order.customerName || "—"}</span>
                    </p>
                    <p className="grid grid-cols-[72px_1fr] gap-2">
                      <span className="text-slate-500">Contact :</span>
                      <span className="text-slate-800 break-all">{address.phone || order.customerPhone || "—"}</span>
                    </p>
                    {formatAddress(address) && (
                      dropPoint ? (
                        <a href={mapsLink(dropPoint)} target="_blank" rel="noopener noreferrer" className="flex items-start gap-2 pt-1 text-blue-600 hover:underline">
                          <MapPin className="mt-0.5 w-4 h-4 shrink-0" /> <span className="break-words">{formatAddress(address)}</span>
                        </a>
                      ) : (
                        <p className="flex items-start gap-2 pt-1 text-slate-700">
                          <MapPin className="mt-0.5 w-4 h-4 shrink-0" /> <span className="break-words">{formatAddress(address)}</span>
                        </p>
                      )
                    )}
                  </div>
                )}
              </div>
            </Card>

            <Card title="Store Information" icon={Store}>
              {restaurant ? (
                <>
                  <div className="flex items-center gap-3 rounded-lg bg-slate-50 p-3">
                    <Avatar src={restaurant.logo} alt={restaurant.name} rounded="rounded-lg" />
                    <div className="min-w-0 space-y-1">
                      <Link to={`/admin/food/restaurants/view/${restaurant.id}`} className="block text-sm font-medium text-slate-800 hover:text-blue-600 break-words">
                        {restaurant.name}
                      </Link>
                      <p className="text-xs text-slate-500">{restaurant.orderCount} Orders</p>
                      <ContactLines phone={restaurant.phone} email={restaurant.email} />
                    </div>
                  </div>
                  {restaurant.address && (
                    restaurant.location ? (
                      <a href={mapsLink(restaurant.location)} target="_blank" rel="noopener noreferrer" className="mt-3 flex items-start gap-2 text-sm text-blue-600 hover:underline">
                        <MapPin className="mt-0.5 w-4 h-4 shrink-0" /> <span className="break-words">{restaurant.address}</span>
                      </a>
                    ) : (
                      <p className="mt-3 flex items-start gap-2 text-sm text-slate-700">
                        <MapPin className="mt-0.5 w-4 h-4 shrink-0" /> <span className="break-words">{restaurant.address}</span>
                      </p>
                    )
                  )}
                </>
              ) : (
                <p className="text-sm text-slate-500">Store not found</p>
              )}
            </Card>
          </div>
        </div>
      </div>

      <Dialog open={mapOpen} onOpenChange={setMapOpen}>
        <DialogContent className="max-w-3xl w-[calc(100vw-32px)] bg-white p-4">
          <DialogHeader>
            <DialogTitle>Location data</DialogTitle>
            <DialogDescription className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
              {mapPoints.map((p) => (
                <span key={p.label}>{p.icon ? "Deliveryman" : p.letter === "R" ? "R = Store" : "C = Customer"}: {p.label}</span>
              ))}
            </DialogDescription>
          </DialogHeader>
          {mapOpen && <LocationsMap points={mapPoints} />}
        </DialogContent>
      </Dialog>

      {assignOpen && (
        <AssignRiderDialog
          order={order}
          onClose={() => setAssignOpen(false)}
          onAssigned={() => {
            setAssignOpen(false)
            load(true)
          }}
        />
      )}

      {editOpen && (
        <EditOrderItemsDialog
          order={order}
          onClose={() => setEditOpen(false)}
          onSaved={(payload) => {
            setEditOpen(false)
            if (payload?.order) setData({ order: payload.order, details: payload.details, bill: payload.bill })
            else load(true)
          }}
        />
      )}

      {deliveryOpen && (
        <EditDeliveryInfoDialog
          order={order}
          restaurantLocation={restaurant?.location ? { lat: restaurant.location.lat, lng: restaurant.location.lng } : null}
          onClose={() => setDeliveryOpen(false)}
          onSaved={(payload) => {
            setDeliveryOpen(false)
            applyPayload(payload)
          }}
        />
      )}

      {noteOpen && (
        <EditOrderNoteDialog
          order={order}
          onClose={() => setNoteOpen(false)}
          onSaved={(payload) => {
            setNoteOpen(false)
            applyPayload(payload)
          }}
        />
      )}

      {scheduleOpen && (
        <RescheduleOrderDialog
          order={order}
          onClose={() => setScheduleOpen(false)}
          onSaved={(payload) => {
            setScheduleOpen(false)
            applyPayload(payload)
          }}
        />
      )}

      {paymentTo !== null && (
        <PaymentStatusDialog
          order={order}
          paid={paymentTo}
          onClose={() => setPaymentTo(null)}
          onSaved={(payload) => {
            setPaymentTo(null)
            applyPayload(payload)
          }}
        />
      )}

      {refOpen && (
        <ReferenceCodeDialog
          orderId={id}
          displayId={order.orderId}
          current={referenceCode}
          onClose={() => setRefOpen(false)}
          onSaved={() => {
            setRefOpen(false)
            load(true)
          }}
        />
      )}

      {cancelOpen && (
        <CancelOrderDialog
          order={order}
          mode={step === "pending" ? "reject" : "cancel"}
          onClose={() => setCancelOpen(false)}
          onConfirm={confirmCancel}
        />
      )}
    </div>
  )
}
