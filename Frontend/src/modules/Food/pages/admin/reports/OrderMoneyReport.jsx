import { useEffect, useState } from "react"
import { Download, Loader2, Search, FileSpreadsheet, FileText, ChevronDown, Info } from "@food/components/admin/theme/icons"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@food/components/ui/dropdown-menu"
import { toast } from "sonner"
import { adminAPI } from "@food/api"
import { adminOrderReportsAPI, saveDownload } from "@food/api/adminOrderReports"

/**
 * The per-order money report, as the old panel's Transaction report and Order
 * report. Every figure comes from the server: one page of orders, the column
 * totals over the whole filtered set, and the summary cards. Export runs on
 * the server over the full filtered set, not the page on screen.
 */

export const money = (value) =>
  value === null || value === undefined
    ? "—"
    : `₹${Number(value).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export const isoDay = (date) => {
  const d = new Date(date)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

export const PRESETS = [
  ["Today", 0],
  ["Last 7 days", 6],
  ["Last 30 days", 29],
  ["This year", "year"],
]

export const rangeFor = (preset) => {
  const to = new Date()
  const from = new Date()
  if (preset === "year") from.setMonth(0, 1)
  else from.setDate(from.getDate() - preset)
  return { from: isoDay(from), to: isoDay(to) }
}

/** Zones and restaurants for the filter dropdowns. */
export function useFilterLists() {
  const [zones, setZones] = useState([])
  const [restaurants, setRestaurants] = useState([])
  useEffect(() => {
    adminAPI
      .getZones({ limit: 1000 })
      .then((res) => setZones((res?.data?.data?.zones || []).map((z) => ({ id: z.id || z._id, name: z.name || z.zoneName })).filter((z) => z.id)))
      .catch(() => setZones([]))
    adminAPI
      .getRestaurants({ limit: 1000 })
      .then((res) => {
        const d = res?.data?.data || {}
        const list = d.restaurants || d.items || (Array.isArray(d) ? d : [])
        setRestaurants(list.map((r) => ({ id: r.id || r._id, name: r.restaurantName || r.name })).filter((r) => r.id))
      })
      .catch(() => setRestaurants([]))
  }, [])
  return { zones, restaurants }
}

const STATUS_TABS = [
  ["delivered", "Delivered"],
  ["ongoing", "Ongoing"],
  ["cancelled", "Cancelled"],
  ["refunded", "Refunded"],
  ["all", "All"],
]

const PAYMENT_METHODS = [
  ["", "All payment methods"],
  ["cash", "Cash on delivery"],
  ["razorpay", "Online (Razorpay)"],
  ["razorpay_qr", "Online (QR)"],
  ["wallet", "Wallet"],
  ["offline", "Offline payment"],
  ["partial", "Wallet + another method"],
]

const STATUS_LABEL = {
  created: "Pending",
  confirmed: "Accepted",
  preparing: "Processing",
  ready_for_pickup: "Ready",
  reached_pickup: "At restaurant",
  picked_up: "On the way",
  reached_drop: "At customer",
  delivered: "Delivered",
  cancelled_by_user: "Cancelled (customer)",
  cancelled_by_restaurant: "Cancelled (restaurant)",
  cancelled_by_admin: "Cancelled (admin)",
}

/** [key, label, hint] — the old panel's columns, onto our fields. */
const MONEY_COLUMNS = [
  ["totalItemAmount", "Total item amount", "Food subtotal before discounts"],
  ["couponDiscount", "Coupon discount", "Coupon taken off the food"],
  ["freeDeliveryDiscount", "Free delivery", "Delivery fee + its GST waived by a free-delivery coupon (platform-funded)"],
  ["discountedAmount", "Discounted amount", "All discounts on the order: coupon + free delivery"],
  ["vatTax", "Vat/tax", "GST on the food"],
  ["deliveryCharge", "Delivery charge", "Delivery fee charged to the customer"],
  ["deliveryChargeGst", "Delivery GST", "GST on the delivery fee"],
  ["additionalCharge", "Additional charge", "Platform fee (includes the Quick Mode surcharge)"],
  ["extraPackagingAmount", "Extra packaging amount", "Packaging fee, paid to the restaurant"],
  ["orderAmount", "Order amount", "What the customer paid"],
  ["adminDiscount", "Admin discount", "Platform-funded share of the coupon"],
  ["storeDiscount", "Restaurant discount", "Restaurant-funded share of the coupon"],
  ["adminCommission", "Admin commission", "Commission on the food"],
  ["commissionOnDeliveryCharge", "Commission on delivery charge", "Delivery fee − rider pay (negative when the platform tops the rider up)"],
  ["deliverymanEarning", "Deliveryman earning", "Rider pay for the trip"],
  ["adminNetIncome", "Admin net income", "Platform fee + delivery fee + delivery GST + commission − rider pay − admin discount"],
  ["storeNetIncome", "Restaurant net income", "Owed to the restaurant: food + packaging − commission − restaurant discount (same as payouts)"],
  ["refundAmount", "Refunded", "Refunded to the customer"],
]

const th = "px-3 py-3 text-[10px] font-bold uppercase tracking-wider text-slate-700 whitespace-nowrap"
const td = "px-3 py-2.5 text-sm text-slate-700 whitespace-nowrap"
const input = "rounded-lg border border-slate-300 px-3 py-2 text-sm bg-white"
const labelCls = "block text-[11px] font-semibold uppercase tracking-wide text-slate-500"

function Card({ label, value, sub, tone = "slate" }) {
  const tones = {
    slate: "border-slate-200 bg-white",
    teal: "border-teal-600 bg-teal-50",
    blue: "border-blue-200 bg-blue-50",
    amber: "border-amber-200 bg-amber-50",
    red: "border-red-200 bg-red-50",
    green: "border-emerald-200 bg-emerald-50",
  }
  return (
    <div className={`rounded-xl border p-4 ${tones[tone]}`}>
      <p className="text-xs font-medium text-slate-600">{label}</p>
      <p className="mt-1 text-xl font-bold text-slate-900">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-slate-500">{sub}</p>}
    </div>
  )
}

export function ExportMenu({ onExport, exporting, disabled }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" disabled={disabled || exporting} className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50">
          {exporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />} Export <ChevronDown className="w-3 h-3" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => onExport("xlsx")}><FileSpreadsheet className="w-4 h-4 mr-2" />Excel</DropdownMenuItem>
        <DropdownMenuItem onClick={() => onExport("csv")}><FileText className="w-4 h-4 mr-2" />CSV</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function Pager({ page, pages, total, onPage }) {
  if (pages <= 1) return null
  return (
    <div className="flex items-center justify-between mt-4 pt-4 border-t border-slate-200">
      <p className="text-sm text-slate-600">Page {page} of {pages} · {total} rows</p>
      <div className="flex gap-2">
        <button type="button" onClick={() => onPage(Math.max(1, page - 1))} disabled={page <= 1} className="px-4 py-2 text-sm rounded-lg border border-slate-300 disabled:opacity-50">Previous</button>
        <button type="button" onClick={() => onPage(Math.min(pages, page + 1))} disabled={page >= pages} className="px-4 py-2 text-sm rounded-lg border border-slate-300 disabled:opacity-50">Next</button>
      </div>
    </div>
  )
}

/** Errors on a blob request arrive as a Blob; read the message out of it. */
export async function blobErrorMessage(err, fallback) {
  try {
    const data = err?.response?.data
    if (data instanceof Blob) return JSON.parse(await data.text())?.message || fallback
    return data?.message || fallback
  } catch {
    return fallback
  }
}

export default function OrderMoneyReport({ variant = "transaction", title, icon: Icon }) {
  const isOrder = variant === "order"
  const { zones, restaurants } = useFilterLists()
  const [range, setRange] = useState(rangeFor(29))
  const [zoneId, setZoneId] = useState("")
  const [restaurantId, setRestaurantId] = useState("")
  const [paymentMethod, setPaymentMethod] = useState("")
  const [status, setStatus] = useState(isOrder ? "all" : "delivered")
  const [searchInput, setSearchInput] = useState("")
  const [search, setSearch] = useState("")
  const [page, setPage] = useState(1)
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [exporting, setExporting] = useState(false)

  const params = {
    from: range.from,
    to: range.to,
    zoneId: zoneId || undefined,
    restaurantId: restaurantId || undefined,
    paymentMethod: paymentMethod || undefined,
    status,
    search: search || undefined,
  }

  useEffect(() => {
    let alive = true
    setLoading(true)
    adminOrderReportsAPI
      .getOrderMoneyReport({ ...params, page, limit: 25 })
      .then((res) => alive && setData(res?.data?.data || null))
      .catch((err) => alive && toast.error(err?.response?.data?.message || `Failed to load ${title}`))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [range.from, range.to, zoneId, restaurantId, paymentMethod, status, search, page])

  const reset = (fn) => (value) => {
    fn(value)
    setPage(1)
  }

  const runExport = async (format) => {
    try {
      setExporting(true)
      const res = await adminOrderReportsAPI.exportOrderMoneyReport({ ...params, format, report: variant })
      saveDownload(res, `${variant}-report.${format}`)
    } catch (err) {
      toast.error(await blobErrorMessage(err, "Export failed"))
    } finally {
      setExporting(false)
    }
  }

  const rows = data?.orders || []
  const totals = data?.totals || {}
  const s = data?.summary

  return (
    <div className="p-4 lg:p-6 bg-slate-50 min-h-screen">
      <div className="max-w-[1600px] mx-auto space-y-5">
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5">
          <div className="flex items-center gap-3">
            {Icon && <Icon className="w-5 h-5 text-teal-700" />}
            <h1 className="text-2xl font-bold text-slate-900">{title}</h1>
          </div>
          <p className="text-sm text-slate-600 mt-1 max-w-4xl">
            {isOrder
              ? "Every order in the period with its money, how it was paid and who holds the money. Income is shown on delivered orders only."
              : "Money per order, from the order ledger. Only delivered orders earn income; cancelled and refunded orders are counted separately and carry no income."}
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
            <label className="space-y-1">
              <span className={labelCls}>Restaurant</span>
              <select className={`${input} max-w-[220px]`} value={restaurantId} onChange={(e) => reset(setRestaurantId)(e.target.value)}>
                <option value="">All restaurants</option>
                {restaurants.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </label>
            <label className="space-y-1">
              <span className={labelCls}>Payment</span>
              <select className={input} value={paymentMethod} onChange={(e) => reset(setPaymentMethod)(e.target.value)}>
                {PAYMENT_METHODS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
          </div>
        </div>

        {s && (isOrder ? (
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
            <Card label="All orders" value={s.allOrders} />
            <Card label="Delivered" value={s.deliveredOrders} sub={money(s.completedAmount)} tone="green" />
            <Card label="Ongoing" value={s.ongoingOrders} tone="blue" />
            <Card label="Cancelled" value={s.cancelledOrders} sub={money(s.cancelledAmount)} tone="red" />
            <Card label="Refunded" value={s.refundedOrders} sub={money(s.refundedAmount)} tone="amber" />
            <Card label="Admin net income" value={money(s.adminNetIncome)} tone="teal" />
          </div>
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3">
              <Card label="Completed transaction" value={money(s.completedAmount)} sub={`${s.deliveredOrders} delivered orders`} tone="green" />
              <Card label="Refunded transaction" value={money(s.refundedAmount)} sub={`${s.refundedOrders} refunded · ${s.cancelledOrders} cancelled (${money(s.cancelledAmount)})`} tone="red" />
              <Card label="Admin earning" value={money(s.adminNetIncome)} sub="Net of rider pay and admin-funded discounts" tone="teal" />
              <Card label="Restaurant earning" value={money(s.storeNetIncome)} sub="Owed to restaurants" tone="blue" />
              <Card label="Deliveryman earning" value={money(s.deliverymanEarning)} tone="amber" />
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Card label="Admin commission" value={money(s.adminCommission)} />
              <Card label="Tax collected" value={money(s.taxCollected)} sub="GST on food + delivery" />
              <Card label="Discount given" value={money(s.discountGiven)} sub="Coupons + free delivery" />
              <Card label="Ongoing orders" value={s.ongoingOrders} sub="Not yet delivered; no income yet" />
            </div>
          </div>
        ))}

        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5">
          <div className="flex flex-wrap items-center gap-3 mb-4">
            <div className="flex flex-wrap gap-1 rounded-lg bg-slate-100 p-1">
              {STATUS_TABS.map(([value, label]) => (
                <button key={value} type="button" onClick={() => reset(setStatus)(value)} className={`rounded-md px-3 py-1.5 text-sm font-medium ${status === value ? "bg-white text-teal-700 shadow-sm" : "text-slate-600 hover:text-slate-900"}`}>
                  {label}
                </button>
              ))}
            </div>
            <form
              className="relative ml-auto"
              onSubmit={(e) => {
                e.preventDefault()
                reset(setSearch)(searchInput.trim())
              }}
            >
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input className={`${input} pl-9 w-64`} placeholder="Search by order id, customer, restaurant" value={searchInput} onChange={(e) => setSearchInput(e.target.value)} />
            </form>
            <ExportMenu onExport={runExport} exporting={exporting} disabled={!data?.pagination?.total} />
          </div>

          {loading ? (
            <div className="py-16 text-center"><Loader2 className="w-7 h-7 animate-spin text-teal-600 mx-auto" /></div>
          ) : !rows.length ? (
            <p className="py-16 text-center text-sm text-slate-500">No orders match these filters.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-slate-50 border-b border-slate-200">
                  <tr>
                    <th className={`${th} text-left`}>Sl</th>
                    <th className={`${th} text-left`}>Order id</th>
                    <th className={`${th} text-left`}>Restaurant</th>
                    <th className={`${th} text-left`}>Customer name</th>
                    {isOrder && <th className={`${th} text-left`}>Status</th>}
                    {MONEY_COLUMNS.map(([key, label, hint]) => (
                      <th key={key} className={`${th} text-right`} title={hint}>
                        <span className="inline-flex items-center gap-1">{label}<Info className="w-3 h-3 text-slate-400" /></span>
                      </th>
                    ))}
                    <th className={`${th} text-left`}>Payment method</th>
                    <th className={`${th} text-left`}>Amount received by</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {rows.map((row) => (
                    <tr key={row.id} className={`hover:bg-slate-50 ${row.earned ? "" : "bg-slate-50/50"}`}>
                      <td className={td}>{row.sl}</td>
                      <td className={`${td} font-medium text-slate-900`}>
                        {row.orderId}
                        <div className="text-[11px] text-slate-400">{new Date(row.date).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}</div>
                      </td>
                      <td className={td}>{row.restaurant}</td>
                      <td className={td}>{row.customerName}</td>
                      {isOrder && <td className={td}>{STATUS_LABEL[row.orderStatus] || row.orderStatus}</td>}
                      {MONEY_COLUMNS.map(([key]) => (
                        <td key={key} className={`${td} text-right ${key === "adminNetIncome" || key === "storeNetIncome" ? "font-semibold text-slate-900" : ""}`}>{money(row[key])}</td>
                      ))}
                      <td className={td}>{row.paymentMethodLabel}</td>
                      <td className={td}>{row.amountReceivedBy}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="border-t-2 border-slate-300 bg-slate-50">
                  <tr>
                    <td className={`${td} font-bold`} colSpan={isOrder ? 5 : 4}>Total ({totals.orders} orders, all pages)</td>
                    {MONEY_COLUMNS.map(([key]) => (
                      <td key={key} className={`${td} text-right font-bold text-slate-900`}>{money(totals[key])}</td>
                    ))}
                    <td colSpan={2} />
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
          <Pager page={page} pages={data?.pagination?.pages || 1} total={data?.pagination?.total || 0} onPage={setPage} />
        </div>
      </div>
    </div>
  )
}
