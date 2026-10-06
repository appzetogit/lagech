import { useEffect, useState } from "react"
import { Loader2, Medal, RotateCcw, Settings } from "@food/components/admin/theme/icons"
import { toast } from "sonner"
import {
  customerExtrasAPI,
  dataOf,
  errorMessage,
  formatDateTime,
  formatMoney,
} from "@food/api/adminCustomerExtras"
import { CustomerPicker, PageHeader, Pager, StatCard, inputClass } from "../wallet/shared"

const EMPTY = { from: "", to: "", type: "" }

/** How customers earn and convert points. Saved where the other reward settings live. */
function LoyaltySettings({ onSaved }) {
  const [form, setForm] = useState(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    customerExtrasAPI
      .getLoyaltySettings()
      .then((res) => {
        const s = dataOf(res).settings || {}
        setForm({
          isEnabled: Boolean(s.isEnabled),
          pointsPerHundred: s.pointsPerHundred ? String(s.pointsPerHundred) : "",
          pointsPerRupee: s.pointsPerRupee ? String(s.pointsPerRupee) : "",
          minimumConvertPoints: s.minimumConvertPoints ? String(s.minimumConvertPoints) : "",
        })
      })
      .catch((err) => toast.error(errorMessage(err, "Could not load the loyalty settings")))
  }, [])

  if (!form) {
    return <div className="rounded-xl border border-slate-200 bg-white p-6 text-center shadow-sm"><Loader2 className="mx-auto h-5 w-5 animate-spin text-slate-400" /></div>
  }

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }))
  const save = async (e) => {
    e.preventDefault()
    try {
      setSaving(true)
      await customerExtrasAPI.saveLoyaltySettings({
        isEnabled: form.isEnabled,
        pointsPerHundred: form.pointsPerHundred || 0,
        pointsPerRupee: form.pointsPerRupee || 0,
        minimumConvertPoints: form.minimumConvertPoints || 0,
      })
      toast.success("Loyalty settings saved")
      onSaved?.()
    } catch (err) {
      toast.error(errorMessage(err, "Could not save the loyalty settings"))
    } finally {
      setSaving(false)
    }
  }

  const perHundred = Number(form.pointsPerHundred) || 0
  const perRupee = Number(form.pointsPerRupee) || 0

  return (
    <form onSubmit={save} className="space-y-4 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-base font-semibold text-slate-900"><Settings className="h-4 w-4 text-slate-500" /> Settings</h2>
        <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
          <input type="checkbox" checked={form.isEnabled} onChange={(e) => set("isEnabled", e.target.checked)} /> Customers earn loyalty points
        </label>
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        <label className="block space-y-1">
          <span className="text-xs font-semibold text-slate-600">Points earned per ₹100 spent</span>
          <input type="number" min="0" step="0.01" className={inputClass} value={form.pointsPerHundred} onChange={(e) => set("pointsPerHundred", e.target.value)} />
        </label>
        <label className="block space-y-1">
          <span className="text-xs font-semibold text-slate-600">Points needed for ₹1 of wallet balance</span>
          <input type="number" min="0" step="1" className={inputClass} value={form.pointsPerRupee} onChange={(e) => set("pointsPerRupee", e.target.value)} />
        </label>
        <label className="block space-y-1">
          <span className="text-xs font-semibold text-slate-600">Minimum points to convert</span>
          <input type="number" min="0" step="1" className={inputClass} value={form.minimumConvertPoints} onChange={(e) => set("minimumConvertPoints", e.target.value)} />
        </label>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-slate-500">
          {perHundred > 0 && perRupee > 0
            ? `A delivered ₹500 order earns ${Math.floor(5 * perHundred)} points, worth ${formatMoney(Math.floor((5 * perHundred) / perRupee * 100) / 100)} in the wallet.`
            : "Points are credited when an order is delivered and customers convert them into wallet balance from the app."}
        </p>
        <button type="submit" disabled={saving} className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60">
          {saving && <Loader2 className="h-4 w-4 animate-spin" />} Save settings
        </button>
      </div>
    </form>
  )
}

