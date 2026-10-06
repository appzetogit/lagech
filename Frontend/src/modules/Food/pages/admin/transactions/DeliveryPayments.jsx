import { useEffect, useState } from "react"
import { Loader2, Plus, Search, Send, X } from "@food/components/admin/theme/icons"
import { toast } from "sonner"
import { adminRiderExtrasAPI } from "@food/api/adminRiderExtras"
import { formatCurrency, formatDate } from "./DeliveryDisbursements"

export const PAYMENT_METHODS = [
  ["cash", "Cash"],
  ["bank_transfer", "Bank transfer"],
  ["upi", "UPI"],
  ["other", "Other"],
]
const methodLabel = (key) => PAYMENT_METHODS.find(([k]) => k === key)?.[1] || key

const SOURCES = {
  admin_payment: "Recorded here",
  balance_sheet: "Balance sheet",
}

const input =
  "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"

/** Find a delivery man by name or phone, showing what each can be paid now. */
function RiderPicker({ value, onChange }) {
  const [query, setQuery] = useState("")
  const [riders, setRiders] = useState([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let alive = true
    const timer = setTimeout(() => {
      setLoading(true)
      adminRiderExtrasAPI
        .getPayableRiders({ search: query.trim() || undefined, limit: 20 })
        .then((res) => alive && setRiders(res?.data?.data?.riders || []))
        .catch(() => alive && setRiders([]))
        .finally(() => alive && setLoading(false))
    }, 300)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [query])

  if (value) {
    return (
      <div className="flex items-center justify-between rounded-lg border border-slate-300 bg-slate-50 px-3 py-2">
        <div>
          <p className="text-sm font-semibold text-slate-800">{value.name}</p>
          <p className="text-xs text-slate-500">{value.phone} · can be paid up to {formatCurrency(value.balance)}</p>
        </div>
        <button type="button" onClick={() => onChange(null)} className="text-xs font-semibold text-blue-600">Change</button>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <div className="relative">
        <input className={`${input} pl-9`} placeholder="Search name or phone" value={query} onChange={(e) => setQuery(e.target.value)} />
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
      </div>
      <div className="max-h-48 overflow-y-auto rounded-lg border border-slate-200 divide-y divide-slate-100">
        {loading ? (
          <div className="py-4 text-center"><Loader2 className="w-4 h-4 animate-spin text-slate-400 mx-auto" /></div>
        ) : !riders.length ? (
          <p className="px-3 py-4 text-center text-xs text-slate-500">No approved delivery man matches.</p>
        ) : (
          riders.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => onChange(r)}
              className="flex w-full items-center justify-between px-3 py-2 text-left hover:bg-slate-50"
            >
              <span>
                <span className="block text-sm font-medium text-slate-800">{r.name}</span>
                <span className="block text-xs text-slate-500">{r.phone}</span>
              </span>
              <span className={`text-sm font-semibold ${r.balance > 0 ? "text-slate-900" : "text-slate-400"}`}>{formatCurrency(r.balance)}</span>
            </button>
          ))
        )}
      </div>
    </div>
  )
}

