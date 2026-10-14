import { useCallback, useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { adminAPI } from "@food/api"
import {
  EmptyState, ErrorState, Pager, Panel, Pill, Spinner, TableBox, errorMessage, formatDateTime, payload, rupees, td, th, titleCase,
} from "./shared"

/**
 * This restaurant's lines in the daily payout runs: the withdrawals the run
 * created for it (source 'disbursement'), each linked to its batch.
 */

const LIMIT = 15
const tone = (status) => {
  const s = String(status || "").toLowerCase()
  return s === "approved" ? "green" : s === "rejected" ? "red" : "amber"
}

export default function DisbursementsTab({ restaurantId }) {
  const [page, setPage] = useState(1)
  const [state, setState] = useState({ loading: true, error: "", rows: [], total: 0 })

  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: "" }))
    try {
      const data = payload(await adminAPI.getWithdrawals({ restaurantId, source: "disbursement", page, limit: LIMIT }))
      setState({ loading: false, error: "", rows: data.requests || [], total: Number(data.total) || 0 })
    } catch (err) {
      setState((s) => ({ ...s, loading: false, error: errorMessage(err, "Could not load disbursements") }))
    }
  }, [restaurantId, page])

  useEffect(() => {
    load()
  }, [load])

  return (
    <Panel
      title={`Disbursements${state.loading ? "" : ` (${state.total})`}`}
      bodyClassName=""
      actions={
        <Link to="/admin/food/restaurant-disbursements" className="text-sm font-semibold text-teal-700 hover:underline">
          All payout runs
        </Link>
      }
    >
      {state.loading ? (
        <Spinner />
      ) : state.error ? (
        <ErrorState message={state.error} onRetry={load} />
      ) : state.rows.length === 0 ? (
        <EmptyState title="No disbursements">No daily payout run has included this store yet.</EmptyState>
      ) : (
        <>
          <TableBox>
            <thead>
              <tr>
                <th className={th}>SL</th>
                <th className={th}>Payout run</th>
                <th className={th}>Created</th>
                <th className={th}>Amount</th>
                <th className={th}>Method</th>
                <th className={th}>Reference</th>
                <th className={th}>Status</th>
                <th className={th}>Processed</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {state.rows.map((row, index) => (
                <tr key={row.id} className="hover:bg-slate-50">
                  <td className={td}>{(page - 1) * LIMIT + index + 1}</td>
                  <td className={`${td} whitespace-nowrap`}>
                    {row.batchId ? (
                      <Link to={`/admin/food/restaurant-disbursements/${row.batchId}`} className="font-medium text-teal-700 hover:underline">
                        View run
                      </Link>
                    ) : (
                      "-"
                    )}
                  </td>
                  <td className={`${td} whitespace-nowrap text-xs`}>{formatDateTime(row.createdAt)}</td>
                  <td className={`${td} whitespace-nowrap font-semibold`}>{rupees(row.amount)}</td>
                  <td className={td}>{titleCase(row.bankDetails?.payoutMethod?.methodName || row.paymentMethod)}</td>
                  <td className={`${td} text-xs`}>{row.transactionId || "-"}</td>
                  <td className={td}><Pill tone={tone(row.status)}>{titleCase(row.status)}</Pill></td>
                  <td className={`${td} whitespace-nowrap text-xs`}>{formatDateTime(row.processedAt)}</td>
                </tr>
              ))}
            </tbody>
          </TableBox>
          <Pager page={page} pages={Math.ceil(state.total / LIMIT) || 1} onPage={setPage} />
        </>
      )}
    </Panel>
  )
}
