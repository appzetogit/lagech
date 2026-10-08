import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { Loader2, PiggyBank } from "@food/components/admin/theme/icons"
import { toast } from "sonner"
import { adminAPI } from "@food/api"
import { adminSystemExtrasAPI } from "@food/api/adminSystemExtras"
import { rupees } from "./ReportShell"
import ExportMenu from "@food/components/admin/ExportMenu"
import { exportMoney, fetchAllPages } from "@food/utils/listExport"
import { daysAgo, isoDay, DisbursementTabs } from "./disbursementShared"
import RiderDisbursementReport from "./RiderDisbursementReport"

const STATUS = [
  ["", "All"],
  ["pending", "Pending"],
  ["paid", "Paid"],
  ["cancelled", "Cancelled"],
]

const BATCH_BADGE = {
  pending: "bg-amber-100 text-amber-800",
  partially_completed: "bg-blue-100 text-blue-800",
  completed: "bg-emerald-100 text-emerald-800",
  canceled: "bg-slate-200 text-slate-700",
}

const EXPORT_COLUMNS = [
  { label: "Sl", value: (r, i) => i + 1 },
  { label: "Restaurant", value: (r) => r.restaurantName },
  { label: "Payouts", value: (r) => Number(r.payouts) || 0 },
  { label: "Total", value: (r) => exportMoney(r.total) },
  { label: "Paid", value: (r) => exportMoney(r.paid) },
  { label: "Pending", value: (r) => exportMoney(r.pending) },
  { label: "Cancelled", value: (r) => exportMoney(r.cancelled) },
]

/**
 * What the payout runs disbursed: totals by status, a row per restaurant and
 * each run. The Delivery men tab lists each rider payout line instead
 * (RiderDisbursementReport).
 */
export default function DisbursementReport({ entityType = "restaurant" }) {
  if (entityType === "rider") return <RiderDisbursementReport />
  return <RestaurantDisbursementReport />
}