/** The points ledger across customers (old panel: Customer Loyalty Point → Report). */
export default function LoyaltyPointReport() {
  const [filters, setFilters] = useState(EMPTY)
  const [customer, setCustomer] = useState(null)
  const [page, setPage] = useState(1)
  const [reload, setReload] = useState(0)
  const [loading, setLoading] = useState(true)
  const [data, setData] = useState({ transactions: [], totals: null, pagination: null })

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        setLoading(true)
        const params = { page, limit: 25 }
        for (const [k, v] of Object.entries(filters)) if (v) params[k] = v
        if (customer) params.userId = customer.id
        const res = await customerExtrasAPI.getLoyaltyTransactions(params)
        if (!cancelled) setData(dataOf(res))
      } catch (err) {
        if (!cancelled) {
          toast.error(errorMessage(err, "Could not load the loyalty point report"))
          setData({ transactions: [], totals: null, pagination: null })
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [filters, customer, page, reload])

  const set = (key, value) => {
    setPage(1)
    setFilters((f) => ({ ...f, [key]: value }))
  }
  const filtered = Boolean(customer || Object.values(filters).some(Boolean))
  const totals = data.totals || { earned: 0, converted: 0, walletPaid: 0, outstanding: 0 }
  const rows = data.transactions || []

  return (
    <div className="min-h-screen bg-slate-50 p-4 lg:p-6">
      <div className="mx-auto max-w-7xl space-y-6">
        <PageHeader icon={Medal} title="Loyalty Point Report" description="Points customers earned on delivered orders and converted into wallet balance." />

        <LoyaltySettings onSaved={() => setReload((n) => n + 1)} />

        <div className="space-y-4 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
            <label className="block space-y-1 xl:col-span-2">
              <span className="text-xs font-semibold text-slate-600">Customer</span>
              <CustomerPicker value={customer} onChange={(c) => { setPage(1); setCustomer(c) }} placeholder="All customers — search to pick one" />
            </label>
            <label className="block space-y-1">
              <span className="text-xs font-semibold text-slate-600">From</span>
              <input type="date" className={inputClass} value={filters.from} max={filters.to || undefined} onChange={(e) => set("from", e.target.value)} />
            </label>
            <label className="block space-y-1">
              <span className="text-xs font-semibold text-slate-600">To</span>
              <input type="date" className={inputClass} value={filters.to} min={filters.from || undefined} onChange={(e) => set("to", e.target.value)} />
            </label>
            <label className="block space-y-1">
              <span className="text-xs font-semibold text-slate-600">Type</span>
              <select className={inputClass} value={filters.type} onChange={(e) => set("type", e.target.value)}>
                <option value="">All</option>
                <option value="credit">Earned</option>
                <option value="debit">Converted</option>
              </select>
            </label>
          </div>
          {filtered && (
            <button type="button" onClick={() => { setFilters(EMPTY); setCustomer(null); setPage(1) }} className="inline-flex items-center gap-1.5 text-sm font-medium text-blue-600 hover:underline">
              <RotateCcw className="h-3.5 w-3.5" /> Clear filters
            </button>
          )}
        </div>

        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard label="Points earned" value={Number(totals.earned).toLocaleString("en-IN")} hint={filtered ? "For the filters above" : "All time"} tone="green" />
          <StatCard label="Points converted" value={Number(totals.converted).toLocaleString("en-IN")} hint={filtered ? "For the filters above" : "All time"} tone="red" />
          <StatCard label="Paid into wallets" value={formatMoney(totals.walletPaid)} hint="From conversions" tone="blue" />
          <StatCard label="Points customers hold now" value={Number(totals.outstanding).toLocaleString("en-IN")} hint="All customers" />
        </div>

        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          {loading ? (
            <div className="py-16 text-center"><Loader2 className="mx-auto h-6 w-6 animate-spin text-slate-400" /></div>
          ) : !rows.length ? (
            <p className="py-16 text-center text-sm text-slate-500">
              {filtered ? "No loyalty point transactions match these filters." : "No loyalty points have been earned or converted yet."}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-left text-xs font-semibold text-slate-600">
                  <tr>
                    <th className="px-4 py-3">Date</th>
                    <th className="px-4 py-3">Customer</th>
                    <th className="px-4 py-3">Type</th>
                    <th className="px-4 py-3">Details</th>
                    <th className="px-4 py-3 text-right">Points</th>
                    <th className="px-4 py-3 text-right">Wallet amount</th>
                    <th className="px-4 py-3 text-right">Points after</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {rows.map((t) => (
                    <tr key={t.id}>
                      <td className="whitespace-nowrap px-4 py-3 text-slate-600">{formatDateTime(t.createdAt)}</td>
                      <td className="px-4 py-3">
                        <div className="font-medium text-slate-800">{t.customer?.name || "Unnamed customer"}</div>
                        <div className="text-xs text-slate-500">{t.customer?.phone}</div>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${t.type === "credit" ? "bg-emerald-100 text-emerald-800" : "bg-rose-100 text-rose-800"}`}>
                          {t.type === "credit" ? "Earned" : "Converted"}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-slate-600">{t.note || "—"}</td>
                      <td className={`whitespace-nowrap px-4 py-3 text-right font-semibold ${t.type === "credit" ? "text-emerald-700" : "text-rose-700"}`}>
                        {t.type === "credit" ? "+" : "−"}{Number(t.points).toLocaleString("en-IN")}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-right text-slate-700">{t.walletAmount > 0 ? formatMoney(t.walletAmount) : "—"}</td>
                      <td className="whitespace-nowrap px-4 py-3 text-right text-slate-700">{Number(t.balanceAfter).toLocaleString("en-IN")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <Pager pagination={data.pagination} onPage={setPage} />
        </div>
      </div>
    </div>
  )
}
