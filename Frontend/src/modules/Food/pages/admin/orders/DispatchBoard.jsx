import { useEffect, useRef, useState } from "react"
import { Bike, Clock, Loader2, RefreshCw, Truck, UserCheck } from "lucide-react"
import { toast } from "sonner"
import { adminAPI } from "@food/api"

const rupees = (value) => `₹${Number(value || 0).toLocaleString("en-IN")}`
const REFRESH_MS = 20000

const STATUS = {
  confirmed: "Accepted by restaurant",
  preparing: "Preparing",
  ready_for_pickup: "Ready for pickup",
  reached_pickup: "Rider at restaurant",
  picked_up: "Picked up",
  reached_drop: "Rider at customer",
}

/** Minutes as "8 min" or "1 h 12 min", red once it is late. */
function Age({ minutes, lateAfter }) {
  if (minutes == null) return null
  const text = minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`
  return <span className={`text-xs font-semibold ${minutes >= lateAfter ? "text-rose-600" : "text-slate-500"}`}>{text}</span>
}

function OrderCard({ order, riders, onAssign, assigning }) {
  const [picking, setPicking] = useState(false)
  const [riderId, setRiderId] = useState("")
  const waiting = order.dispatchStatus !== "accepted"
  const cashOrder = order.paymentMethod === "cash"
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-sm font-bold text-slate-900">{order.orderId}</p>
          <p className="text-xs text-slate-600">{order.restaurant}{order.restaurantArea ? ` · ${order.restaurantArea}` : ""}</p>
        </div>
        <div className="text-right">
          <p className="text-sm font-semibold text-slate-900">{rupees(order.total)}</p>
          <p className={`text-[10px] font-bold uppercase ${cashOrder ? "text-amber-700" : "text-emerald-700"}`}>{cashOrder ? "Cash" : "Paid online"}</p>
        </div>
      </div>
      <p className="text-xs text-slate-600 truncate" title={order.address}>{order.customer} · {order.address}</p>
      <div className="flex items-center justify-between gap-2">
        <span className="rounded bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-700">{STATUS[order.status] || order.status}</span>
        <span className="flex items-center gap-1">
          <Clock className="w-3 h-3 text-slate-400" />
          {waiting ? <Age minutes={order.placedMinutesAgo} lateAfter={15} /> : <Age minutes={order.pickedUpMinutesAgo ?? order.placedMinutesAgo} lateAfter={45} />}
        </span>
      </div>
      {order.rider && (
        <p className="text-xs text-slate-700">
          <Bike className="inline w-3.5 h-3.5 mr-1 text-teal-700" />
          {order.rider.name} · {order.rider.phone}
          {waiting && <span className="ml-1 text-amber-700">(offered, not accepted yet)</span>}
        </p>
      )}
      {waiting && (
        picking ? (
          <div className="flex gap-2">
            <select value={riderId} onChange={(e) => setRiderId(e.target.value)} className="flex-1 rounded-lg border border-slate-300 px-2 py-1.5 text-xs">
              <option value="">Choose a rider</option>
              {riders.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name} · {r.activeOrders ? `${r.activeOrders} on trip` : "free"}{r.cashSuspended ? " · over cash limit" : ""}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={!riderId || assigning}
              onClick={() => onAssign(order, riderId).then((ok) => ok && setPicking(false))}
              className="rounded-lg bg-teal-700 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
            >
              {assigning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Assign"}
            </button>
          </div>
        ) : (
          <button type="button" onClick={() => setPicking(true)} className="w-full rounded-lg border border-teal-700 px-3 py-1.5 text-xs font-semibold text-teal-700 hover:bg-teal-50">
            {order.rider ? "Assign another rider" : "Assign rider"}
          </button>
        )
      )}
    </div>
  )
}

/** Orders waiting for a rider, orders on the road, and who is online to take them. */
export default function DispatchBoard() {
  const [board, setBoard] = useState(null)
  const [loading, setLoading] = useState(true)
  const [assigningId, setAssigningId] = useState(null)
  const timer = useRef(null)

  const load = async (quiet = false) => {
    if (!quiet) setLoading(true)
    try {
      const res = await adminAPI.getDispatchBoard()
      setBoard(res?.data?.data || null)
    } catch (err) {
      if (!quiet) toast.error(err?.response?.data?.message || "Failed to load the dispatch board")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    timer.current = setInterval(() => load(true), REFRESH_MS)
    return () => clearInterval(timer.current)
  }, [])

  const assign = async (order, riderId) => {
    try {
      setAssigningId(order.id)
      await adminAPI.assignRider(order.id, riderId)
      toast.success(`${order.orderId} offered to the rider; it moves to "On the way" once they accept`)
      await load(true)
      return true
    } catch (err) {
      toast.error(err?.response?.data?.message || "Failed to assign the rider")
      return false
    } finally {
      setAssigningId(null)
    }
  }

  const riders = board?.riders || []
  return (
    <div className="p-4 lg:p-6 bg-slate-50 min-h-screen">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-3">
                <Truck className="w-5 h-5 text-teal-700" />
                <h1 className="text-2xl font-bold text-slate-900">Dispatch</h1>
              </div>
              <p className="text-sm text-slate-600 mt-1">
                Orders the restaurant has accepted but no rider has taken yet, and orders on the way. Updates every 20 seconds.
              </p>
            </div>
            <button type="button" onClick={() => load()} className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100">
              <RefreshCw className="w-4 h-4" /> Refresh
            </button>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <span className="text-xs font-semibold text-slate-500 mr-1 self-center">
              <UserCheck className="inline w-4 h-4 mr-1" />
              {riders.length} rider{riders.length === 1 ? "" : "s"} online
            </span>
            {riders.map((r) => (
              <span
                key={r.id}
                title={`${r.phone} · cash in hand ${rupees(r.cashInHand)}`}
                className={`rounded-full px-2.5 py-1 text-xs font-medium ${r.cashSuspended ? "bg-rose-100 text-rose-700" : r.activeOrders ? "bg-amber-100 text-amber-800" : "bg-emerald-100 text-emerald-800"}`}
              >
                {r.name} · {r.cashSuspended ? "over cash limit" : r.activeOrders ? `${r.activeOrders} on trip` : "free"}
              </span>
            ))}
          </div>
        </div>

        {loading && !board ? (
          <div className="py-16 text-center"><Loader2 className="w-7 h-7 animate-spin text-teal-600 mx-auto" /></div>
        ) : (
          <div className="grid gap-6 lg:grid-cols-2">
            {[
              ["Waiting for a rider", board?.waiting || []],
              ["On the way", board?.onTheWay || []],
            ].map(([title, orders]) => (
              <section key={title} className="rounded-xl border border-slate-200 bg-slate-100/60 p-4">
                <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-slate-700">
                  {title} <span className="ml-1 rounded-full bg-white px-2 py-0.5 text-slate-600">{orders.length}</span>
                </h2>
                {orders.length === 0 ? (
                  <p className="py-8 text-center text-sm text-slate-500">None right now.</p>
                ) : (
                  <div className="space-y-3">
                    {orders.map((order) => (
                      <OrderCard key={order.id} order={order} riders={riders} onAssign={assign} assigning={assigningId === order.id} />
                    ))}
                  </div>
                )}
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
