import { useEffect, useState } from "react"
import { AlertTriangle, Loader2, Plus, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { adminAPI } from "@food/api"

const USER_TYPES = [
  ["admin", "Admin"],
  ["restaurant", "Restaurant"],
  ["customer", "Customer"],
  ["rider", "Rider"],
]
const LABEL = Object.fromEntries(USER_TYPES)

/** The reasons offered when an order is cancelled, kept per who is cancelling. */
export default function OrderCancelReasons() {
  const [reasons, setReasons] = useState([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState("all")
  const [draft, setDraft] = useState({ reason: "", userType: "admin" })
  const [saving, setSaving] = useState(false)

  const load = async () => {
    try {
      setLoading(true)
      const res = await adminAPI.getCancelReasons()
      setReasons(res?.data?.data?.reasons || [])
    } catch (err) {
      toast.error(err?.response?.data?.message || "Failed to load cancel reasons")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [])

  const add = async (e) => {
    e.preventDefault()
    if (!draft.reason.trim()) return toast.error("Type a reason")
    try {
      setSaving(true)
      await adminAPI.createCancelReason(draft)
      toast.success("Reason added")
      setDraft((d) => ({ ...d, reason: "" }))
      load()
    } catch (err) {
      toast.error(err?.response?.data?.message || "Failed to add the reason")
    } finally {
      setSaving(false)
    }
  }

  const toggle = async (row) => {
    try {
      await adminAPI.updateCancelReason(row.id, { isActive: !row.isActive })
      setReasons((list) => list.map((r) => (r.id === row.id ? { ...r, isActive: !r.isActive } : r)))
    } catch (err) {
      toast.error(err?.response?.data?.message || "Failed to update the reason")
    }
  }

  const remove = async (row) => {
    if (!window.confirm(`Delete "${row.reason}"?`)) return
    try {
      await adminAPI.deleteCancelReason(row.id)
      setReasons((list) => list.filter((r) => r.id !== row.id))
    } catch (err) {
      toast.error(err?.response?.data?.message || "Failed to delete the reason")
    }
  }

  const shown = filter === "all" ? reasons : reasons.filter((r) => r.userType === filter)

  return (
    <div className="p-4 lg:p-6 bg-slate-50 min-h-screen">
      <div className="max-w-5xl mx-auto space-y-6">
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
          <div className="flex items-center gap-3">
            <AlertTriangle className="w-5 h-5 text-rose-600" />
            <h1 className="text-2xl font-bold text-slate-900">Order Cancel Reasons</h1>
          </div>
          <p className="text-sm text-slate-600 mt-1">
            The reasons offered when an order is cancelled. Each list is shown to whoever is cancelling: the admin panel,
            restaurants, customers or riders. Switched-off reasons are kept but no longer offered.
          </p>
          <form onSubmit={add} className="mt-5 flex flex-col sm:flex-row gap-2">
            <input
              value={draft.reason}
              maxLength={200}
              onChange={(e) => setDraft((d) => ({ ...d, reason: e.target.value }))}
              placeholder="e.g. Restaurant is closed"
              className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
            />
            <select
              value={draft.userType}
              onChange={(e) => setDraft((d) => ({ ...d, userType: e.target.value }))}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
              aria-label="Who cancels"
            >
              {USER_TYPES.map(([key, label]) => (
                <option key={key} value={key}>For {label}</option>
              ))}
            </select>
            <button
              type="submit"
              disabled={saving}
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
            >
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
              Add reason
            </button>
          </form>
        </div>

        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
          <div className="flex flex-wrap gap-2 mb-4">
            {[["all", "All"], ...USER_TYPES].map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setFilter(key)}
                className={`rounded-full px-3 py-1 text-xs font-semibold ${filter === key ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}
              >
                {label}
              </button>
            ))}
          </div>
          {loading ? (
            <div className="py-12 text-center"><Loader2 className="w-6 h-6 animate-spin text-slate-400 mx-auto" /></div>
          ) : shown.length === 0 ? (
            <p className="py-10 text-center text-sm text-slate-500">No reasons yet.</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {shown.map((row) => (
                <li key={row.id} className="flex items-center gap-3 py-3">
                  <span className="rounded bg-slate-100 px-2 py-0.5 text-[11px] font-semibold uppercase text-slate-600">
                    {LABEL[row.userType] || row.userType}
                  </span>
                  <span className={`flex-1 text-sm ${row.isActive ? "text-slate-800" : "text-slate-400 line-through"}`}>{row.reason}</span>
                  <button
                    type="button"
                    onClick={() => toggle(row)}
                    className={`rounded-lg border px-3 py-1 text-xs font-medium ${row.isActive ? "border-emerald-600 text-emerald-700" : "border-slate-300 text-slate-500"}`}
                  >
                    {row.isActive ? "On" : "Off"}
                  </button>
                  <button type="button" onClick={() => remove(row)} className="p-1.5 text-slate-400 hover:text-rose-600" aria-label={`Delete ${row.reason}`}>
                    <Trash2 className="w-4 h-4" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}
