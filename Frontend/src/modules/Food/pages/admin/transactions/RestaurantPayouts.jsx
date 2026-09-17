import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { Loader2, Package, Play, Receipt, Save, Settings2 } from "lucide-react"
import { toast } from "sonner"
import { adminAPI } from "@food/api"

const formatCurrency = (amount) =>
  `₹${Number(amount || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const formatDate = (d) => {
  if (!d) return "—"
  try {
    return new Date(d).toLocaleString("en-IN", {
      day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: true,
    })
  } catch {
    return String(d)
  }
}

export const BATCH_STATUS = {
  pending: { label: "Pending", className: "bg-amber-100 text-amber-700" },
  partially_completed: { label: "Partially completed", className: "bg-blue-100 text-blue-700" },
  completed: { label: "Completed", className: "bg-green-100 text-green-700" },
  canceled: { label: "Canceled", className: "bg-slate-200 text-slate-700" },
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
const TABS = [
  ["all", "All"],
  ["pending", "Pending"],
  ["partially_completed", "Partially completed"],
  ["completed", "Completed"],
  ["canceled", "Canceled"],
]

/** How and when the payout run happens. */
function PayoutSettings() {
  const [settings, setSettings] = useState(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    adminAPI
      .getRestaurantPayoutSettings()
      .then((res) => setSettings(res?.data?.data?.settings || null))
      .catch(() => toast.error("Failed to load payout settings"))
  }, [])

  if (!settings) {
    return (
      <div className="py-6 text-center">
        <Loader2 className="w-5 h-5 animate-spin text-slate-400 mx-auto" />
      </div>
    )
  }

  const set = (key, value) => setSettings((prev) => ({ ...prev, [key]: value }))

  const save = async () => {
    try {
      setSaving(true)
      const res = await adminAPI.updateRestaurantPayoutSettings({
        isEnabled: settings.isEnabled,
        frequency: settings.frequency,
        weekday: Number(settings.weekday),
        runTime: settings.runTime,
        waitingDays: Number(settings.waitingDays),
        minAmount: Number(settings.minAmount),
      })
      setSettings(res?.data?.data?.settings || settings)
      toast.success("Payout settings saved")
    } catch (err) {
      toast.error(err?.response?.data?.message || "Failed to save payout settings")
    } finally {
      setSaving(false)
    }
  }

  const input = "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-4 items-end">
      <label className="space-y-1">
        <span className="text-xs font-semibold text-slate-600">Automatic payouts</span>
        <select className={input} value={settings.isEnabled ? "on" : "off"} onChange={(e) => set("isEnabled", e.target.value === "on")}>
          <option value="on">On</option>
          <option value="off">Off</option>
        </select>
      </label>
      <label className="space-y-1">
        <span className="text-xs font-semibold text-slate-600">Every</span>
        <select className={input} value={settings.frequency} onChange={(e) => set("frequency", e.target.value)}>
          <option value="daily">Day</option>
          <option value="weekly">Week</option>
        </select>
      </label>
      {settings.frequency === "weekly" && (
        <label className="space-y-1">
          <span className="text-xs font-semibold text-slate-600">On</span>
          <select className={input} value={settings.weekday} onChange={(e) => set("weekday", Number(e.target.value))}>
            {WEEKDAYS.map((day, index) => (
              <option key={day} value={index}>{day}</option>
            ))}
          </select>
        </label>
      )}
      <label className="space-y-1">
        <span className="text-xs font-semibold text-slate-600">At (IST)</span>
        <input type="time" className={input} value={settings.runTime} onChange={(e) => set("runTime", e.target.value)} />
      </label>
      <label className="space-y-1">
        <span className="text-xs font-semibold text-slate-600" title="Earnings from the most recent days are held back, so late refunds are settled first">
          Hold back (days)
        </span>
        <input type="number" min="0" max="30" className={input} value={settings.waitingDays} onChange={(e) => set("waitingDays", e.target.value)} />
      </label>
      <label className="space-y-1">
        <span className="text-xs font-semibold text-slate-600">Minimum payout (₹)</span>
        <input type="number" min="1" className={input} value={settings.minAmount} onChange={(e) => set("minAmount", e.target.value)} />
      </label>
      <button
        type="button"
        onClick={save}
        disabled={saving}
        className="inline-flex items-center justify-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
      >
        {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
        Save
      </button>
    </div>
  )
}

export default function RestaurantPayouts() {
  const [batches, setBatches] = useState([])
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState("all")
  const [page, setPage] = useState(1)
  const [pages, setPages] = useState(1)
  const [total, setTotal] = useState(0)
  const [showSettings, setShowSettings] = useState(false)
  const [generating, setGenerating] = useState(false)

  const fetchBatches = async (p = page) => {
    try {
      setLoading(true)
      const res = await adminAPI.getRestaurantPayoutBatches({ status, page: p, limit: 20 })
      const data = res?.data?.data
      setBatches(data?.batches || [])
      setPages(data?.pagination?.pages || 1)
      setTotal(data?.pagination?.total || 0)
    } catch (err) {
      toast.error(err?.response?.data?.message || "Failed to load payouts")
      setBatches([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchBatches(page)
  }, [page, status])

  const generateNow = async () => {
    if (!window.confirm("Create today's payout batch now? It can only be created once per day.")) return
    try {
      setGenerating(true)
      const res = await adminAPI.generateRestaurantPayouts()
      toast.success(res?.data?.message || "Payout batch created")
      setPage(1)
      fetchBatches(1)
    } catch (err) {
      toast.error(err?.response?.data?.message || "Failed to create the payout batch")
    } finally {
      setGenerating(false)
    }
  }

  return (
    <div className="p-4 lg:p-6 bg-slate-50 min-h-screen">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
          <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
            <div>
              <div className="flex items-center gap-3">
                <Receipt className="w-5 h-5 text-emerald-600" />
                <h1 className="text-2xl font-bold text-slate-900">Restaurant Disbursement</h1>
              </div>
              <p className="text-sm text-slate-600 mt-1 max-w-3xl">
                Every day the system lists what each restaurant is owed as one payout batch. Pay each restaurant by bank
                transfer or UPI to the details shown, then mark it paid. Money in a pending payout cannot also be
                requested by the restaurant; a cancelled payout goes back to their balance.
              </p>
            </div>
            <div className="flex gap-2 shrink-0">
              <button
                type="button"
                onClick={() => setShowSettings((v) => !v)}
                className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                <Settings2 className="w-4 h-4" /> Settings
              </button>
              <button
                type="button"
                onClick={generateNow}
                disabled={generating}
                className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-60"
              >
                {generating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                Generate now
              </button>
            </div>
          </div>
          {showSettings && (
            <div className="mt-6 border-t border-slate-200 pt-6">
              <PayoutSettings />
            </div>
          )}
        </div>

        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
          <div className="flex flex-wrap items-center gap-2 mb-4">
            <h2 className="text-xl font-bold text-slate-900 mr-2">Payouts</h2>
            <span className="px-3 py-1 rounded-full text-sm font-semibold bg-slate-100 text-slate-700 mr-4">{total}</span>
            {TABS.map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => {
                  setStatus(key)
                  setPage(1)
                }}
                className={`rounded-full px-3 py-1 text-xs font-semibold ${
                  status === key ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {loading ? (
            <div className="py-20 text-center">
              <Loader2 className="w-8 h-8 animate-spin text-emerald-600 mx-auto" />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-slate-50 border-b border-slate-200">
                  <tr>
                    {["Payout", "Created", "Restaurants", "Total", "Paid", "Status", ""].map((h) => (
                      <th key={h} className="px-6 py-4 text-left text-[10px] font-bold text-slate-700 uppercase tracking-wider">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {batches.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-6 py-16 text-center">
                        <Package className="w-12 h-12 text-slate-400 mx-auto mb-3" />
                        <p className="font-semibold text-slate-700">No payouts</p>
                        <p className="text-sm text-slate-500">Batches appear here after the daily run.</p>
                      </td>
                    </tr>
                  ) : (
                    batches.map((b) => {
                      const badge = BATCH_STATUS[b.status] || BATCH_STATUS.pending
                      return (
                        <tr key={b.id} className="hover:bg-slate-50">
                          <td className="px-6 py-4 text-sm font-semibold text-slate-800">
                            {b.title}
                            {b.triggeredBy !== "schedule" && (
                              <span className="block text-[11px] font-normal text-slate-500">Generated by admin</span>
                            )}
                          </td>
                          <td className="px-6 py-4 text-sm text-slate-700 whitespace-nowrap">{formatDate(b.createdAt)}</td>
                          <td className="px-6 py-4 text-sm text-slate-700">
                            {b.restaurantCount}
                            {b.skipped?.length > 0 && (
                              <span className="block text-[11px] text-red-600">{b.skipped.length} skipped</span>
                            )}
                          </td>
                          <td className="px-6 py-4 text-sm font-medium text-slate-800">{formatCurrency(b.totalAmount)}</td>
                          <td className="px-6 py-4 text-sm text-slate-700">{formatCurrency(b.paidAmount)}</td>
                          <td className="px-6 py-4">
                            <span className={`px-2 py-0.5 rounded text-xs font-semibold ${badge.className}`}>{badge.label}</span>
                          </td>
                          <td className="px-6 py-4 text-right">
                            <Link
                              to={`/admin/food/restaurant-disbursements/${b.id}`}
                              className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                            >
                              View
                            </Link>
                          </td>
                        </tr>
                      )
                    })
                  )}
                </tbody>
              </table>
            </div>
          )}

          {pages > 1 && (
            <div className="flex items-center justify-between mt-4 pt-4 border-t border-slate-200">
              <p className="text-sm text-slate-600">Page {page} of {pages}</p>
              <div className="flex gap-2">
                <button type="button" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1} className="px-4 py-2 text-sm rounded-lg border border-slate-300 disabled:opacity-50">Previous</button>
                <button type="button" onClick={() => setPage((p) => Math.min(pages, p + 1))} disabled={page >= pages} className="px-4 py-2 text-sm rounded-lg border border-slate-300 disabled:opacity-50">Next</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
