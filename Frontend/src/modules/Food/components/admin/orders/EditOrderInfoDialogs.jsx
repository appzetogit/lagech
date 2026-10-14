import { useEffect, useRef, useState } from "react"
import { Loader } from "@googlemaps/js-api-loader"
import { toast } from "sonner"
import { AlertTriangle, Loader2, MapPin, Search } from "@food/components/admin/theme/icons"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@food/components/ui/dialog"
import { adminAPI } from "@food/api"
import { getGoogleMapsApiKey } from "@food/utils/googleMapsApiKey"

/**
 * The Order Details edits besides the items, as on the old 6amMart panel:
 * Delivery Info (receiver, phone, address, map pin), Order note / delivery
 * instructions, and a scheduled order's time. Each saves through its own
 * PATCH and hands the fresh details payload back to the page.
 */

const errorOf = (err, fallback) => err?.response?.data?.message || err?.message || fallback

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

/** "14 Oct 2026, 03:50 PM", in the viewer's local time. */
export const formatTime12 = (value) => {
  const d = value ? new Date(value) : null
  if (!d || Number.isNaN(d.getTime())) return ""
  const pad = (n) => String(n).padStart(2, "0")
  const hours = d.getHours() % 12 || 12
  return `${pad(d.getDate())} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${pad(hours)}:${pad(d.getMinutes())} ${d.getHours() < 12 ? "AM" : "PM"}`
}

const inputClass = "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"

function Field({ label, required, children, className = "" }) {
  return (
    <label className={`block space-y-1 ${className}`}>
      <span className="text-xs font-medium text-slate-600">
        {label}
        {required && <span className="text-rose-500"> *</span>}
      </span>
      {children}
    </label>
  )
}

function Buttons({ saving, disabled, onClose, label = "Save" }) {
  return (
    <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
      <button type="button" onClick={onClose} disabled={saving} className="rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-700">Cancel</button>
      <button type="submit" disabled={saving || disabled} className="inline-flex items-center justify-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
        {saving && <Loader2 className="w-4 h-4 animate-spin" />}
        {label}
      </button>
    </div>
  )
}

// ─── Map pin ─────────────────────────────────────────────────────────────────

