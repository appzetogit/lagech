import { useEffect, useState } from "react"
import { Store, Loader2, Search } from "@food/components/admin/theme/icons"
import { toast } from "sonner"
import { adminOrderReportsAPI, saveDownload } from "@food/api/adminOrderReports"
import { money, PRESETS, rangeFor, useFilterLists, ExportMenu, Pager, blobErrorMessage } from "./OrderMoneyReport"

/**
 * Restaurant-wise report, as the old panel's Store-wise report: a Summary tab
 * (orders and completion / ongoing / cancellation rates), a Sales tab (the
 * money on delivered orders, the same restaurant net as payouts) and an Order
 * tab (orders by status and payment method). All aggregated on the server.
 */

const pct = (v) => `${Number(v || 0).toFixed(2)}%`
const int = (v) => Number(v || 0).toLocaleString("en-IN")

/** [key, label, format, hint] */
const TABS = {
  summary: {
    label: "Summary Report",
    columns: [
      ["totalOrders", "Total order", int, "Orders placed in the period (abandoned checkouts excluded)"],
      ["deliveredOrders", "Total delivered order", int],
      ["totalAmount", "Total amount", money, "What customers paid on delivered orders"],
      ["completionRate", "Completion rate", pct, "Delivered ÷ total"],
      ["ongoingRate", "Ongoing rate", pct, "Not yet delivered or cancelled ÷ total"],
      ["cancellationRate", "Cancelation rate", pct, "Cancelled ÷ total"],
      ["refundRequests", "Refund request", int, "Orders with a refund pending, processed or failed"],
    ],
  },
  sales: {
    label: "Sales Report",
    columns: [
      ["deliveredOrders", "Delivered orders", int],
      ["totalItemAmount", "Total item amount", money, "Food subtotal"],
      ["extraPackagingAmount", "Packaging", money],
      ["couponDiscount", "Coupon discount", money],
      ["adminDiscount", "Admin discount", money, "Platform-funded share"],
      ["storeDiscount", "Restaurant discount", money, "Restaurant-funded share"],
      ["vatTax", "Vat/tax", money, "GST on the food"],
      ["orderAmount", "Order amount", money, "What customers paid"],
      ["adminCommission", "Admin commission", money],
      ["storeNetIncome", "Restaurant net income", money, "Owed to the restaurant — same figure as payouts and the earning report"],
    ],
  },
  order: {
    label: "Order Report",
    columns: [
      ["totalOrders", "Total orders", int],
      ["pendingOrders", "Pending", int],
      ["processingOrders", "Processing", int, "Accepted, preparing or ready"],
      ["onTheWayOrders", "On the way", int],
      ["deliveredOrders", "Delivered", int],
      ["cancelledOrders", "Cancelled", int],
      ["refundedOrders", "Refunded", int],
      ["cashOrders", "Cash", int],
      ["onlineOrders", "Online", int],
      ["walletOrders", "Wallet", int],
      ["offlineOrders", "Offline", int],
      ["totalAmount", "Total amount", money, "All orders, any status"],
      ["deliveredAmount", "Delivered amount", money],
    ],
  },
}

