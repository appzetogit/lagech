import { useCallback, useEffect, useState } from "react"
import { Link, useNavigate, useParams } from "react-router-dom"
import { toast } from "sonner"
import {
  ArrowLeft,
  Award,
  ChevronLeft,
  ChevronRight,
  Eye,
  Loader2,
  Mail,
  MapPin,
  Phone,
  Plus,
  Printer,
  Receipt,
  Search,
  User,
  Wallet,
} from "@food/components/admin/theme/icons"
import ExportMenu from "@food/components/admin/ExportMenu"
import { fetchAllPages, exportDate, exportMoney } from "@food/utils/listExport"
import { printOrderInvoice } from "@food/utils/printInvoice"
import { adminAPI } from "@food/api"
import { customerExtrasAPI, dataOf, errorMessage } from "@food/api/adminCustomerExtras"
import { formatDateTime } from "@food/utils/dateTime"

/**
 * Customers -> a customer, laid out like the old panel's (6amMart) customer
 * view: the Create coupon prompt, the four stat cards, the customer's order
 * list, and the customer card with status and saved addresses. Below lg it is
 * one column; the tables scroll inside their cards.
 */

const ORDER_PAGE_SIZE = 10
const HISTORY_PAGE_SIZE = 10

const money = (value) =>
  `₹${Number(value || 0).toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`


// The admin order list's status names, so a customer's orders read the same.
const ORDER_STATUS = {
  pending_payment: ["Pending Payment", "bg-slate-100 text-slate-700"],
  created: ["Pending", "bg-blue-50 text-blue-700"],
  confirmed: ["Processing", "bg-orange-50 text-orange-600"],
  preparing: ["Processing", "bg-orange-50 text-orange-600"],
  ready_for_pickup: ["Processing", "bg-orange-50 text-orange-600"],
  reached_pickup: ["Processing", "bg-orange-50 text-orange-600"],
  picked_up: ["Food On The Way", "bg-yellow-50 text-yellow-700"],
  reached_drop: ["Food On The Way", "bg-yellow-50 text-yellow-700"],
  delivered: ["Delivered", "bg-emerald-50 text-emerald-700"],
  cancelled_by_user: ["Cancelled by User", "bg-rose-50 text-rose-700"],
  cancelled_by_restaurant: ["Cancelled by Restaurant", "bg-rose-50 text-rose-700"],
  cancelled_by_admin: ["Canceled", "bg-rose-50 text-rose-700"],
}
const statusOf = (status) => ORDER_STATUS[status] || [String(status || "-").replace(/_/g, " "), "bg-slate-100 text-slate-700"]

const PAID = new Set(["paid", "authorized"])
const paymentLabel = (order) =>
  order.paymentStatus === "refunded" ? "Refunded" : PAID.has(order.paymentStatus) ? "Paid" : "Unpaid"

const ORDER_EXPORT_COLUMNS = [
  { label: "Sl", value: (_, i) => i + 1 },
  { label: "Order Id", value: (o) => o.orderId },
  { label: "Restaurant", value: (o) => o.restaurantName },
  { label: "Order date", value: (o) => exportDate(o.createdAt) },
  { label: "Total amount", value: (o) => exportMoney(o.total) },
  { label: "Payment status", value: (o) => paymentLabel(o) },
  { label: "Order status", value: (o) => statusOf(o.orderStatus)[0] },
]

const getInitials = (name) =>
  String(name || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || "")
    .join("") || "NA"

function Pager({ page, pages, onChange }) {
  if (pages <= 1) return null
  return (
    <div className="flex items-center justify-between gap-3 border-t border-slate-100 px-4 py-3 text-sm text-slate-600">
      <span>
        Page {page} of {pages}
      </span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={page <= 1}
          onClick={() => onChange(page - 1)}
          className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-3 py-1.5 hover:bg-slate-50 disabled:opacity-50"
        >
          <ChevronLeft className="w-4 h-4" />
          Prev
        </button>
        <button
          type="button"
          disabled={page >= pages}
          onClick={() => onChange(page + 1)}
          className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-3 py-1.5 hover:bg-slate-50 disabled:opacity-50"
        >
          Next
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  )
}

