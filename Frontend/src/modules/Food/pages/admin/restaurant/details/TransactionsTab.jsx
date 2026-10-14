import { useCallback, useEffect, useState } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { adminAPI } from "@food/api"
import { adminSystemExtrasAPI } from "@food/api/adminSystemExtras"
import {
  EmptyState, ErrorState, Pager, Panel, Pill, Spinner, TableBox, errorMessage, formatDateTime, payload, rupees, td, th, titleCase,
} from "./shared"

/**
 * The restaurant's ledger, one view per kind of money movement (?type=):
 * what each order earned it, what it withdrew or was paid out, what the admin
 * paid it by hand, and the cash collected back from it.
 */

const VIEWS = [
  ["earnings", "Order earnings"],
  ["withdrawals", "Withdrawals & payouts"],
  ["payments", "Admin payments"],
  ["cash", "Cash collections"],
]
const LIMIT = 15

const statusTone = (status) => {
  const s = String(status || "").toLowerCase()
  if (s === "approved" || s === "paid" || s === "captured") return "green"
  if (s === "rejected" || s === "failed" || s === "cancelled") return "red"
  return "amber"
}

const SOURCE_LABEL = { manual: "Requested", disbursement: "Daily payout", admin_payment: "Admin payment" }

/** Load one page of one view and normalise it to { rows, pages, total }. */
const LOADERS = {
  earnings: async (restaurantId, page) => {
    const data = payload(await adminSystemExtrasAPI.getRestaurantEarnings(restaurantId, { page, limit: LIMIT }))
    return {
      rows: data.orders || [],
      pages: Number(data.pagination?.totalPages) || 1,
      summary: data.totals ? `${rupees(data.totals.totalEarnings)} earned on ${data.totals.totalOrders} delivered orders` : "",
    }
  },
  withdrawals: async (restaurantId, page) => {
    const data = payload(await adminAPI.getWithdrawals({ restaurantId, page, limit: LIMIT }))
    const total = Number(data.total) || 0
    return { rows: data.requests || [], pages: Math.ceil(total / LIMIT) || 1, summary: `${total} withdrawals and payouts` }
  },
  payments: async (restaurantId, page) => {
    const data = payload(await adminSystemExtrasAPI.getRestaurantPayments({ restaurantId, page, limit: LIMIT }))
    return {
      rows: data.payments || [],
      pages: Number(data.pagination?.pages) || 1,
      summary: data.totals ? `${rupees(data.totals.amount)} paid in ${data.totals.count} payments` : "",
    }
  },
  cash: async (restaurantId, page) => {
    const data = payload(await adminSystemExtrasAPI.getRestaurantCashCollections(restaurantId, { page, limit: LIMIT }))
    return {
      rows: data.collections || [],
      pages: Number(data.pagination?.pages) || 1,
      summary: data.totals ? `${rupees(data.totals.amount)} collected in ${data.totals.count} collections` : "",
    }
  },
}

function EarningsTable({ rows }) {
  return (
    <TableBox>
      <thead>
        <tr>
          <th className={th}>Order</th>
          <th className={th}>Date</th>
          <th className={th}>Order amount</th>
          <th className={th}>Commission</th>
          <th className={th}>Discount (store)</th>
          <th className={th}>Store earning</th>
          <th className={th}>Payment</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {rows.map((row) => (
          <tr key={row.orderId} className="hover:bg-slate-50">
            <td className={`${td} whitespace-nowrap`}>
              <Link to={`/admin/food/orders/details/${encodeURIComponent(row.orderId)}`} className="font-medium text-teal-700 hover:underline">
                {row.orderId}
              </Link>
            </td>
            <td className={`${td} whitespace-nowrap text-xs`}>{formatDateTime(row.createdAt)}</td>
            <td className={`${td} whitespace-nowrap`}>{rupees(row.totalAmount)}</td>
            <td className={`${td} whitespace-nowrap`}>{rupees(row.commission)}</td>
            <td className={`${td} whitespace-nowrap`}>{rupees(row.restaurantDiscountShare)}</td>
            <td className={`${td} whitespace-nowrap font-semibold text-emerald-700`}>{rupees(row.payout)}</td>
            <td className={td}>{titleCase(row.paymentMethod)}</td>
          </tr>
        ))}
      </tbody>
    </TableBox>
  )
}