const CARDS = {
  summary: (t) => [
    ["Restaurants", int(t.restaurants), `${int(t.restaurantsWithSales)} with deliveries`],
    ["Total orders", int(t.totalOrders)],
    ["Delivered orders", int(t.deliveredOrders), `Completion ${pct(t.completionRate)}`],
    ["Total amount", money(t.totalAmount), "Delivered orders"],
    ["Ongoing", pct(t.ongoingRate), `${int(t.ongoingOrders)} orders`],
    ["Cancelled", pct(t.cancellationRate), `${int(t.cancelledOrders)} orders · ${int(t.refundRequests)} refund requests`],
  ],
  sales: (t) => [
    ["Delivered orders", int(t.deliveredOrders)],
    ["Total item amount", money(t.totalItemAmount)],
    ["Order amount", money(t.orderAmount)],
    ["Admin commission", money(t.adminCommission)],
    ["Discount given", money(t.couponDiscount), `Admin ${money(t.adminDiscount)} · Restaurant ${money(t.storeDiscount)}`],
    ["Restaurant net income", money(t.storeNetIncome)],
  ],
  order: (t) => [
    ["Total orders", int(t.totalOrders), money(t.totalAmount)],
    ["Delivered", int(t.deliveredOrders), money(t.deliveredAmount)],
    ["In progress", int(t.pendingOrders + t.processingOrders + t.onTheWayOrders)],
    ["Cancelled", int(t.cancelledOrders), `${int(t.refundedOrders)} refunded`],
    ["Cash / Online", `${int(t.cashOrders)} / ${int(t.onlineOrders)}`],
    ["Wallet / Offline", `${int(t.walletOrders)} / ${int(t.offlineOrders)}`],
  ],
}

const th = "px-3 py-3 text-[10px] font-bold uppercase tracking-wider text-slate-700 whitespace-nowrap"
const td = "px-3 py-2.5 text-sm text-slate-700 whitespace-nowrap"
const input = "rounded-lg border border-slate-300 px-3 py-2 text-sm bg-white"
const labelCls = "block text-[11px] font-semibold uppercase tracking-wide text-slate-500"