function StatCard({ icon: Icon, value, label, tone }) {
  return (
    <div className={`flex flex-col items-center justify-center rounded-xl px-3 py-6 text-center ${tone.box}`}>
      <span className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-white">
        <Icon className={`w-6 h-6 ${tone.text}`} />
      </span>
      <span className={`text-xl font-bold ${tone.text}`}>{value}</span>
      <span className="mt-1 text-sm text-slate-500">{label}</span>
    </div>
  )
}

/* ── order list ─────────────────────────────────────────────────────────── */

function OrderList({ customerId }) {
  const [orders, setOrders] = useState([])
  const [total, setTotal] = useState(0)
  const [pages, setPages] = useState(1)
  const [page, setPage] = useState(1)
  const [searchInput, setSearchInput] = useState("")
  const [search, setSearch] = useState("")
  const [loading, setLoading] = useState(true)
  const [printingId, setPrintingId] = useState("")

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    adminAPI
      .getCustomerOrders(customerId, { page, limit: ORDER_PAGE_SIZE, ...(search && { search }) })
      .then((res) => {
        if (cancelled) return
        const data = dataOf(res)
        setOrders(data.orders || [])
        setTotal(Number(data.pagination?.total) || 0)
        setPages(Math.max(1, Number(data.pagination?.pages) || 1))
      })
      .catch((err) => {
        if (cancelled) return
        setOrders([])
        setTotal(0)
        toast.error(errorMessage(err, "Failed to load the customer's orders"))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [customerId, page, search])

  const applySearch = (event) => {
    event?.preventDefault()
    setPage(1)
    setSearch(searchInput.trim())
  }

  const getExportRows = () =>
    fetchAllPages(
      ({ page: pageNo, limit }) =>
        adminAPI.getCustomerOrders(customerId, { page: pageNo, limit, ...(search && { search }) }),
      (res) => {
        const data = dataOf(res)
        return { rows: data.orders || [], total: data.pagination?.total }
      },
      { pageSize: 500 },
    )

  const printInvoice = async (order) => {
    if (printingId) return
    setPrintingId(order.id)
    try {
      await printOrderInvoice((params) => adminAPI.getOrderInvoice(order.id, params))
    } catch {
      toast.error("Could not load the invoice")
    } finally {
      setPrintingId("")
    }
  }

  return (
    <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="flex flex-col gap-3 border-b border-slate-100 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <h2 className="text-base font-bold text-slate-900">Order List</h2>
          <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-semibold text-slate-700">{total}</span>
        </div>
        <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
          <form onSubmit={applySearch} className="flex min-w-0">
            <input
              type="search"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Ex : search by order id"
              className="min-w-0 flex-1 rounded-l-lg border border-r-0 border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 sm:w-56"
            />
            <button
              type="submit"
              aria-label="Search orders"
              className="rounded-r-lg bg-teal-600 px-3 text-white hover:bg-teal-700"
            >
              <Search className="w-4 h-4" />
            </button>
          </form>
          <ExportMenu filename="customer_orders" columns={ORDER_EXPORT_COLUMNS} getRows={getExportRows} className="justify-center" />
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px]">
          <thead className="border-b border-slate-200 bg-slate-50">
            <tr className="text-left text-xs font-semibold text-slate-700">
              <th className="px-4 py-3">SL</th>
              <th className="px-4 py-3">Order Id</th>
              <th className="px-4 py-3">Total Amount</th>
              <th className="px-4 py-3">Order Status</th>
              <th className="px-4 py-3 text-center">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {loading ? (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-sm text-slate-500">
                  Loading orders...
                </td>
              </tr>
            ) : orders.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-sm text-slate-500">
                  No orders found
                </td>
              </tr>
            ) : (
              orders.map((order, index) => {
                const [statusLabel, statusTone] = statusOf(order.orderStatus)
                const paid = paymentLabel(order)
                return (
                  <tr key={order.id} className="hover:bg-slate-50">
                    <td className="px-4 py-3 text-sm text-slate-700">{(page - 1) * ORDER_PAGE_SIZE + index + 1}</td>
                    <td className="px-4 py-3 text-sm">
                      <Link to={`/admin/food/orders/details/${order.id}`} className="font-medium text-slate-900 hover:text-blue-600 hover:underline">
                        {order.orderId}
                      </Link>
                      <div className="mt-0.5 text-xs text-slate-500">{formatDateTime(order.createdAt)}</div>
                    </td>
                    <td className="px-4 py-3 text-sm">
                      <div className="text-slate-900">{money(order.total)}</div>
                      <div className={`text-xs ${paid === "Paid" ? "text-emerald-600" : paid === "Refunded" ? "text-sky-600" : "text-rose-600"}`}>{paid}</div>
                    </td>
                    <td className="px-4 py-3 text-sm">
                      <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${statusTone}`}>{statusLabel}</span>
                      <div className="mt-0.5 text-xs text-slate-600">{order.orderType === "takeaway" ? "Takeaway" : "Home Delivery"}</div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-center gap-2">
                        <Link
                          to={`/admin/food/orders/details/${order.id}`}
                          title="View"
                          className="rounded-lg border border-orange-300 p-1.5 text-orange-500 hover:bg-orange-50"
                        >
                          <Eye className="w-4 h-4" />
                        </Link>
                        <button
                          type="button"
                          title="Print invoice"
                          onClick={() => printInvoice(order)}
                          disabled={printingId === order.id}
                          className="rounded-lg border border-teal-300 p-1.5 text-teal-600 hover:bg-teal-50 disabled:opacity-60"
                        >
                          {printingId === order.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Printer className="w-4 h-4" />}
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>
      <Pager page={page} pages={pages} onChange={setPage} />
    </section>
  )
}

/* ── wallet & loyalty history ───────────────────────────────────────────── */

const HISTORY_TABS = [
  { key: "wallet", label: "Wallet transactions" },
  { key: "loyalty", label: "Loyalty point history" },
]

function History({ customerId }) {
  const [tab, setTab] = useState("wallet")
  const [page, setPage] = useState(1)
  const [rows, setRows] = useState([])
  const [pages, setPages] = useState(1)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const params = { userId: customerId, page, limit: HISTORY_PAGE_SIZE }
    const request = tab === "wallet" ? customerExtrasAPI.getWalletTransactions(params) : customerExtrasAPI.getLoyaltyTransactions(params)
    request
      .then((res) => {
        if (cancelled) return
        const data = dataOf(res)
        setRows(data.transactions || [])
        setPages(Math.max(1, Number(data.pagination?.pages) || 1))
      })
      .catch((err) => {
        if (cancelled) return
        setRows([])
        toast.error(errorMessage(err, "Failed to load the history"))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [customerId, tab, page])

  const switchTab = (key) => {
    setTab(key)
    setPage(1)
  }

  const wallet = tab === "wallet"

  return (
    <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="flex gap-4 overflow-x-auto border-b border-slate-100 px-4">
        {HISTORY_TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => switchTab(t.key)}
            className={`whitespace-nowrap border-b-2 py-3 text-sm font-medium ${
              tab === t.key ? "border-teal-600 text-teal-700" : "border-transparent text-slate-500 hover:text-slate-700"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px]">
          <thead className="border-b border-slate-200 bg-slate-50">
            <tr className="text-left text-xs font-semibold text-slate-700">
              <th className="px-4 py-3">Date</th>
              <th className="px-4 py-3">Transaction</th>
              <th className="px-4 py-3">{wallet ? "Credit / Debit" : "Points"}</th>
              <th className="px-4 py-3">Balance</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {loading ? (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-sm text-slate-500">
                  Loading...
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-sm text-slate-500">
                  No transactions yet
                </td>
              </tr>
            ) : (
              rows.map((row) => {
                const credit = row.type === "credit"
                const amount = wallet ? money(row.amount) : `${row.points} pts`
                const title = wallet
                  ? row.sourceLabel || row.description || "-"
                  : row.source === "conversion"
                    ? "Converted to wallet"
                    : "Earned on order"
                const detail = wallet ? (row.sourceLabel ? row.description : "") : row.note
                return (
                  <tr key={row.id}>
                    <td className="whitespace-nowrap px-4 py-3 text-sm text-slate-700">{formatDateTime(row.createdAt)}</td>
                    <td className="px-4 py-3 text-sm">
                      <div className="text-slate-900">{title}</div>
                      {detail ? <div className="text-xs text-slate-500">{detail}</div> : null}
                    </td>
                    <td className={`whitespace-nowrap px-4 py-3 text-sm font-medium ${credit ? "text-emerald-600" : "text-rose-600"}`}>
                      {credit ? "+" : "-"} {amount}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-sm text-slate-700">
                      {wallet ? money(row.balanceAfter) : row.balanceAfter}
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>
      <Pager page={page} pages={pages} onChange={setPage} />
    </section>
  )
}

/* ── page ───────────────────────────────────────────────────────────────── */

export default function CustomerDetails() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [customer, setCustomer] = useState(null)
  const [loading, setLoading] = useState(true)
  const [missing, setMissing] = useState(false)
  const [savingStatus, setSavingStatus] = useState(false)

  const load = useCallback(async () => {
    try {
      setLoading(true)
      setMissing(false)
      const res = await adminAPI.getCustomerById(id)
      const data = dataOf(res)
      const found = data.customer || data.user
      if (!found) setMissing(true)
      setCustomer(found || null)
    } catch (err) {
      if (err?.response?.status === 404 || err?.response?.status === 400) setMissing(true)
      else toast.error(errorMessage(err, "Failed to load the customer"))
      setCustomer(null)
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    load()
  }, [load])

  const toggleStatus = async () => {
    if (!customer || savingStatus) return
    const next = !customer.status
    if (!next && !window.confirm(`Block ${customer.name || "this customer"}? They will be signed out of the app.`)) return
    try {
      setSavingStatus(true)
      await adminAPI.updateCustomerStatus(customer.id, next)
      setCustomer((c) => ({ ...c, status: next, isActive: next }))
      toast.success(next ? "Customer unblocked" : "Customer blocked")
    } catch (err) {
      toast.error(errorMessage(err, "Failed to update status"))
    } finally {
      setSavingStatus(false)
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center bg-slate-50 px-4 text-sm text-slate-500">
        <Loader2 className="mr-2 w-4 h-4 animate-spin" />
        Loading customer...
      </div>
    )
  }

  if (!customer) {
    return (
      <div className="min-h-screen bg-slate-50 px-4 py-6">
        <div className="mx-auto max-w-xl rounded-xl border border-slate-200 bg-white p-6 text-center">
          <p className="text-sm text-slate-600">{missing ? "This customer was not found." : "The customer could not be loaded."}</p>
          <div className="mt-4 flex justify-center gap-2">
            {!missing && (
              <button type="button" onClick={load} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">
                Retry
              </button>
            )}
            <Link to="/admin/food/customers" className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">
              All customers
            </Link>
          </div>
        </div>
      </div>
    )
  }

  const active = customer.status !== false
  const totalOrder = customer.placedOrderCount ?? customer.totalOrders ?? 0
  const totalAmount = customer.placedOrderAmount ?? customer.totalOrderAmount ?? 0

  return (
    <div className="min-h-screen bg-slate-50 px-4 py-4 lg:p-6">
      <div className="mx-auto max-w-7xl space-y-4">
        {/* Header */}
        <div className="flex items-start gap-3">
          <button
            type="button"
            onClick={() => navigate(-1)}
            aria-label="Back"
            className="mt-0.5 rounded-lg border border-slate-200 bg-white p-1.5 text-slate-600 hover:bg-slate-50"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div className="min-w-0">
            <h1 className="break-all text-lg font-bold text-slate-900 sm:text-xl">Customer Id #{customer.id}</h1>
            <p className="text-xs text-slate-500">Joined at : {formatDateTime(customer.joiningDate || customer.createdAt)}</p>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <div className="min-w-0 space-y-4 lg:col-span-2">
            {/* Create coupon */}
            <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
              <p className="text-sm leading-relaxed text-slate-600">
                If you want to make a customized COUPON for this customer, click the Create Coupon button and influence
                them buy more from your store.
              </p>
              <button
                type="button"
                onClick={() => navigate(`/admin/food/coupons?customerId=${encodeURIComponent(customer.id)}`)}
                className="mt-3 inline-flex items-center gap-1.5 rounded-md bg-amber-400 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-amber-500"
              >
                <Plus className="w-4 h-4" />
                Create coupon
              </button>
            </section>

            {/* Stat cards */}
            <section className="grid grid-cols-2 gap-3 rounded-xl border border-slate-200 bg-white p-3 shadow-sm sm:gap-4 sm:p-4 xl:grid-cols-4">
              <StatCard icon={Receipt} value={totalOrder} label="Total order" tone={{ box: "bg-emerald-50", text: "text-emerald-600" }} />
              <StatCard icon={Receipt} value={money(totalAmount)} label="Total order amount" tone={{ box: "bg-violet-50", text: "text-violet-600" }} />
              <StatCard icon={Wallet} value={money(customer.walletBalance)} label="Wallet balance" tone={{ box: "bg-sky-50", text: "text-sky-700" }} />
              <StatCard icon={Award} value={customer.loyaltyPoint || 0} label="Loyalty point" tone={{ box: "bg-orange-50", text: "text-orange-500" }} />
            </section>

            <OrderList customerId={customer.id} />
            <History customerId={customer.id} />
          </div>

          {/* Customer card */}
          <aside className="min-w-0 space-y-4">
            <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
              <h2 className="border-b border-slate-100 px-4 py-3 text-base font-bold text-slate-900">Customer info</h2>
              <div className="space-y-3 p-4">
                <div className="flex items-center gap-3">
                  <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-full border border-slate-100 bg-slate-200 text-slate-700">
                    {customer.profileImage ? (
                      <img
                        src={customer.profileImage}
                        alt={customer.name}
                        className="h-full w-full object-cover"
                        onError={(e) => {
                          e.currentTarget.style.display = "none"
                        }}
                      />
                    ) : (
                      <span className="text-sm font-semibold">{getInitials(customer.name)}</span>
                    )}
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-base font-semibold text-slate-900">{customer.name}</p>
                    <p className="text-xs text-slate-500">
                      {totalOrder} order{totalOrder === 1 ? "" : "s"}
                    </p>
                  </div>
                </div>
                <div className="flex min-w-0 items-center gap-2 text-sm text-slate-700">
                  <Phone className="w-4 h-4 shrink-0 text-slate-400" />
                  {customer.phone ? (
                    <a href={`tel:${customer.phone}`} className="truncate hover:text-blue-600">
                      {customer.phone}
                    </a>
                  ) : (
                    <span className="text-slate-400">-</span>
                  )}
                </div>
                <div className="flex min-w-0 items-center gap-2 text-sm text-slate-700">
                  <Mail className="w-4 h-4 shrink-0 text-slate-400" />
                  {customer.email ? (
                    <a href={`mailto:${customer.email}`} className="truncate hover:text-blue-600">
                      {customer.email}
                    </a>
                  ) : (
                    <span className="text-slate-400">-</span>
                  )}
                </div>
                {customer.gender || customer.dateOfBirth ? (
                  <div className="flex min-w-0 items-center gap-2 text-sm text-slate-700">
                    <User className="w-4 h-4 shrink-0 text-slate-400" />
                    <span className="capitalize">
                      {[customer.gender, customer.dateOfBirth && new Date(customer.dateOfBirth).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </div>
                ) : null}
                <div className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2">
                  <span className="text-sm text-slate-700">
                    Status:{" "}
                    <span className={`font-semibold ${active ? "text-emerald-600" : "text-rose-600"}`}>{active ? "Active" : "Blocked"}</span>
                  </span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={active}
                    aria-label={active ? "Block customer" : "Unblock customer"}
                    disabled={savingStatus}
                    onClick={toggleStatus}
                    className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-60 ${active ? "bg-blue-600" : "bg-slate-300"}`}
                  >
                    <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${active ? "translate-x-6" : "translate-x-1"}`} />
                  </button>
                </div>
              </div>
            </section>

            <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
              <h2 className="flex items-center gap-2 border-b border-slate-100 px-4 py-3 text-base font-bold text-slate-900">
                <MapPin className="w-4 h-4" />
                Addresses
              </h2>
              <div className="space-y-2 p-4">
                {(customer.addresses || []).length === 0 ? (
                  <p className="text-sm text-slate-500">No saved addresses</p>
                ) : (
                  customer.addresses.map((address) => (
                    <div key={address.id} className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                      <div className="mb-1 flex items-center justify-between gap-2">
                        <span className="text-sm font-semibold text-slate-700">{address.label || "Address"}</span>
                        {address.isDefault && (
                          <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs font-semibold text-blue-700">Default</span>
                        )}
                      </div>
                      <p className="break-words text-sm text-slate-600">
                        {[address.street, address.additionalDetails, address.city, address.state].filter(Boolean).join(", ")}
                        {address.zipCode ? ` - ${address.zipCode}` : ""}
                      </p>
                      {address.phone ? <p className="mt-1 text-xs text-slate-500">{address.phone}</p> : null}
                    </div>
                  ))
                )}
              </div>
            </section>
          </aside>
        </div>
      </div>
    </div>
  )
}
