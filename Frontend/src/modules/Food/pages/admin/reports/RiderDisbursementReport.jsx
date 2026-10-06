import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { Eye, Loader2, PiggyBank, X } from "@food/components/admin/theme/icons"
import { toast } from "sonner"
import { adminSystemExtrasAPI } from "@food/api/adminSystemExtras"
import { rupees } from "./ReportShell"
import ExportMenu from "@food/components/admin/ExportMenu"
import { exportDate, exportMoney, fetchAllPages } from "@food/utils/listExport"
import { daysAgo, isoDay, DisbursementTabs } from "./disbursementShared"

const STATUS = [
  ["", "All"],
  ["pending", "Pending"],
  ["paid", "Paid"],
  ["failed", "Failed"],
]

const BADGE = {
  pending: "bg-amber-100 text-amber-800",
  paid: "bg-emerald-100 text-emerald-800",
  failed: "bg-rose-100 text-rose-700",
}

const METHOD = { bank_transfer: "Bank transfer", upi: "UPI", cash: "Cash" }
const methodLabel = (value) => METHOD[value] || String(value || "-").replace(/_/g, " ")

const EXPORT_COLUMNS = [
  { label: "Sl", value: (r, i) => i + 1 },
  { label: "Id", value: (r) => r.id },
  { label: "Disbursement", value: (r) => r.batchTitle },
  { label: "Delivery man", value: (r) => r.deliveryName },
  { label: "Phone", value: (r) => r.deliveryPhone },
  { label: "Created at", value: (r) => exportDate(r.createdAt) },
  { label: "Disburse amount", value: (r) => exportMoney(r.amount) },
  { label: "Payment method", value: (r) => methodLabel(r.paymentMethod) },
  { label: "Status", value: (r) => r.status },
  { label: "Reference", value: (r) => r.reference },
  { label: "Note", value: (r) => r.note },
]

const fmt = (value) => {
  const d = new Date(value)
  return Number.isNaN(d.getTime())
    ? "-"
    : d.toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })
}

/**
 * Disbursement Report -> Delivery men: every payout line the Delivery Man
 * Disbursements made in the period, with the old panel's columns. A rider's
 * own withdrawal requests are not disbursements and are not listed.
 */
