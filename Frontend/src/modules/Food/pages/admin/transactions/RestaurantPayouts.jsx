import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { Loader2, Package, Play, Receipt, Search, Settings2 } from "@food/components/admin/theme/icons"
import { toast } from "sonner"
import { adminAPI } from "@food/api"
import ExportMenu from "@food/components/admin/ExportMenu"
import { exportDate, exportMoney, fetchAllPages } from "@food/utils/listExport"
import { BATCH_STATUS, StatusBadge, TotalsStrip, formatCurrency, formatDateTime } from "./restaurantDisbursementShared"

export { BATCH_STATUS } from "./restaurantDisbursementShared"

const TABS = [
  ["all", "All"],
  ["pending", "Pending"],
  ["partially_completed", "Partially completed"],
  ["completed", "Completed"],
  ["canceled", "Canceled"],
]

const EXPORT_COLUMNS = [
  { label: "Disbursement", value: (b) => b.title },
  { label: "Created at", value: (b) => exportDate(b.createdAt) },
  { label: "Restaurants", value: (b) => b.restaurantCount },
  { label: "Total amount", value: (b) => exportMoney(b.totalAmount) },
  { label: "Completed", value: (b) => exportMoney(b.paidAmount) },
  { label: "Pending", value: (b) => exportMoney(b.pendingAmount) },
  { label: "Canceled", value: (b) => exportMoney(b.canceledAmount) },
  { label: "Status", value: (b) => BATCH_STATUS[b.status]?.label || b.status },
  { label: "Created by", value: (b) => (b.triggeredBy === "schedule" ? "System" : b.triggeredBy === "legacy" ? "Previous system" : "Admin") },
]

const inputClass = "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"

/**
 * The old panel's "Store Disbursement": one disbursement per run, with a line
 * per restaurant. Settings are under Business Settings > Disbursement.
 */