function PaymentForm({ onClose, onSaved }) {
  const [rider, setRider] = useState(null)
  const [form, setForm] = useState({ amount: "", method: "bank_transfer", reference: "", note: "" })
  const [saving, setSaving] = useState(false)
  const set = (key, value) => setForm((prev) => ({ ...prev, [key]: value }))

  const save = async (event) => {
    event.preventDefault()
    if (!rider) {
      toast.error("Choose a delivery man")
      return
    }
    if (Number(form.amount) > rider.balance) {
      toast.error(`${rider.name} can be paid at most ${formatCurrency(rider.balance)}`)
      return
    }
    try {
      setSaving(true)
      const res = await adminRiderExtrasAPI.recordPayment({ deliveryPartnerId: rider.id, ...form, amount: Number(form.amount) })
      const left = res?.data?.data?.remainingBalance
      toast.success(`Payment recorded. ${rider.name} can now be paid ${formatCurrency(left)}.`)
      onSaved()
    } catch (err) {
      toast.error(err?.response?.data?.message || "Failed to record the payment")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
      <form onSubmit={save} className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-xl bg-white p-6 shadow-xl space-y-4">
        <div className="flex items-start justify-between">
          <h3 className="text-lg font-bold text-slate-900">Record a payment</h3>
          <button type="button" onClick={onClose} aria-label="Close"><X className="w-5 h-5 text-slate-500" /></button>
        </div>
        <p className="text-sm text-slate-600">
          For money you have already given the delivery man. It is taken off their withdrawable balance, so it cannot
          be withdrawn or disbursed again.
        </p>
        <div className="space-y-1">
          <span className="block text-sm font-semibold text-slate-700">Delivery man <span className="text-red-500">*</span></span>
          <RiderPicker value={rider} onChange={setRider} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className="block space-y-1">
            <span className="text-sm font-semibold text-slate-700">Amount (₹) <span className="text-red-500">*</span></span>
            <input type="number" min="1" step="0.01" className={input} value={form.amount} onChange={(e) => set("amount", e.target.value)} required />
          </label>
          <label className="block space-y-1">
            <span className="text-sm font-semibold text-slate-700">Paid by <span className="text-red-500">*</span></span>
            <select className={input} value={form.method} onChange={(e) => set("method", e.target.value)}>
              {PAYMENT_METHODS.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
            </select>
          </label>
        </div>
        <label className="block space-y-1">
          <span className="text-sm font-semibold text-slate-700">Reference / UTR</span>
          <input className={input} maxLength={120} value={form.reference} onChange={(e) => set("reference", e.target.value)} />
        </label>
        <label className="block space-y-1">
          <span className="text-sm font-semibold text-slate-700">Note</span>
          <textarea className={input} rows={2} maxLength={500} value={form.note} onChange={(e) => set("note", e.target.value)} />
        </label>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">Cancel</button>
          <button type="submit" disabled={saving || !rider} className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60">
            {saving && <Loader2 className="w-4 h-4 animate-spin" />} Record payment
          </button>
        </div>
      </form>
    </div>
  )
}

/** Payments made to delivery men outside a disbursement ("provide payment" in the old panel). */
export default function DeliveryPayments() {
  const [payments, setPayments] = useState([])
  const [totalAmount, setTotalAmount] = useState(0)
  const [loading, setLoading] = useState(true)
  const [filters, setFilters] = useState({ search: "", method: "all", source: "", from: "", to: "" })
  const [search, setSearch] = useState("")
  const [page, setPage] = useState(1)
  const [pagination, setPagination] = useState({ total: 0, pages: 1 })
  const [adding, setAdding] = useState(false)

  useEffect(() => {
    const timer = setTimeout(() => {
      setFilters((f) => {
        if (f.search === search) return f
        setPage(1)
        return { ...f, search }
      })
    }, 400)
    return () => clearTimeout(timer)
  }, [search])

  const load = async () => {
    try {
      setLoading(true)
      const res = await adminRiderExtrasAPI.getPayments({
        page,
        limit: 20,
        search: filters.search.trim() || undefined,
        method: filters.method !== "all" ? filters.method : undefined,
        source: filters.source || undefined,
        from: filters.from || undefined,
        to: filters.to || undefined,
      })
      const data = res?.data?.data || {}
      setPayments(data.payments || [])
      setTotalAmount(data.totalAmount || 0)
      setPagination(data.pagination || { total: 0, pages: 1 })
    } catch (err) {
      toast.error(err?.response?.data?.message || "Failed to load payments")
      setPayments([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [page, filters])

  const setFilter = (key, value) => {
    setFilters((f) => ({ ...f, [key]: value }))
    setPage(1)
  }
  const filtered = Boolean(filters.search || filters.method !== "all" || filters.source || filters.from || filters.to)
  const small = "rounded-lg border border-slate-300 px-3 py-2 text-sm bg-white"

  return (
    <div className="p-4 lg:p-6 bg-slate-50 min-h-screen">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-3">
              <Send className="w-5 h-5 text-teal-700" />
              <h1 className="text-2xl font-bold text-slate-900">Delivery Man Payments</h1>
            </div>
            <p className="text-sm text-slate-600 mt-1 max-w-3xl">
              Money paid to delivery men by hand, recorded here or from the balance sheet. Each payment is taken off the
              delivery man's withdrawable balance.
            </p>
          </div>
          <button type="button" onClick={() => setAdding(true)} className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700">
            <Plus className="w-4 h-4" /> Record payment
          </button>
        </div>

        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
          <div className="flex flex-wrap items-end gap-3 mb-4">
            <div className="relative w-full sm:w-64">
              <input
                type="text"
                placeholder="Search name, phone or reference"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-9 pr-3 py-2 w-full text-sm rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            </div>
            <select className={small} value={filters.method} onChange={(e) => setFilter("method", e.target.value)} aria-label="Payment method">
              <option value="all">All methods</option>
              {PAYMENT_METHODS.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
            </select>
            <select className={small} value={filters.source} onChange={(e) => setFilter("source", e.target.value)} aria-label="Recorded from">
              <option value="">Recorded anywhere</option>
              {Object.entries(SOURCES).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
            </select>
            <label className="space-y-1">
              <span className="block text-[11px] font-semibold uppercase tracking-wide text-slate-500">From</span>
              <input type="date" className={small} value={filters.from} onChange={(e) => setFilter("from", e.target.value)} />
            </label>
            <label className="space-y-1">
              <span className="block text-[11px] font-semibold uppercase tracking-wide text-slate-500">To</span>
              <input type="date" className={small} value={filters.to} onChange={(e) => setFilter("to", e.target.value)} />
            </label>
            <div className="ml-auto text-right">
              <p className="text-xs text-slate-500">{pagination.total} payment(s)</p>
              <p className="text-lg font-bold text-slate-900">{formatCurrency(totalAmount)}</p>
            </div>
          </div>

          {loading ? (
            <div className="py-16 text-center"><Loader2 className="w-7 h-7 animate-spin text-teal-600 mx-auto" /></div>
          ) : !payments.length ? (
            <p className="py-16 text-center text-sm text-slate-500">
              {filtered ? "No payment matches these filters." : "No payments to delivery men have been recorded yet."}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-slate-50 border-b border-slate-200">
                  <tr>
                    {["Date", "Delivery man", "Amount", "Paid by", "Reference", "Note", "Recorded from"].map((h) => (
                      <th key={h} className="px-4 py-3 text-left text-[10px] font-bold text-slate-700 uppercase tracking-wider">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {payments.map((p) => (
                    <tr key={p.id} className="hover:bg-slate-50 align-top">
                      <td className="px-4 py-3 text-sm text-slate-700 whitespace-nowrap">{formatDate(p.createdAt)}</td>
                      <td className="px-4 py-3 text-sm">
                        <p className="font-semibold text-slate-800">{p.deliveryName}</p>
                        <p className="text-xs text-slate-500">{p.deliveryPhone}</p>
                      </td>
                      <td className="px-4 py-3 text-sm font-semibold text-slate-900 whitespace-nowrap">{formatCurrency(p.amount)}</td>
                      <td className="px-4 py-3 text-sm text-slate-700">{methodLabel(p.method)}</td>
                      <td className="px-4 py-3 text-xs font-mono text-slate-700">{p.reference || "—"}</td>
                      <td className="px-4 py-3 text-xs text-slate-600 max-w-[240px] break-words">{p.note || "—"}</td>
                      <td className="px-4 py-3 text-xs text-slate-600">{SOURCES[p.source] || p.source}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {pagination.pages > 1 && (
            <div className="flex items-center justify-between mt-4 pt-4 border-t border-slate-200">
              <p className="text-sm text-slate-600">Page {page} of {pagination.pages}</p>
              <div className="flex gap-2">
                <button type="button" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1} className="px-4 py-2 text-sm rounded-lg border border-slate-300 disabled:opacity-50">Previous</button>
                <button type="button" onClick={() => setPage((p) => Math.min(pagination.pages, p + 1))} disabled={page >= pagination.pages} className="px-4 py-2 text-sm rounded-lg border border-slate-300 disabled:opacity-50">Next</button>
              </div>
            </div>
          )}
        </div>
      </div>
      {adding && (
        <PaymentForm
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false)
            setPage(1)
            load()
          }}
        />
      )}
    </div>
  )
}
