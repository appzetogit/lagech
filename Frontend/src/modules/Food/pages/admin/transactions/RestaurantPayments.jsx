import { useEffect, useMemo, useState } from "react"
import { Download, Loader2, Plus, Search, Send, X } from "lucide-react"
import { toast } from "sonner"
import { adminAPI } from "@food/api"
import { adminSystemExtrasAPI } from "@food/api/adminSystemExtras"
import { PageFrame, Card, Field, Loading, inputClass, errorMessage, formatDateTime } from "../system/SettingsUi"
import { downloadCsv, rupees } from "../reports/ReportShell"

const METHODS = [
  ["bank_transfer", "Bank transfer"],
  ["upi", "UPI"],
  ["cash", "Cash"],
  ["cheque", "Cheque"],
  ["other", "Other"],
]
const methodLabel = (value) => METHODS.find(([key]) => key === value)?.[1] || value

const newKey = () =>
  (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`)

function PayeeDetails({ payable }) {
  const bank = payable?.bank || {}
  const rows = [
    ["Account holder", bank.accountHolderName],
    ["Account number", bank.accountNumber],
    ["IFSC", bank.ifscCode],
    ["UPI id", bank.upiId],
  ].filter(([, value]) => value)
  const method = payable?.payoutMethod
  if (!rows.length && !method) return <p className="text-xs text-amber-700">This restaurant has no bank, UPI or payout method details on file.</p>
  return (
    <div className="grid gap-3 sm:grid-cols-2 text-xs">
      {rows.length > 0 && (
        <div className="rounded-lg bg-slate-50 p-3 space-y-1">
          <p className="font-semibold text-slate-700">Bank and UPI</p>
          {rows.map(([label, value]) => <p key={label} className="text-slate-600">{label}: <span className="font-medium text-slate-900">{value}</span></p>)}
        </div>
      )}
      {method && (
        <div className="rounded-lg bg-slate-50 p-3 space-y-1">
          <p className="font-semibold text-slate-700">{method.methodName}</p>
          {method.fields.map((f) => <p key={f.key} className="text-slate-600">{f.label}: <span className="font-medium text-slate-900">{f.value}</span></p>)}
        </div>
      )}
    </div>
  )
}

function PaymentForm({ restaurants, onClose, onSaved }) {
  const [form, setForm] = useState({ restaurantId: "", amount: "", method: "bank_transfer", reference: "", note: "" })
  const [requestKey] = useState(newKey)
  const [payable, setPayable] = useState(null)
  const [loadingPayable, setLoadingPayable] = useState(false)
  const [saving, setSaving] = useState(false)
  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }))

  useEffect(() => {
    if (!form.restaurantId) {
      setPayable(null)
      return
    }
    let alive = true
    setLoadingPayable(true)
    adminSystemExtrasAPI
      .getRestaurantPayable(form.restaurantId)
      .then((res) => alive && setPayable(res?.data?.data || null))
      .catch((err) => alive && toast.error(errorMessage(err, "Failed to load the balance")))
      .finally(() => alive && setLoadingPayable(false))
    return () => {
      alive = false
    }
  }, [form.restaurantId])

  const amount = Number(form.amount)
  const tooMuch = payable && amount > payable.payable

  const save = async (e) => {
    e.preventDefault()
    try {
      setSaving(true)
      await adminSystemExtrasAPI.recordRestaurantPayment({ ...form, amount: form.amount, requestKey })
      toast.success("Payment recorded")
      onSaved()
    } catch (err) {
      toast.error(errorMessage(err, "Failed to record the payment"))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
      <form onSubmit={save} className="w-full max-w-xl max-h-[90vh] overflow-y-auto rounded-xl bg-white p-6 shadow-xl space-y-4">
        <div className="flex items-start justify-between">
          <div>
            <h3 className="text-lg font-bold text-slate-900">Record a payment</h3>
            <p className="text-xs text-slate-500 mt-0.5">For money already sent to the restaurant outside the app. It comes off what the restaurant is owed.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close"><X className="w-5 h-5 text-slate-500" /></button>
        </div>
        <Field label="Restaurant">
          <select className={inputClass} value={form.restaurantId} onChange={(e) => set("restaurantId", e.target.value)} required>
            <option value="">Choose a restaurant</option>
            {restaurants.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </Field>
        {loadingPayable && <p className="text-xs text-slate-500"><Loader2 className="inline w-3 h-3 animate-spin" /> Loading balance…</p>}
        {payable && !loadingPayable && (
          <div className="space-y-3">
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="rounded-lg border border-teal-600 bg-teal-50 p-2"><p className="text-[11px] text-slate-500">Payable now</p><p className="font-bold text-slate-900">{rupees(payable.payable)}</p></div>
              <div className="rounded-lg border border-slate-200 p-2"><p className="text-[11px] text-slate-500">Held for dues</p><p className="font-bold text-slate-900">{rupees(payable.lockedAmount)}</p></div>
              <div className="rounded-lg border border-slate-200 p-2"><p className="text-[11px] text-slate-500">Requests waiting</p><p className="font-bold text-slate-900">{payable.pendingRequests.count} · {rupees(payable.pendingRequests.amount)}</p></div>
            </div>
            <PayeeDetails payable={payable} />
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Amount (₹)">
            <input type="number" min="0.01" step="0.01" className={inputClass} value={form.amount} onChange={(e) => set("amount", e.target.value)} required />
          </Field>
          <Field label="Paid by">
            <select className={inputClass} value={form.method} onChange={(e) => set("method", e.target.value)}>
              {METHODS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </Field>
        </div>
        {tooMuch && <p className="text-xs text-red-600">That is more than the restaurant is owed.</p>}
        <Field label="Reference" hint="Bank or UPI transaction id. One reference can be recorded once per restaurant.">
          <input className={inputClass} maxLength={120} value={form.reference} onChange={(e) => set("reference", e.target.value)} />
        </Field>
        <Field label="Note">
          <textarea className={inputClass} rows={2} maxLength={500} value={form.note} onChange={(e) => set("note", e.target.value)} />
        </Field>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-lg border border-slate-300 px-4 py-2 text-sm">Cancel</button>
          <button type="submit" disabled={saving || !form.restaurantId || !(amount > 0) || tooMuch} className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60">
            {saving && <Loader2 className="w-4 h-4 animate-spin" />} Record payment
          </button>
        </div>
      </form>
    </div>
  )
}

const CSV_COLUMNS = [
  { key: "paidAt", label: "Paid on", csv: (r) => formatDateTime(r.paidAt) },
  { key: "restaurantName", label: "Restaurant" },
  { key: "amount", label: "Amount" },
  { key: "method", label: "Method", csv: (r) => methodLabel(r.method) },
  { key: "reference", label: "Reference" },
  { key: "note", label: "Note" },
]

/** The old panel's "Store payments": payments made to restaurants by hand. */
export default function RestaurantPayments() {
  const [restaurants, setRestaurants] = useState([])
  const [filters, setFilters] = useState({ restaurantId: "", method: "", from: "", to: "", search: "" })
  const [search, setSearch] = useState("")
  const [page, setPage] = useState(1)
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState(false)
  const [exporting, setExporting] = useState(false)

  useEffect(() => {
    adminAPI
      .getRestaurants({ limit: 1000 })
      .then((res) => {
        const d = res?.data?.data || {}
        const list = d.restaurants || d.items || d.docs || (Array.isArray(d) ? d : [])
        setRestaurants(list.map((r) => ({ id: r.id || r._id, name: r.restaurantName || r.name })).filter((r) => r.id))
      })
      .catch(() => setRestaurants([]))
  }, [])

  const params = useMemo(
    () => Object.fromEntries(Object.entries(filters).filter(([, v]) => v)),
    [filters],
  )

  const load = async () => {
    try {
      setLoading(true)
      const res = await adminSystemExtrasAPI.getRestaurantPayments({ ...params, page, limit: 25 })
      setData(res?.data?.data || null)
    } catch (err) {
      toast.error(errorMessage(err, "Failed to load payments"))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [params, page])

  const setFilter = (key, value) => {
    setFilters((f) => ({ ...f, [key]: value }))
    setPage(1)
  }

  const exportCsv = async () => {
    try {
      setExporting(true)
      const res = await adminSystemExtrasAPI.getRestaurantPayments({ ...params, page: 1, limit: 500 })
      downloadCsv("restaurant-payments.csv", CSV_COLUMNS, res?.data?.data?.payments || [])
    } catch {
      toast.error("Export failed")
    } finally {
      setExporting(false)
    }
  }

  const rows = data?.payments || []
  const pages = data?.pagination?.pages || 1

  return (
    <PageFrame
      icon={Send}
      title="Restaurant Payments"
      description="Payments sent to restaurants outside the app, recorded here so they come off what each restaurant is owed. The restaurant sees them in its withdrawal history."
      actions={
        <button type="button" onClick={() => setAdding(true)} className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700">
          <Plus className="w-4 h-4" /> Record payment
        </button>
      }
    >
      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Restaurant">
            <select className={inputClass} value={filters.restaurantId} onChange={(e) => setFilter("restaurantId", e.target.value)}>
              <option value="">All restaurants</option>
              {restaurants.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </Field>
          <Field label="Method">
            <select className={inputClass} value={filters.method} onChange={(e) => setFilter("method", e.target.value)}>
              <option value="">All</option>
              {METHODS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </Field>
          <Field label="From"><input type="date" className={inputClass} value={filters.from} onChange={(e) => setFilter("from", e.target.value)} /></Field>
          <Field label="To"><input type="date" className={inputClass} value={filters.to} onChange={(e) => setFilter("to", e.target.value)} /></Field>
          <form onSubmit={(e) => { e.preventDefault(); setFilter("search", search.trim()) }} className="flex items-end gap-2">
            <Field label="Search">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                <input className={`${inputClass} pl-9`} placeholder="Restaurant or reference" value={search} onChange={(e) => setSearch(e.target.value)} />
              </div>
            </Field>
          </form>
          <button type="button" onClick={exportCsv} disabled={exporting || !rows.length} className="ml-auto inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50">
            {exporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />} Export CSV
          </button>
        </div>
      </Card>

      {data && (
        <div className="grid grid-cols-2 gap-4 max-w-xl">
          <div className="rounded-xl border border-slate-200 bg-white p-4"><p className="text-xs font-medium text-slate-500">Payments</p><p className="mt-1 text-xl font-bold text-slate-900">{data.totals.count}</p></div>
          <div className="rounded-xl border border-teal-600 bg-teal-50 p-4"><p className="text-xs font-medium text-slate-500">Total paid</p><p className="mt-1 text-xl font-bold text-slate-900">{rupees(data.totals.amount)}</p></div>
        </div>
      )}

      <Card>
        {loading ? (
          <Loading />
        ) : !rows.length ? (
          <p className="py-12 text-center text-sm text-slate-500">No payments recorded for these filters.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr>
                  {["Paid on", "Restaurant", "Amount", "Method", "Reference", "Note"].map((h) => (
                    <th key={h} className={`px-4 py-3 text-xs font-semibold text-slate-700 ${h === "Amount" ? "text-right" : "text-left"}`}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((row) => (
                  <tr key={row.id} className="hover:bg-slate-50">
                    <td className="px-4 py-3 text-sm text-slate-600 whitespace-nowrap">{formatDateTime(row.paidAt)}</td>
                    <td className="px-4 py-3 text-sm font-medium text-slate-900">{row.restaurantName}</td>
                    <td className="px-4 py-3 text-sm font-semibold text-slate-900 text-right whitespace-nowrap">{rupees(row.amount)}</td>
                    <td className="px-4 py-3 text-sm text-slate-600">{methodLabel(row.method)}</td>
                    <td className="px-4 py-3 text-sm text-slate-600">{row.reference || "—"}</td>
                    <td className="px-4 py-3 text-xs text-slate-500 max-w-xs">{row.note || "—"}</td>
                  </tr>
                ))}
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
      </Card>

      {adding && (
        <PaymentForm
          restaurants={restaurants}
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false)
            setPage(1)
            load()
          }}
        />
      )}
    </PageFrame>
  )
}
