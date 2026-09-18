import { useEffect, useState } from "react"
import { IndianRupee, Loader2, Save } from "lucide-react"
import { toast } from "sonner"
import { adminAPI } from "@food/api"

const EMPTY = {
  isEnabled: false,
  cashbackType: "percentage",
  cashbackValue: "",
  minOrderValue: "",
  maxCashback: "",
  firstOrderOnly: false,
  perUserLimit: "",
}

const fromSaved = (saved = {}) => ({
  isEnabled: Boolean(saved.isEnabled),
  cashbackType: saved.cashbackType === "flat" ? "flat" : "percentage",
  cashbackValue: saved.cashbackValue != null ? String(Number(saved.cashbackValue)) : "",
  minOrderValue: saved.minOrderValue != null ? String(Number(saved.minOrderValue)) : "",
  maxCashback: saved.maxCashback != null ? String(Number(saved.maxCashback)) : "",
  firstOrderOnly: Boolean(saved.firstOrderOnly),
  perUserLimit: saved.perUserLimit != null ? String(Number(saved.perUserLimit)) : "",
})

/** What a sample order would earn, the same way the server works it out. */
const previewFor = (form, subtotal) => {
  if (!form.isEnabled) return 0
  if (subtotal < (Number(form.minOrderValue) || 0)) return 0
  const value = Number(form.cashbackValue) || 0
  let amount = form.cashbackType === "flat" ? value : (subtotal * value) / 100
  const cap = Number(form.maxCashback) || 0
  if (form.cashbackType === "percentage" && cap > 0) amount = Math.min(amount, cap)
  return Math.max(0, Math.floor(amount))
}

/**
 * Cashback credited to a customer's wallet when their order is delivered.
 * One rule for the whole platform, as the server applies it.
 */
export default function Cashback() {
  const [form, setForm] = useState(EMPTY)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    adminAPI
      .getCashbackSettings()
      .then((res) => setForm(fromSaved(res?.data?.data?.cashbackSettings)))
      .catch(() => toast.error("Failed to load cashback settings"))
      .finally(() => setLoading(false))
  }, [])

  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }))

  const save = async (e) => {
    e.preventDefault()
    const value = Number(form.cashbackValue)
    if (form.isEnabled && !(value > 0)) return toast.error("Enter a cashback amount above 0")
    if (form.cashbackType === "percentage" && value > 100) return toast.error("A percentage cannot be over 100")
    try {
      setSaving(true)
      const res = await adminAPI.updateCashbackSettings({
        isEnabled: form.isEnabled,
        cashbackType: form.cashbackType,
        cashbackValue: Number(form.cashbackValue) || 0,
        minOrderValue: Number(form.minOrderValue) || 0,
        maxCashback: Number(form.maxCashback) || 0,
        firstOrderOnly: form.firstOrderOnly,
        perUserLimit: Number(form.perUserLimit) || 0,
      })
      setForm(fromSaved(res?.data?.data?.cashbackSettings))
      toast.success(form.isEnabled ? "Cashback saved and switched on" : "Cashback saved (switched off)")
    } catch (err) {
      toast.error(err?.response?.data?.message || "Failed to save cashback settings")
    } finally {
      setSaving(false)
    }
  }

  const input = "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
  const percent = form.cashbackType === "percentage"

  return (
    <div className="p-4 lg:p-6 bg-slate-50 min-h-screen">
      <form onSubmit={save} className="max-w-3xl mx-auto space-y-6">
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
          <div className="flex items-center gap-3">
            <IndianRupee className="w-5 h-5 text-emerald-600" />
            <h1 className="text-2xl font-bold text-slate-900">Cashback</h1>
          </div>
          <p className="text-sm text-slate-600 mt-1">
            Money credited to the customer's Lagech wallet when their order is delivered, to spend on a later order.
          </p>
        </div>

        {loading ? (
          <div className="py-12 text-center"><Loader2 className="w-6 h-6 animate-spin text-slate-400 mx-auto" /></div>
        ) : (
          <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 space-y-5">
            <label className="flex items-center justify-between gap-4">
              <span>
                <span className="block text-sm font-semibold text-slate-800">Give cashback</span>
                <span className="block text-xs text-slate-500">Off: no order earns cashback.</span>
              </span>
              <input type="checkbox" className="h-5 w-5" checked={form.isEnabled} onChange={(e) => set("isEnabled", e.target.checked)} />
            </label>

            <div className="grid gap-4 sm:grid-cols-2">
              <label className="space-y-1">
                <span className="text-xs font-semibold text-slate-600">Type</span>
                <select className={input} value={form.cashbackType} onChange={(e) => set("cashbackType", e.target.value)}>
                  <option value="percentage">Percentage of the food total</option>
                  <option value="flat">Flat amount</option>
                </select>
              </label>
              <label className="space-y-1">
                <span className="text-xs font-semibold text-slate-600">{percent ? "Cashback (%)" : "Cashback (₹)"}</span>
                <input type="number" min="0" max={percent ? 100 : undefined} step="0.01" className={input} value={form.cashbackValue} onChange={(e) => set("cashbackValue", e.target.value)} />
              </label>
              <label className="space-y-1">
                <span className="text-xs font-semibold text-slate-600">Minimum food total (₹)</span>
                <input type="number" min="0" className={input} value={form.minOrderValue} onChange={(e) => set("minOrderValue", e.target.value)} />
              </label>
              {percent && (
                <label className="space-y-1">
                  <span className="text-xs font-semibold text-slate-600">Most per order (₹, 0 = no cap)</span>
                  <input type="number" min="0" className={input} value={form.maxCashback} onChange={(e) => set("maxCashback", e.target.value)} />
                </label>
              )}
              <label className="space-y-1">
                <span className="text-xs font-semibold text-slate-600">Times each customer can earn it (0 = unlimited)</span>
                <input type="number" min="0" step="1" className={input} value={form.perUserLimit} onChange={(e) => set("perUserLimit", e.target.value)} />
              </label>
              <label className="flex items-center gap-2 pt-6 text-sm text-slate-700">
                <input type="checkbox" checked={form.firstOrderOnly} onChange={(e) => set("firstOrderOnly", e.target.checked)} />
                Only on a customer's first order
              </label>
            </div>

            <div className="rounded-lg bg-slate-50 border border-slate-200 p-3 text-sm text-slate-700">
              Example: a ₹300 order earns <strong>₹{previewFor(form, 300)}</strong>, a ₹800 order earns <strong>₹{previewFor(form, 800)}</strong>.
            </div>

            <button
              type="submit"
              disabled={saving}
              className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
            >
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              Save
            </button>
          </div>
        )}
      </form>
    </div>
  )
}