function WithdrawalsTable({ rows }) {
  return (
    <TableBox>
      <thead>
        <tr>
          <th className={th}>Requested</th>
          <th className={th}>Amount</th>
          <th className={th}>Type</th>
          <th className={th}>Method</th>
          <th className={th}>Reference</th>
          <th className={th}>Status</th>
          <th className={th}>Processed</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {rows.map((row) => (
          <tr key={row.id} className="hover:bg-slate-50">
            <td className={`${td} whitespace-nowrap text-xs`}>{formatDateTime(row.createdAt)}</td>
            <td className={`${td} whitespace-nowrap font-semibold`}>{rupees(row.amount)}</td>
            <td className={`${td} whitespace-nowrap`}>
              {row.source === "disbursement" && row.batchId ? (
                <Link to={`/admin/food/restaurant-disbursements/${row.batchId}`} className="text-teal-700 hover:underline">
                  {SOURCE_LABEL[row.source]}
                </Link>
              ) : (
                SOURCE_LABEL[row.source] || titleCase(row.source)
              )}
            </td>
            <td className={td}>{titleCase(row.paymentMethod)}</td>
            <td className={`${td} text-xs`}>{row.transactionId || "-"}</td>
            <td className={td}><Pill tone={statusTone(row.status)}>{titleCase(row.status)}</Pill></td>
            <td className={`${td} whitespace-nowrap text-xs`}>{formatDateTime(row.processedAt)}</td>
          </tr>
        ))}
      </tbody>
    </TableBox>
  )
}

function MoneyRowsTable({ rows, dateKey }) {
  return (
    <TableBox>
      <thead>
        <tr>
          <th className={th}>Date</th>
          <th className={th}>Amount</th>
          <th className={th}>Method</th>
          <th className={th}>Reference</th>
          <th className={th}>Note</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {rows.map((row) => (
          <tr key={row.id} className="hover:bg-slate-50">
            <td className={`${td} whitespace-nowrap text-xs`}>{formatDateTime(row[dateKey] || row.createdAt)}</td>
            <td className={`${td} whitespace-nowrap font-semibold`}>{rupees(row.amount)}</td>
            <td className={td}>{titleCase(row.method)}</td>
            <td className={`${td} text-xs`}>{row.reference || "-"}</td>
            <td className={`${td} max-w-xs break-words text-xs`}>{row.note || "-"}</td>
          </tr>
        ))}
      </tbody>
    </TableBox>
  )
}

export default function TransactionsTab({ restaurantId }) {
  const [searchParams, setSearchParams] = useSearchParams()
  const view = VIEWS.some(([key]) => key === searchParams.get("type")) ? searchParams.get("type") : "earnings"
  const [page, setPage] = useState(1)
  const [state, setState] = useState({ loading: true, error: "", rows: [], pages: 1, summary: "" })

  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: "" }))
    try {
      const result = await LOADERS[view](restaurantId, page)
      setState({ loading: false, error: "", ...result })
    } catch (err) {
      setState((s) => ({ ...s, loading: false, error: errorMessage(err, "Could not load transactions") }))
    }
  }, [restaurantId, view, page])

  useEffect(() => {
    load()
  }, [load])

  const pick = (key) => {
    setPage(1)
    setSearchParams(key === "earnings" ? {} : { type: key }, { replace: true })
  }

  return (
    <Panel title="Transactions" bodyClassName="">
      <div className="flex gap-2 overflow-x-auto whitespace-nowrap border-b border-slate-100 px-4 py-3 [scrollbar-width:none]">
        {VIEWS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => pick(key)}
            className={`shrink-0 rounded-full px-3 py-1 text-xs font-medium ${view === key ? "bg-teal-600 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}
          >
            {label}
          </button>
        ))}
      </div>
      {state.summary && !state.loading && !state.error && (
        <p className="border-b border-slate-100 px-4 py-2 text-xs text-slate-500">{state.summary}</p>
      )}
      {state.loading ? (
        <Spinner />
      ) : state.error ? (
        <ErrorState message={state.error} onRetry={load} />
      ) : state.rows.length === 0 ? (
        <EmptyState title="Nothing here yet" />
      ) : (
        <>
          {view === "earnings" && <EarningsTable rows={state.rows} />}
          {view === "withdrawals" && <WithdrawalsTable rows={state.rows} />}
          {view === "payments" && <MoneyRowsTable rows={state.rows} dateKey="paidAt" />}
          {view === "cash" && <MoneyRowsTable rows={state.rows} dateKey="createdAt" />}
          <Pager page={page} pages={state.pages} onPage={setPage} />
        </>
      )}
    </Panel>
  )
}