/** Google map with a draggable pin and a place search; tap the map to move the pin. */
function PinMap({ value, restaurant, onChange }) {
  const mapRef = useRef(null)
  const searchRef = useRef(null)
  const markerRef = useRef(null)
  const mapObj = useRef(null)
  const [state, setState] = useState("loading")
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  useEffect(() => {
    let cancelled = false
    const draw = (google) => {
      if (cancelled || !mapRef.current) return
      const start = value || restaurant || { lat: 20.5937, lng: 78.9629 }
      const map = new google.maps.Map(mapRef.current, {
        center: start,
        zoom: value ? 16 : 13,
        mapTypeControl: false,
        streetViewControl: false,
        fullscreenControl: false,
        gestureHandling: "greedy",
      })
      mapObj.current = map
      if (restaurant) {
        new google.maps.Marker({ position: restaurant, map, title: "Store", label: { text: "R", color: "#fff", fontWeight: "600" } })
      }
      const marker = new google.maps.Marker({ position: start, map, draggable: true, title: "Delivery location" })
      markerRef.current = marker
      // No pin yet: the marker starts at the store, and that is the pin until moved.
      if (!value) onChangeRef.current({ lat: start.lat, lng: start.lng })
      const move = (latLng) => {
        marker.setPosition(latLng)
        onChangeRef.current({ lat: latLng.lat(), lng: latLng.lng() })
      }
      marker.addListener("dragend", (e) => move(e.latLng))
      map.addListener("click", (e) => move(e.latLng))

      if (searchRef.current && google.maps.places) {
        const box = new google.maps.places.Autocomplete(searchRef.current, { fields: ["geometry", "formatted_address"] })
        box.bindTo("bounds", map)
        box.addListener("place_changed", () => {
          const place = box.getPlace()
          const loc = place?.geometry?.location
          if (!loc) return
          map.panTo(loc)
          map.setZoom(17)
          move(loc)
        })
      }
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
    // Drawn once per opening; the pin then moves by drag, tap or search.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Coordinates typed by hand move the marker too.
  useEffect(() => {
    const marker = markerRef.current
    if (!marker || !value) return
    const at = marker.getPosition()
    if (at && Math.abs(at.lat() - value.lat) < 1e-9 && Math.abs(at.lng() - value.lng) < 1e-9) return
    marker.setPosition(value)
    mapObj.current?.panTo(value)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value?.lat, value?.lng])

  return (
    <div className="space-y-2">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-2.5 w-4 h-4 text-slate-400" />
        <input
          ref={searchRef}
          type="text"
          placeholder="Search a place or area"
          disabled={state !== "ready"}
          onKeyDown={(e) => e.key === "Enter" && e.preventDefault()}
          className={`${inputClass} pl-9`}
        />
      </div>
      <div className="relative h-[42vh] max-h-[360px] min-h-[220px] w-full overflow-hidden rounded-lg bg-slate-100">
        <div ref={mapRef} className="absolute inset-0" />
        {state !== "ready" && (
          <div className="absolute inset-0 flex items-center justify-center px-4 text-center text-sm text-slate-500">
            {state === "loading" ? <Loader2 className="w-6 h-6 animate-spin" /> : state === "nokey" ? "Google Maps is not configured: enter the coordinates below." : "The map could not be loaded: enter the coordinates below."}
          </div>
        )}
      </div>
      <p className="text-[11px] text-slate-500">Drag the pin or tap the map to set the exact drop location.</p>
    </div>
  )
}

// ─── Delivery info ───────────────────────────────────────────────────────────

const fromGeo = (point) => {
  const c = point?.coordinates
  if (!Array.isArray(c) || c.length < 2) return null
  const [lng, lat] = c.map(Number)
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null
}

export function EditDeliveryInfoDialog({ order, restaurantLocation, onClose, onSaved }) {
  const id = order._id || order.id
  const a = order.deliveryAddress || {}
  const [form, setForm] = useState({
    fullName: a.fullName || a.name || order.customerName || "",
    phone: a.phone || order.customerPhone || "",
    label: a.label || "Home",
    street: a.street || "",
    additionalDetails: a.additionalDetails || "",
    city: a.city || "",
    state: a.state || "",
    zipCode: a.zipCode || "",
  })
  const [pin, setPin] = useState(fromGeo(a.location))
  const [check, setCheck] = useState({ state: "idle" })
  const [saving, setSaving] = useState(false)
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }))

  const payload = () => ({ ...form, latitude: pin?.lat, longitude: pin?.lng })

  // Every pin move is checked by the server: zone, distance, fee band.
  useEffect(() => {
    if (!pin) return undefined
    let stale = false
    setCheck({ state: "checking" })
    const timer = setTimeout(async () => {
      try {
        const res = await adminAPI.updateOrderDeliveryAddress(
          id,
          // The check is about the pin only; the text fields are validated on save.
          { fullName: "-", phone: "000000", street: "-", city: "-", latitude: pin.lat, longitude: pin.lng },
          { preview: true },
        )
        if (!stale) setCheck({ state: "ok", ...(res?.data?.data?.change || {}) })
      } catch (err) {
        if (!stale) setCheck({ state: "error", message: errorOf(err, "Could not check this location") })
      }
    }, 450)
    return () => {
      stale = true
      clearTimeout(timer)
    }
    // Re-checked when the pin moves, not on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pin?.lat, pin?.lng])

  const submit = async (e) => {
    e.preventDefault()
    if (saving) return
    if (!pin) {
      toast.error("Place the pin on the map")
      return
    }
    setSaving(true)
    try {
      const res = await adminAPI.updateOrderDeliveryAddress(id, payload())
      toast.success("Delivery info updated")
      onSaved(res?.data?.data)
    } catch (err) {
      toast.error(errorOf(err, "Could not update the delivery info"))
    } finally {
      setSaving(false)
    }
  }

  const setCoord = (key) => (e) => {
    const v = Number(e.target.value)
    if (!Number.isFinite(v)) return
    setPin((p) => ({ lat: p?.lat ?? 0, lng: p?.lng ?? 0, [key]: v }))
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !saving && onClose()}>
      <DialogContent className="max-w-2xl w-[calc(100vw-24px)] max-h-[92vh] overflow-y-auto bg-white p-4 sm:p-6">
        <DialogHeader>
          <DialogTitle>Delivery info</DialogTitle>
          <DialogDescription>Order #{order.orderId}. The rider and the store are told about the change.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Receiver name" required>
              <input value={form.fullName} onChange={set("fullName")} maxLength={100} className={inputClass} autoComplete="off" />
            </Field>
            <Field label="Contact number" required>
              <input value={form.phone} onChange={set("phone")} maxLength={20} inputMode="tel" className={inputClass} autoComplete="off" />
            </Field>
            <Field label="Street / area" required className="sm:col-span-2">
              <input value={form.street} onChange={set("street")} maxLength={300} className={inputClass} />
            </Field>
            <Field label="House / floor / landmark" className="sm:col-span-2">
              <input value={form.additionalDetails} onChange={set("additionalDetails")} maxLength={300} placeholder="Flat 4B, 2nd floor, near the temple" className={inputClass} />
            </Field>
            <Field label="City" required>
              <input value={form.city} onChange={set("city")} maxLength={100} className={inputClass} />
            </Field>
            <Field label="State">
              <input value={form.state} onChange={set("state")} maxLength={100} className={inputClass} />
            </Field>
            <Field label="Zip code">
              <input value={form.zipCode} onChange={set("zipCode")} maxLength={12} inputMode="numeric" className={inputClass} />
            </Field>
            <Field label="Address type">
              <select value={form.label} onChange={set("label")} className={`${inputClass} bg-white`}>
                {["Home", "Office", "Other"].map((l) => <option key={l} value={l}>{l}</option>)}
              </select>
            </Field>
          </div>

          <div className="space-y-2">
            <p className="flex items-center gap-1.5 text-xs font-medium text-slate-600"><MapPin className="w-3.5 h-3.5" /> Location on map <span className="text-rose-500">*</span></p>
            <PinMap value={pin} restaurant={restaurantLocation} onChange={setPin} />
            <div className="grid grid-cols-2 gap-2">
              <Field label="Latitude">
                <input type="number" step="any" value={pin?.lat ?? ""} onChange={setCoord("lat")} className={inputClass} />
              </Field>
              <Field label="Longitude">
                <input type="number" step="any" value={pin?.lng ?? ""} onChange={setCoord("lng")} className={inputClass} />
              </Field>
            </div>
          </div>

          <div className="space-y-2 text-xs">
            {check.state === "checking" && <p className="flex items-center gap-2 text-slate-500"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Checking the location…</p>}
            {check.state === "error" && <p className="rounded-lg border border-rose-200 bg-rose-50 p-2.5 text-rose-700">{check.message}</p>}
            {check.state === "ok" && (
              <p className="text-emerald-700">
                Inside {check.zone?.name ? `zone ${check.zone.name}` : "the delivery area"}
                {check.distanceKm != null && ` · ${check.distanceKm} km from the store`}
              </p>
            )}
            {check.state === "ok" && check.feeWarning && (
              <p className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-2.5 text-amber-800">
                <AlertTriangle className="mt-0.5 w-4 h-4 shrink-0" /> <span>{check.feeWarning}</span>
              </p>
            )}
            <p className="text-slate-500">The delivery fee stays as charged when the address changes, as on the old panel.</p>
          </div>

          <Buttons saving={saving} disabled={!pin || check.state === "error" || check.state === "checking"} onClose={onClose} />
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ─── Order note / delivery instructions ─────────────────────────────────────

export function EditOrderNoteDialog({ order, onClose, onSaved }) {
  const id = order._id || order.id
  const [note, setNote] = useState(order.note || "")
  const [instructions, setInstructions] = useState(order.deliveryInstructions || "")
  const [saving, setSaving] = useState(false)
  const isTakeaway = order.orderType === "takeaway"
  const changed = note.trim() !== (order.note || "") || instructions.trim() !== (order.deliveryInstructions || "")

  const submit = async (e) => {
    e.preventDefault()
    if (saving || !changed) return
    setSaving(true)
    try {
      const body = {}
      if (note.trim() !== (order.note || "")) body.note = note.trim()
      if (instructions.trim() !== (order.deliveryInstructions || "")) body.deliveryInstructions = instructions.trim()
      const res = await adminAPI.updateOrderNotes(id, body)
      toast.success("Order note updated")
      onSaved(res?.data?.data)
    } catch (err) {
      toast.error(errorOf(err, "Could not save the note"))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !saving && onClose()}>
      <DialogContent className="max-w-md w-[calc(100vw-32px)] bg-white">
        <DialogHeader>
          <DialogTitle>Order note</DialogTitle>
          <DialogDescription>Order #{order.orderId}. The store sees the order note; the rider sees the delivery instructions.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          <Field label="Order note (for the store)">
            <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} rows={3} className={inputClass} placeholder="e.g. less spicy" />
          </Field>
          {!isTakeaway && (
            <Field label="Delivery instructions (for the rider)">
              <textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} maxLength={500} rows={3} className={inputClass} placeholder="e.g. ring the bell twice" />
            </Field>
          )}
          <Buttons saving={saving} disabled={!changed} onClose={onClose} />
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ─── Scheduled time ──────────────────────────────────────────────────────────

/** Date -> the "YYYY-MM-DDTHH:mm" a datetime-local input takes, in local time. */
const toLocalInput = (value) => {
  const d = value ? new Date(value) : null
  if (!d || Number.isNaN(d.getTime())) return ""
  const pad = (n) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function RescheduleOrderDialog({ order, onClose, onSaved }) {
  const id = order._id || order.id
  const [value, setValue] = useState(toLocalInput(order.scheduledAt))
  const [saving, setSaving] = useState(false)
  const picked = value ? new Date(value) : null
  const valid = picked && !Number.isNaN(picked.getTime())

  const submit = async (e) => {
    e.preventDefault()
    if (saving || !valid) return
    setSaving(true)
    try {
      const res = await adminAPI.rescheduleOrder(id, picked.toISOString())
      toast.success(`Scheduled for ${formatTime12(picked)}`)
      onSaved(res?.data?.data)
    } catch (err) {
      toast.error(errorOf(err, "Could not change the time"))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !saving && onClose()}>
      <DialogContent className="max-w-md w-[calc(100vw-32px)] bg-white">
        <DialogHeader>
          <DialogTitle>Change scheduled time</DialogTitle>
          <DialogDescription>
            Order #{order.orderId}, now {formatTime12(order.scheduledAt) || "—"}. Today or tomorrow, while the store is open, at least the usual lead time from now.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          <Field label="New time">
            <input type="datetime-local" value={value} onChange={(e) => setValue(e.target.value)} min={toLocalInput(new Date())} className={inputClass} />
          </Field>
          {valid && <p className="text-xs text-slate-600">{formatTime12(picked)}</p>}
          <p className="text-[11px] text-slate-500">The store is alerted and riders are sent shortly before the new time. The customer is told.</p>
          <Buttons saving={saving} disabled={!valid || toLocalInput(order.scheduledAt) === value} onClose={onClose} />
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ─── Payment status ──────────────────────────────────────────────────────────

/** Confirms "Mark as paid / unpaid" and says what it does to the rider's collection. */
export function PaymentStatusDialog({ order, paid, onClose, onSaved }) {
  const id = order._id || order.id
  const [note, setNote] = useState("")
  const [saving, setSaving] = useState(false)

  const submit = async (e) => {
    e.preventDefault()
    if (saving) return
    setSaving(true)
    try {
      const res = await adminAPI.setOrderPaymentStatus(id, paid, note.trim())
      toast.success(paid ? "Marked as paid" : "Marked as unpaid")
      onSaved(res?.data?.data)
    } catch (err) {
      toast.error(errorOf(err, "Could not change the payment status"))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !saving && onClose()}>
      <DialogContent className="max-w-md w-[calc(100vw-32px)] bg-white">
        <DialogHeader>
          <DialogTitle>{paid ? "Mark as paid" : "Mark as unpaid"}</DialogTitle>
          <DialogDescription>Order #{order.orderId}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          <div className="rounded-lg bg-slate-50 p-3 text-xs text-slate-700 space-y-1.5">
            {paid ? (
              <>
                <p>Use this when the customer has already paid the business (UPI, bank transfer…). Add the payment's reference code first if you have it.</p>
                <p>The order is recorded as paid to the business: the rider will <b>not</b> collect cash at the door, and it is not counted in the rider's cash in hand.</p>
              </>
            ) : (
              <p>The order goes back to cash on delivery: the rider collects the amount at the door.</p>
            )}
          </div>
          <Field label="Note (optional)">
            <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} className={inputClass} placeholder={paid ? "e.g. paid by UPI to the office" : "e.g. payment not received"} />
          </Field>
          <Buttons saving={saving} onClose={onClose} label={paid ? "Mark as paid" : "Mark as unpaid"} />
        </form>
      </DialogContent>
    </Dialog>
  )
}