export default function RestaurantReport() {
  const { zones } = useFilterLists()
  const [tab, setTab] = useState("summary")
  const [range, setRange] = useState(rangeFor(29))
  const [zoneId, setZoneId] = useState("")
  const [searchInput, setSearchInput] = useState("")
  const [search, setSearch] = useState("")
  const [page, setPage] = useState(1)
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [exporting, setExporting] = useState(false)

  const params = { tab, from: range.from, to: range.to, zoneId: zoneId || undefined, search: search || undefined }

  useEffect(() => {
    let alive = true
    setLoading(true)
    adminOrderReportsAPI
      .getRestaurantWiseReport({ ...params, page, limit: 25 })
      .then((res) => alive && setData(res?.data?.data || null))
      .catch((err) => alive && toast.error(err?.response?.data?.message || "Failed to load the restaurant report"))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [tab, range.from, range.to, zoneId, search, page])

  const reset = (fn) => (value) => {
    fn(value)
    setPage(1)
  }

  const runExport = async (format) => {
    try {
      setExporting(true)
      const res = await adminOrderReportsAPI.exportRestaurantWiseReport({ ...params, format })
      saveDownload(res, `restaurant-wise-${tab}.${format}`)
    } catch (err) {
      toast.error(await blobErrorMessage(err, "Export failed"))
    } finally {
      setExporting(false)
    }
  }

  // A response for the previous tab can still be on screen while the new one loads.
  const current = data?.tab === tab ? data : null
  const rows = current?.restaurants || []
  const columns = TABS[tab].columns

  return (
    <div className="p-4 lg:p-6 bg-slate-50 min-h-screen">
      <div className="max-w-[1600px] mx-auto space-y-5">
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5">
          <div className="flex items-center gap-3">
            <Store className="w-5 h-5 text-teal-700" />
            <h1 className="text-2xl font-bold text-slate-900">Restaurant Wise Report</h1>
          </div>
          <p className="text-sm text-slate-600 mt-1 max-w-4xl">
            Per restaurant, for orders placed in the period. Money is counted on delivered orders only; the restaurant net income is the same figure the payouts and the Restaurant Earning report use.
          </p>
          <div className="mt-4 flex flex-wrap items-end gap-3">
            <label className="space-y-1">
              <span className={labelCls}>From</span>
              <input type="date" className={input} value={range.from} onChange={(e) => reset(setRange)({ ...range, from: e.target.value })} />
            </label>
            <label className="space-y-1">
              <span className={labelCls}>To</span>
              <input type="date" className={input} value={range.to} onChange={(e) => reset(setRange)({ ...range, to: e.target.value })} />
            </label>
            <div className="flex flex-wrap gap-1.5">
              {PRESETS.map(([label, preset]) => (
                <button key={label} type="button" onClick={() => reset(setRange)(rangeFor(preset))} className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-100">
                  {label}
                </button>
              ))}
            </div>
            <label className="space-y-1">
              <span className={labelCls}>Zone</span>
              <select className={input} value={zoneId} onChange={(e) => reset(setZoneId)(e.target.value)}>
                <option value="">All zones</option>
                {zones.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
              </select>
            </label>
          </div>
        </div>

        <div className="flex flex-wrap gap-1 rounded-lg bg-white border border-slate-200 p-1 w-fit">
          {Object.entries(TABS).map(([key, t]) => (
            <button key={key} type="button" onClick={() => reset(setTab)(key)} className={`rounded-md px-4 py-2 text-sm font-medium ${tab === key ? "bg-teal-600 text-white" : "text-slate-600 hover:bg-slate-100"}`}>
              {t.label}
            </button>
          ))}
        </div>

        {current?.totals && (
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
            {CARDS[tab](current.totals).map(([label, value, sub]) => (
              <div key={label} className="rounded-xl border border-slate-200 bg-white p-4">
                <p className="text-xs font-medium text-slate-600">{label}</p>
                <p className="mt-1 text-xl font-bold text-slate-900">{value}</p>
                {sub && <p className="mt-0.5 text-xs text-slate-500">{sub}</p>}
              </div>
            ))}
          </div>
        )}

        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5">
          <div className="flex flex-wrap items-center gap-3 mb-4">
            <h2 className="text-base font-semibold text-slate-900">{TABS[tab].label}</h2>
            <form
              className="relative ml-auto"
              onSubmit={(e) => {
                e.preventDefault()
                reset(setSearch)(searchInput.trim())
              }}
            >
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input className={`${input} pl-9 w-60`} placeholder="Search restaurant" value={searchInput} onChange={(e) => setSearchInput(e.target.value)} />
            </form>
            <ExportMenu onExport={runExport} exporting={exporting} disabled={!current?.pagination?.total} />
          </div>

          {loading && !current ? (
            <div className="py-16 text-center"><Loader2 className="w-7 h-7 animate-spin text-teal-600 mx-auto" /></div>
          ) : !rows.length ? (
            <p className="py-16 text-center text-sm text-slate-500">
              {tab === "sales" ? "No restaurant delivered an order in this period." : "No restaurants match these filters."}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-slate-50 border-b border-slate-200">
                  <tr>
                    <th className={`${th} text-left`}>Sl</th>
                    <th className={`${th} text-left`}>Restaurant</th>
                    {columns.map(([key, label, , hint]) => (
                      <th key={key} className={`${th} text-right`} title={hint}>{label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {rows.map((row) => (
                    <tr key={row.restaurantId} className="hover:bg-slate-50">
                      <td className={td}>{row.sl}</td>
                      <td className={`${td} font-medium text-slate-900`}>
                        <div className="flex items-center gap-2">
                          {row.image ? <img src={row.image} alt="" className="w-8 h-8 rounded-full object-cover" /> : null}
                          {row.restaurant}
                        </div>
                      </td>
                      {columns.map(([key, , fmt]) => (
                        <td key={key} className={`${td} text-right`}>{fmt(row[key])}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
                <tfoot className="border-t-2 border-slate-300 bg-slate-50">
                  <tr>
                    <td className={`${td} font-bold`} colSpan={2}>Total (all pages)</td>
                    {columns.map(([key, , fmt]) => (
                      <td key={key} className={`${td} text-right font-bold text-slate-900`}>{fmt(current.totals?.[key])}</td>
                    ))}
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
          <Pager page={page} pages={current?.pagination?.pages || 1} total={current?.pagination?.total || 0} onPage={setPage} />
        </div>
      </div>
    </div>
  )
}