export default function RestaurantPayouts() {
  const [batches, setBatches] = useState([])
  const [summary, setSummary] = useState(null)
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState("all")
  const [from, setFrom] = useState("")
  const [to, setTo] = useState("")
  const [searchInput, setSearchInput] = useState("")
  const [search, setSearch] = useState("")
  const [page, setPage] = useState(1)
  const [pages, setPages] = useState(1)
  const [generating, setGenerating] = useState(false)

  const filters = () => ({ status, from: from || undefined, to: to || undefined, search: search || undefined })

  const fetchBatches = async (p = page) => {
    try {
      setLoading(true)
      const res = await adminAPI.getRestaurantPayoutBatches({ ...filters(), page: p, limit: 20 })
      const data = res?.data?.data
      setBatches(data?.batches || [])
      setSummary(data?.summary || null)
      setPages(data?.pagination?.pages || 1)
    } catch (err) {
      toast.error(err?.response?.data?.message || "Failed to load disbursements")
      setBatches([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchBatches(page)
  }, [page, status, from, to, search])

  const resetTo = (setter) => (value) => {
    setter(value)
    setPage(1)
  }

  const generateNow = async () => {
    if (!window.confirm("Create today's disbursement now? It can only be created once per day.")) return
    try {
      setGenerating(true)
      const res = await adminAPI.generateRestaurantPayouts()
      toast.success(res?.data?.message || "Disbursement created")
      setPage(1)
      fetchBatches(1)
    } catch (err) {
      toast.error(err?.response?.data?.message || "Failed to create the disbursement")
    } finally {
      setGenerating(false)
    }
  }

  const exportAll = () =>
    fetchAllPages(
      ({ page: p, limit }) => adminAPI.getRestaurantPayoutBatches({ ...filters(), page: p, limit }),
      (res) => ({ rows: res?.data?.data?.batches || [], pages: res?.data?.data?.pagination?.pages }),
      { pageSize: 100 },
    )

  const hasFilters = status !== "all" || from || to || search

  return (
    <div className="p-4 lg:p-6 bg-slate-50 min-h-screen">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-4 sm:p-6">
          <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
            <div className="min-w-0">
              <div className="flex items-center gap-3">
                <Receipt className="w-5 h-5 text-emerald-600 shrink-0" />
                <h1 className="text-xl sm:text-2xl font-bold text-slate-900">Restaurant Disbursement</h1>
              </div>
              <p className="text-sm text-slate-600 mt-1 max-w-3xl">
                Each run lists what every restaurant is owed as one disbursement. Pay each restaurant to the payment
                method shown, then mark the line completed. Money in a pending line cannot also be withdrawn by the
                restaurant; a canceled line goes back to its balance.
              </p>
            </div>
            <div className="flex flex-wrap gap-2 shrink-0">
              <Link
                to="/admin/food/business-setup?tab=disbursement"
                className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                <Settings2 className="w-4 h-4" /> Settings
              </Link>
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
          <div className="mt-5">
            <TotalsStrip total={{ amount: summary?.totalAmount, count: summary?.count }} totals={summary} totalLabel="Disbursements" />
          </div>
        </div>

        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-4 sm:p-6">
          <div className="flex flex-col lg:flex-row lg:items-end gap-3 mb-4">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 flex-1">
              <label className="space-y-1">
                <span className="text-xs font-semibold text-slate-600">From</span>
                <input type="date" className={inputClass} value={from} max={to || undefined} onChange={(e) => resetTo(setFrom)(e.target.value)} />
              </label>
              <label className="space-y-1">
                <span className="text-xs font-semibold text-slate-600">To</span>
                <input type="date" className={inputClass} value={to} min={from || undefined} onChange={(e) => resetTo(setTo)(e.target.value)} />
              </label>
              <form
                className="col-span-2 space-y-1"
                onSubmit={(e) => {
                  e.preventDefault()
                  resetTo(setSearch)(searchInput.trim())
                }}
              >
                <span className="text-xs font-semibold text-slate-600">Disbursement ID</span>
                <div className="relative">
                  <input
                    type="search"
                    inputMode="numeric"
                    placeholder="e.g. 1117"
                    value={searchInput}
                    onChange={(e) => {
                      setSearchInput(e.target.value)
                      if (!e.target.value) resetTo(setSearch)("")
                    }}
                    className={`${inputClass} pl-9`}
                  />
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                </div>
              </form>
            </div>
            <div className="flex gap-2">
              {hasFilters && (
                <button
                  type="button"
                  onClick={() => {
                    setStatus("all")
                    setFrom("")
                    setTo("")
                    setSearch("")
                    setSearchInput("")
                    setPage(1)
                  }}
                  className="rounded-lg border border-slate-300 px-3 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
                >
                  Reset
                </button>
              )}
              <ExportMenu filename="restaurant_disbursements" sheetName="Disbursements" columns={EXPORT_COLUMNS} getRows={exportAll} />
            </div>
          </div>

          <div className="flex gap-2 mb-4 overflow-x-auto pb-1 -mx-1 px-1">
            {TABS.map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => resetTo(setStatus)(key)}
                className={`shrink-0 rounded-full px-3 py-1 text-xs font-semibold ${
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
          ) : batches.length === 0 ? (
            <div className="py-16 text-center">
              <Package className="w-12 h-12 text-slate-400 mx-auto mb-3" />
              <p className="font-semibold text-slate-700">No disbursements</p>
              <p className="text-sm text-slate-500">{hasFilters ? "Nothing matches these filters." : "Disbursements appear here after each run."}</p>
            </div>
          ) : (
            <>
              {/* Phones: one card per disbursement. */}
              <div className="space-y-3 md:hidden">
                {batches.map((b) => (
                  <Link key={b.id} to={`/admin/food/restaurant-disbursements/${b.id}`} className="block rounded-lg border border-slate-200 p-3 hover:bg-slate-50">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-slate-800">{b.title}</p>
                        <p className="text-xs text-slate-500">{formatDateTime(b.createdAt)}</p>
                      </div>
                      <StatusBadge map={BATCH_STATUS} status={b.status} />
                    </div>
                    <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
                      <div><p className="text-slate-400">Total</p><p className="font-semibold text-slate-800">{formatCurrency(b.totalAmount)}</p></div>
                      <div><p className="text-slate-400">Completed</p><p className="font-semibold text-green-700">{formatCurrency(b.paidAmount)}</p></div>
                      <div><p className="text-slate-400">Pending</p><p className="font-semibold text-amber-700">{formatCurrency(b.pendingAmount)}</p></div>
                    </div>
                    <p className="mt-1 text-[11px] text-slate-500">
                      {b.restaurantCount} restaurant(s){b.skipped?.length ? ` · ${b.skipped.length} skipped` : ""}
                      {b.isLegacy ? " · previous system" : b.triggeredBy !== "schedule" ? " · generated by admin" : ""}
                    </p>
                  </Link>
                ))}
              </div>

              <div className="hidden md:block overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-slate-50 border-b border-slate-200">
                    <tr>
                      {["SL", "Disbursement ID", "Created at", "Restaurants", "Total amount", "Completed", "Pending", "Status", ""].map((h) => (
                        <th key={h} className="px-4 py-3 text-left text-[10px] font-bold text-slate-700 uppercase tracking-wider">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {batches.map((b, i) => (
                      <tr key={b.id} className="hover:bg-slate-50">
                        <td className="px-4 py-4 text-sm text-slate-500">{(page - 1) * 20 + i + 1}</td>
                        <td className="px-4 py-4 text-sm font-semibold text-slate-800">
                          {b.title}
                          {b.isLegacy ? (
                            <span className="block text-[11px] font-normal text-slate-500">Previous system</span>
                          ) : b.triggeredBy !== "schedule" ? (
                            <span className="block text-[11px] font-normal text-slate-500">Generated by admin</span>
                          ) : null}
                        </td>
                        <td className="px-4 py-4 text-sm text-slate-700 whitespace-nowrap">{formatDateTime(b.createdAt)}</td>
                        <td className="px-4 py-4 text-sm text-slate-700">
                          {b.restaurantCount}
                          {b.skipped?.length > 0 && <span className="block text-[11px] text-red-600">{b.skipped.length} skipped</span>}
                        </td>
                        <td className="px-4 py-4 text-sm font-medium text-slate-800 whitespace-nowrap">{formatCurrency(b.totalAmount)}</td>
                        <td className="px-4 py-4 text-sm text-green-700 whitespace-nowrap">{formatCurrency(b.paidAmount)}</td>
                        <td className="px-4 py-4 text-sm text-amber-700 whitespace-nowrap">{formatCurrency(b.pendingAmount)}</td>
                        <td className="px-4 py-4"><StatusBadge map={BATCH_STATUS} status={b.status} /></td>
                        <td className="px-4 py-4 text-right">
                          <Link
                            to={`/admin/food/restaurant-disbursements/${b.id}`}
                            className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                          >
                            View
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
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