function RestaurantDisbursementReport() {
  const entityType = "restaurant"
  const [range, setRange] = useState({ from: daysAgo(29), to: isoDay(new Date()) })
  const [status, setStatus] = useState("")
  const [restaurantId, setRestaurantId] = useState("")
  const [restaurants, setRestaurants] = useState([])
  const [page, setPage] = useState(1)
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    adminAPI
      .getRestaurants({ limit: 1000 })
      .then((res) => {
        const d = res?.data?.data || {}
        const list = d.restaurants || d.items || d.docs || (Array.isArray(d) ? d : [])
        setRestaurants(list.map((r) => ({ id: r.id || r._id, name: r.restaurantName || r.name })).filter((r) => r.id))
      })
      .catch(() => setRestaurants([]))
  }, [entityType])

  const params = { ...range, entityType, status: status || undefined, restaurantId: restaurantId || undefined }

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
  }, [range.from, range.to, status, restaurantId, page, entityType])

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
  const supported = data?.supported !== false

  return (
    <div className="p-4 lg:p-6 bg-slate-50 min-h-screen">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
          <div className="flex items-center gap-3">
            <PiggyBank className="w-5 h-5 text-teal-700" />
            <h1 className="text-2xl font-bold text-slate-900">Disbursement Report</h1>
          </div>
          <p className="text-sm text-slate-600 mt-1 max-w-3xl">Money sent out by the automatic payout runs in the period: what was paid, what is still waiting and what was cancelled.</p>
          <DisbursementTabs active={entityType} />
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
            {entityType === "restaurant" && (
              <label className="space-y-1">
                <span className="block text-[11px] font-semibold uppercase tracking-wide text-slate-500">Restaurant</span>
                <select className={input} value={restaurantId} onChange={(e) => { setRestaurantId(e.target.value); setPage(1) }}>
                  <option value="">All restaurants</option>
                  {restaurants.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select>
              </label>
            )}
            <ExportMenu
              className="ml-auto"
              filename={`disbursement-report-${range.from}-to-${range.to}`}
              sheetName="Disbursement Report"
              columns={EXPORT_COLUMNS}
              getRows={exportAll}
              disabled={!rows.length}
            />
          </div>
        </div>

        {!supported ? (
          <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-10 text-center text-sm text-slate-600">{data?.message}</div>
        ) : (
          <>
            {data && (
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                {[
                  ["Disbursed in the period", rupees(data.totals.total)],
                  ["Paid", rupees(data.totals.paid), true],
                  ["Pending", rupees(data.totals.pending)],
                  ["Cancelled", rupees(data.totals.cancelled)],
                ].map(([label, value, emphasis]) => (
                  <div key={label} className={`rounded-xl border p-4 ${emphasis ? "border-teal-600 bg-teal-50" : "border-slate-200 bg-white"}`}>
                    <p className="text-xs font-medium text-slate-500">{label}</p>
                    <p className="mt-1 text-xl font-bold text-slate-900">{value}</p>
                  </div>
                ))}
              </div>
            )}

            <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
              <h2 className="text-base font-semibold text-slate-900 mb-3">By restaurant</h2>
              {loading ? (
                <div className="py-16 text-center"><Loader2 className="w-7 h-7 animate-spin text-teal-600 mx-auto" /></div>
              ) : !rows.length ? (
                <p className="py-12 text-center text-sm text-slate-500">No payouts in this period.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead className="bg-slate-50 border-b border-slate-200">
                      <tr>
                        {["Restaurant", "Payouts", "Total", "Paid", "Pending", "Cancelled"].map((h, i) => (
                          <th key={h} className={`px-4 py-3 text-xs font-semibold text-slate-700 ${i ? "text-right" : "text-left"}`}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {rows.map((row) => (
                        <tr key={row.restaurantId} className="hover:bg-slate-50">
                          <td className="px-4 py-3 text-sm font-medium text-slate-900">{row.restaurantName}</td>
                          <td className="px-4 py-3 text-sm text-right">{row.payouts}</td>
                          <td className="px-4 py-3 text-sm text-right font-semibold">{rupees(row.total)}</td>
                          <td className="px-4 py-3 text-sm text-right text-emerald-700">{rupees(row.paid)}</td>
                          <td className="px-4 py-3 text-sm text-right text-amber-700">{rupees(row.pending)}</td>
                          <td className="px-4 py-3 text-sm text-right text-slate-500">{rupees(row.cancelled)}</td>
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

            {data?.batches?.length > 0 && (
              <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
                <h2 className="text-base font-semibold text-slate-900 mb-3">Payout runs</h2>
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead className="bg-slate-50 border-b border-slate-200">
                      <tr>
                        {["Run", "Date", "Status", "Restaurants", "Total", "Paid", "Pending", "Cancelled"].map((h, i) => (
                          <th key={h} className={`px-4 py-3 text-xs font-semibold text-slate-700 ${i > 2 ? "text-right" : "text-left"}`}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {data.batches.map((b) => (
                        <tr key={b.id} className="hover:bg-slate-50">
                          <td className="px-4 py-3 text-sm"><Link to={`/admin/food/restaurant-disbursements/${b.id}`} className="font-medium text-blue-700 hover:underline">{b.title}</Link></td>
                          <td className="px-4 py-3 text-sm text-slate-600">{b.runDate}</td>
                          <td className="px-4 py-3 text-xs"><span className={`rounded px-2 py-0.5 font-semibold ${BATCH_BADGE[b.status] || "bg-slate-100 text-slate-700"}`}>{String(b.status).replace(/_/g, " ")}</span></td>
                          <td className="px-4 py-3 text-sm text-right">{b.restaurantCount}</td>
                          <td className="px-4 py-3 text-sm text-right font-semibold">{rupees(b.totalAmount)}</td>
                          <td className="px-4 py-3 text-sm text-right text-emerald-700">{rupees(b.paid)}</td>
                          <td className="px-4 py-3 text-sm text-right text-amber-700">{rupees(b.pending)}</td>
                          <td className="px-4 py-3 text-sm text-right text-slate-500">{rupees(b.cancelled)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
