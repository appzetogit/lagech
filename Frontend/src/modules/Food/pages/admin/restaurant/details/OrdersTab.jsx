import { useCallback, useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { Eye, Search } from "@food/components/admin/theme/icons"
import { adminAPI } from "@food/api"
import {
  EmptyState, ErrorState, Pager, Panel, Pill, Spinner, TableBox, errorMessage, formatDateTime, payload, rupees, td, th, titleCase,
} from "./shared"

/** This restaurant's orders: the admin order list filtered to it. */

const FILTERS = [
  ["all", "All"],
  ["pending", "Pending"],
  ["processing", "Processing"],
  ["food-on-the-way", "On the way"],
  ["delivered", "Delivered"],
  ["cancelled", "Cancelled"],
  ["scheduled", "Scheduled"],
  ["refunded", "Refunded"],
]
const LIMIT = 15

const statusTone = (status) => {
  const s = String(status || "")
  if (s === "delivered") return "green"
  if (s.startsWith("cancelled")) return "red"
  if (s === "pending_payment" || s === "created") return "amber"
  return "blue"
}

const paymentTone = (status) => (status === "paid" ? "green" : status === "failed" || status === "refunded" ? "red" : "amber")

export const orderDetailsPath = (order) =>
  `/admin/food/orders/details/${encodeURIComponent(String(order?.orderMongoId || order?._id || order?.id || order?.orderId || ""))}`

export default function OrdersTab({ restaurantId }) {
  const [status, setStatus] = useState("all")
  const [search, setSearch] = useState("")
  const [query, setQuery] = useState("")
  const [page, setPage] = useState(1)
  const [state, setState] = useState({ loading: true, error: "", orders: [], total: 0, pages: 1 })

  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: "" }))
    try {
      const res = await adminAPI.getOrders(
        { restaurantId, status, page, limit: LIMIT, ...(query ? { search: query } : {}) },
        { force: true },
      )
      const data = payload(res)
      const orders = data.orders || data.data || []
      const total = Number(data.meta?.total ?? data.total ?? orders.length)
      setState({ loading: false, error: "", orders, total, pages: Number(data.meta?.totalPages) || Math.ceil(total / LIMIT) || 1 })
    } catch (err) {
      setState((s) => ({ ...s, loading: false, error: errorMessage(err, "Could not load orders") }))
    }
  }, [restaurantId, status, page, query])

  useEffect(() => {
    load()
  }, [load])

  return (
    <Panel
      title={`Orders${state.loading ? "" : ` (${state.total})`}`}
      bodyClassName=""
      actions={
        <form
          onSubmit={(e) => {
            e.preventDefault()
            setPage(1)
            setQuery(search.trim())
          }}
          className="flex w-full items-center gap-2 sm:w-auto"
        >
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Order id or customer"
            className="w-full min-w-0 rounded-lg border border-slate-300 px-3 py-1.5 text-sm sm:w-56"
          />
          <button type="submit" className="rounded-lg bg-slate-100 p-2 text-slate-600 hover:bg-slate-200" title="Search">
            <Search className="w-4 h-4" />
          </button>
        </form>
      }
    >
      <div className="flex gap-2 overflow-x-auto whitespace-nowrap border-b border-slate-100 px-4 py-3 [scrollbar-width:none]">
        {FILTERS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => {
              setStatus(key)
              setPage(1)
            }}
            className={`shrink-0 rounded-full px-3 py-1 text-xs font-medium ${status === key ? "bg-teal-600 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}
          >
            {label}
          </button>
        ))}
      </div>
      {state.loading ? (
        <Spinner />
      ) : state.error ? (
        <ErrorState message={state.error} onRetry={load} />
      ) : state.orders.length === 0 ? (
        <EmptyState title="No orders found">This restaurant has no orders matching this filter.</EmptyState>
      ) : (
        <>
          <TableBox>
            <thead>
              <tr>
                <th className={th}>SL</th>
                <th className={th}>Order ID</th>
                <th className={th}>Order Date</th>
                <th className={th}>Customer</th>
                <th className={th}>Total Amount</th>
                <th className={th}>Order Status</th>
                <th className={`${th} text-center`}>Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {state.orders.map((order, index) => {
                const payment = order.payment || {}
                const customer = order.customerName || order.userId?.name || order.deliveryAddress?.fullName || "Customer"
                return (
                  <tr key={order._id || order.id || index} className="hover:bg-slate-50">
                    <td className={td}>{(page - 1) * LIMIT + index + 1}</td>
                    <td className={`${td} whitespace-nowrap font-medium`}>
                      <Link to={orderDetailsPath(order)} className="text-teal-700 hover:underline">
                        {order.order_id || order.orderId}
                      </Link>
                    </td>
                    <td className={`${td} whitespace-nowrap text-xs`}>{formatDateTime(order.createdAt)}</td>
                    <td className={td}>
                      <p className="font-medium text-slate-800">{customer}</p>
                      <p className="text-xs text-slate-500">{order.customerPhone || order.userId?.phone || ""}</p>
                    </td>
                    <td className={`${td} whitespace-nowrap`}>
                      <p className="font-medium">{rupees(order.pricing?.total ?? order.total)}</p>
                      <Pill tone={paymentTone(payment.status)}>{titleCase(payment.status || "unpaid")}</Pill>
                    </td>
                    <td className={td}>
                      <Pill tone={statusTone(order.orderStatus)}>{titleCase(order.orderStatus)}</Pill>
                    </td>
                    <td className={`${td} text-center`}>
                      <Link
                        to={orderDetailsPath(order)}
                        className="inline-flex rounded-lg border border-orange-200 p-1.5 text-orange-500 hover:bg-orange-50"
                        title="View order"
                      >
                        <Eye className="w-4 h-4" />
                      </Link>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </TableBox>
          <Pager page={page} pages={state.pages} onPage={setPage} />
        </>
      )}
    </Panel>
  )
}
