import { useEffect, useState } from "react"
import { useSearchParams } from "react-router-dom"
import { FileText, Loader2, RotateCcw } from "lucide-react"
import { toast } from "sonner"
import {
  customerExtrasAPI,
  dataOf,
  errorMessage,
  formatDateTime,
  formatMoney,
} from "@food/api/adminCustomerExtras"
import { CustomerPicker, PageHeader, Pager, StatCard, inputClass } from "./shared"

const SOURCES = [
  { key: "add_fund", label: "Added by admin" },
  { key: "top_up", label: "Top-up" },
  { key: "bonus", label: "Top-up bonus" },
  { key: "cashback", label: "Cashback" },
  { key: "loyalty_point", label: "Loyalty points" },
  { key: "refund", label: "Refund" },
  { key: "order_payment", label: "Order payment" },
  { key: "referral", label: "Referral reward" },
]

const EMPTY = { from: "", to: "", type: "", source: "" }

/** Customer wallet transactions across all customers (old panel: Customer Wallet → Report). */
export default function WalletReport() {
  const [searchParams] = useSearchParams()
  const [filters, setFilters] = useState({ ...EMPTY, source: searchParams.get("source") || "" })
  const [customer, setCustomer] = useState(null)
  const [page, setPage] = useState(1)
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
        const res = await customerExtrasAPI.getWalletTransactions(params)
        if (!cancelled) setData(dataOf(res))
      } catch (err) {
        if (!cancelled) {
          toast.error(errorMessage(err, "Could not load the wallet report"))
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
  }, [filters, customer, page])

  const set = (key, value) => {
    setPage(1)
    setFilters((f) => ({ ...f, [key]: value }))
  }

  const filtered = Boolean(customer || Object.values(filters).some(Boolean))
  const totals = data.totals || { credit: 0, debit: 0, net: 0, creditCount: 0, debitCount: 0 }
  const rows = data.transactions || []

  return (
    <div className="min-h-screen bg-slate-50 p-4 lg:p-6">
      <div className="mx-auto max-w-7xl space-y-6">
        <PageHeader icon={FileText} title="Customer Wallet Report" description="Every credit and debit on customer wallets: top-ups, bonuses, refunds, cashback, admin credits and order payments." />

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
            <div className="grid grid-cols-2 gap-3">
              <label className="block space-y-1">
                <span className="text-xs font-semibold text-slate-600">Type</span>
                <select className={inputClass} value={filters.type} onChange={(e) => set("type", e.target.value)}>
                  <option value="">All</option>
                  <option value="credit">Credit</option>
                  <option value="debit">Debit</option>
                </select>
              </label>
              <label className="block space-y-1">
                <span className="text-xs font-semibold text-slate-600">Source</span>
                <select className={inputClass} value={filters.source} onChange={(e) => set("source", e.target.value)}>
                  <option value="">All</option>
                  {SOURCES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                </select>
              </label>
            </div>
          </div>
          {filtered && (
            <button type="button" onClick={() => { setFilters(EMPTY); setCustomer(null); setPage(1) }} className="inline-flex items-center gap-1.5 text-sm font-medium text-blue-600 hover:underline">
              <RotateCcw className="h-3.5 w-3.5" /> Clear filters
            </button>
          )}
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <StatCard label="Credited" value={formatMoney(totals.credit)} hint={`${totals.creditCount} entries`} tone="green" />
          <StatCard label="Debited" value={formatMoney(totals.debit)} hint={`${totals.debitCount} entries`} tone="red" />
          <StatCard label="Net" value={formatMoney(totals.net)} hint={filtered ? "For the filters above" : "All customers, all time"} />
        </div>

        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          {loading ? (
            <div className="py-16 text-center"><Loader2 className="mx-auto h-6 w-6 animate-spin text-slate-400" /></div>
          ) : !rows.length ? (
            <p className="py-16 text-center text-sm text-slate-500">
              {filtered ? "No wallet transactions match these filters." : "No customer wallet transactions yet."}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-left text-xs font-semibold text-slate-600">
                  <tr>
                    <th className="px-4 py-3">Date</th>
                    <th className="px-4 py-3">Customer</th>
                    <th className="px-4 py-3">Source</th>
                    <th className="px-4 py-3">Details</th>
                    <th className="px-4 py-3 text-right">Credit</th>
                    <th className="px-4 py-3 text-right">Debit</th>
                    <th className="px-4 py-3 text-right">Balance after</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {rows.map((t) => (
                    <tr key={t.id} className="align-top">
                      <td className="whitespace-nowrap px-4 py-3 text-slate-600">{formatDateTime(t.createdAt)}</td>
                      <td className="px-4 py-3">
                        <div className="font-medium text-slate-800">{t.customer?.name || "Unnamed customer"}</div>
                        <div className="text-xs text-slate-500">{t.customer?.phone}</div>
                      </td>
                      <td className="whitespace-nowrap px-4 py-3">
                        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">{t.sourceLabel}</span>
                      </td>
                      <td className="px-4 py-3 text-slate-600">
                        <div>{t.description || "—"}</div>
                        {t.addedBy && <div className="text-xs text-slate-500">By {t.addedBy}</div>}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-right font-semibold text-emerald-700">{t.type === "credit" ? formatMoney(t.amount) : ""}</td>
                      <td className="whitespace-nowrap px-4 py-3 text-right font-semibold text-rose-700">{t.type === "debit" ? formatMoney(t.amount) : ""}</td>
                      <td className="whitespace-nowrap px-4 py-3 text-right text-slate-700">{formatMoney(t.balanceAfter)}</td>
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