export default function RiderDisbursementReport() {
  const [range, setRange] = useState({ from: daysAgo(29), to: isoDay(new Date()) })
  const [status, setStatus] = useState("")
  const [search, setSearch] = useState("")
  const [typed, setTyped] = useState("")
  const [rider, setRider] = useState(null)
  const [page, setPage] = useState(1)
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(typed.trim())
      setPage(1)
    }, 350)
    return () => clearTimeout(t)
  }, [typed])

  const params = {
    ...range,
    entityType: "rider",
    status: status || undefined,
    search: search || undefined,
    deliveryPartnerId: rider?.id || undefined,
  }

  useEffect(() => {
    let alive = true
    setLoading(true)
    adminSystemExtrasAPI
      .getDisbursementReport({ ...params, page, limit: 50 })
      .then((res) => alive && setData(res?.data?.data || null))
      .catch((err) => alive && toast.error(err?.response?.data?.message || "Failed to load the disbursement report"))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [range.from, range.to, status, search, rider?.id, page])

  const exportAll = () =>
    fetchAllPages(
      ({ page: p, limit }) => adminSystemExtrasAPI.getDisbursementReport({ ...params, page: p, limit }),
      (res) => {
        const d = res?.data?.data || {}
        return { rows: d.rows || [], total: d.pagination?.total, pages: d.pagination?.pages }
      },
    )

  const input = "rounded-lg border border-slate-300 px-3 py-2 text-sm bg-white"
  const rows = data?.rows || []
  const pages = data?.pagination?.pages || 1
  const offset = ((data?.pagination?.page || page) - 1) * (data?.pagination?.limit || 50)
  const totals = data?.totals || {}

  return (
    <div className="p-4 lg:p-6 bg-slate-50 min-h-screen">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
          <div className="flex items-center gap-3">
            <PiggyBank className="w-5 h-5 text-teal-700" />
            <h1 className="text-2xl font-bold text-slate-900">Disbursement Report</h1>
          </div>
          <p className="text-sm text-slate-600 mt-1 max-w-3xl">
            Payouts made to delivery men by the Delivery Man Disbursements in the period: what was paid, what is still waiting and what failed (a failed payout went back to the rider's balance).
          </p>
          <DisbursementTabs active="rider" />
          <div className="mt-5 flex flex-wrap items-end gap-3">
            <label className="space-y-1">
              <span className="block text-[11px] font-semibold uppercase tracking-wide text-slate-500">From</span>
              <input type="date" className={input} value={range.from} onChange={(e) => { setRange((r) => ({ ...r, from: e.target.value })); setPage(1) }} />
            </label>
            <label className="space-y-1">
              <span className="block text-[11px] font-semibold uppercase tracking-wide text-slate-500">To</span>
              <input type="date" className={input} value={range.to} onChange={(e) => { setRange((r) => ({ ...r, to: e.target.value })); setPage(1) }} />
            </label>
            <label className="space-y-1">
              <span className="block text-[11px] font-semibold uppercase tracking-wide text-slate-500">Status</span>
              <select className={input} value={status} onChange={(e) => { setStatus(e.target.value); setPage(1) }}>
                {STATUS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
            {rider ? (
              <div className="space-y-1">
                <span className="block text-[11px] font-semibold uppercase tracking-wide text-slate-500">Delivery man</span>
                <span className="inline-flex items-center gap-2 rounded-lg border border-blue-300 bg-blue-50 px-3 py-2 text-sm text-blue-800">
                  {rider.name}
                  <button type="button" aria-label="Show every delivery man" onClick={() => { setRider(null); setPage(1) }}>
                    <X className="w-3.5 h-3.5" />
                  </button>
                </span>
              </div>
            ) : (
              <label className="space-y-1">
                <span className="block text-[11px] font-semibold uppercase tracking-wide text-slate-500">Delivery man</span>
                <input type="search" className={`${input} w-56`} placeholder="Name or phone" value={typed} onChange={(e) => setTyped(e.target.value)} />
              </label>
            )}
            <ExportMenu
              className="ml-auto"
              filename={`deliveryman-disbursement-report-${range.from}-to-${range.to}`}
              sheetName="Delivery man disbursements"
              columns={EXPORT_COLUMNS}
              getRows={exportAll}
              disabled={!rows.length}
            />
          </div>
        </div>

        {data && (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {[
              ["Disbursed in the period", rupees(totals.total), false, `${totals.payouts || 0} payouts to ${totals.riders || 0} delivery men`],
              ["Paid", rupees(totals.paid), true],
              ["Pending", rupees(totals.pending)],
              ["Failed", rupees(totals.failed)],
            ].map(([label, value, emphasis, hint]) => (
              <div key={label} className={`rounded-xl border p-4 ${emphasis ? "border-teal-600 bg-teal-50" : "border-slate-200 bg-white"}`}>
                <p className="text-xs font-medium text-slate-500">{label}</p>
                <p className="mt-1 text-xl font-bold text-slate-900">{value}</p>
                {hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
              </div>
            ))}
          </div>
        )}

        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
          <h2 className="text-base font-semibold text-slate-900 mb-3">Delivery man payouts</h2>
          {loading ? (
            <div className="py-16 text-center"><Loader2 className="w-7 h-7 animate-spin text-teal-600 mx-auto" /></div>
          ) : !rows.length ? (
            <p className="py-12 text-center text-sm text-slate-500">No delivery man payouts in this period.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-slate-50 border-b border-slate-200">
                  <tr>
                    {["Sl", "Id", "Deliveryman info", "Created at", "Disburse amount", "Payment method", "Status", "Action"].map((h) => (
                      <th key={h} className={`px-4 py-3 text-xs font-semibold text-slate-700 ${h === "Disburse amount" ? "text-right" : h === "Action" ? "text-center" : "text-left"}`}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {rows.map((row, i) => (
                    <tr key={row.id} className="hover:bg-slate-50">
                      <td className="px-4 py-3 text-sm text-slate-600">{offset + i + 1}</td>
                      <td className="px-4 py-3 text-xs text-slate-600">
                        <div className="font-mono" title={row.id}>{String(row.id).slice(-8)}</div>
                        {row.batchTitle && <div className="text-slate-400">{row.batchTitle}</div>}
                      </td>
                      <td className="px-4 py-3 text-sm">
                        <button
                          type="button"
                          className="font-medium text-slate-900 hover:text-blue-700 hover:underline text-left"
                          title="Show only this delivery man"
                          onClick={() => { setRider({ id: row.deliveryPartnerId, name: row.deliveryName }); setTyped(""); setSearch(""); setPage(1) }}
                        >
                          {row.deliveryName}
                        </button>
                        {row.deliveryPhone && <div className="text-xs text-slate-500">{row.deliveryPhone}</div>}
                      </td>
                      <td className="px-4 py-3 text-sm text-slate-600 whitespace-nowrap">{fmt(row.createdAt)}</td>
                      <td className="px-4 py-3 text-sm text-right font-semibold">{rupees(row.amount)}</td>
                      <td className="px-4 py-3 text-sm text-slate-600">{methodLabel(row.paymentMethod)}</td>
                      <td className="px-4 py-3 text-xs">
                        <span className={`rounded px-2 py-0.5 font-semibold capitalize ${BADGE[row.status] || "bg-slate-100 text-slate-700"}`}>{row.status}</span>
                        {row.reference && <div className="mt-1 text-slate-500">Ref: {row.reference}</div>}
                      </td>
                      <td className="px-4 py-3 text-center">
                        {row.batchId ? (
                          <Link
                            to={`/admin/food/deliveryman-disbursements/${row.batchId}`}
                            className="inline-flex items-center justify-center rounded-lg border border-blue-200 p-1.5 text-blue-700 hover:bg-blue-50"
                            title={`Open ${row.batchTitle || "the disbursement"}`}
                          >
                            <Eye className="w-4 h-4" />
                          </Link>
                        ) : "-"}
                      </td>
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
        </div>
      </div>
    </div>
  )
}
