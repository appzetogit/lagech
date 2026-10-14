import { useCallback, useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { Star } from "@food/components/admin/theme/icons"
import { adminAPI } from "@food/api"
import { EmptyState, ErrorState, Pager, Panel, Spinner, TableBox, errorMessage, formatDateTime, payload, td, th } from "./shared"

/** Ratings customers left on this restaurant's orders. */

const LIMIT = 15

function Stars({ value }) {
  const n = Math.round(Number(value) || 0)
  return (
    <span className="inline-flex gap-0.5">
      {[1, 2, 3, 4, 5].map((i) => (
        <Star key={i} className={`w-3.5 h-3.5 ${i <= n ? "fill-amber-400 text-amber-400" : "text-slate-300"}`} />
      ))}
    </span>
  )
}

export default function ReviewsTab({ restaurantId, restaurant, analytics }) {
  const [page, setPage] = useState(1)
  const [state, setState] = useState({ loading: true, error: "", reviews: [], total: 0 })

  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: "" }))
    try {
      const data = payload(await adminAPI.getRestaurantReviews({ restaurantId, page, limit: LIMIT }))
      setState({ loading: false, error: "", reviews: data.reviews || [], total: Number(data.total) || 0 })
    } catch (err) {
      setState((s) => ({ ...s, loading: false, error: errorMessage(err, "Could not load reviews") }))
    }
  }, [restaurantId, page])

  useEffect(() => {
    load()
  }, [load])

  const rating = Number(analytics?.analytics?.averageRating ?? restaurant?.rating ?? 0)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <p className="text-3xl font-bold text-slate-900">{rating.toFixed(1)}</p>
        <div>
          <Stars value={rating} />
          <p className="text-xs text-slate-500">
            {Number(analytics?.analytics?.totalRatings ?? restaurant?.totalRatings ?? 0)} ratings, {state.total} with an order on record
          </p>
        </div>
      </div>
      <Panel title="Reviews" bodyClassName="">
        {state.loading ? (
          <Spinner />
        ) : state.error ? (
          <ErrorState message={state.error} onRetry={load} />
        ) : state.reviews.length === 0 ? (
          <EmptyState title="No reviews yet">Customers have not rated this restaurant on any order.</EmptyState>
        ) : (
          <>
            <TableBox>
              <thead>
                <tr>
                  <th className={th}>SL</th>
                  <th className={th}>Order</th>
                  <th className={th}>Customer</th>
                  <th className={th}>Rating</th>
                  <th className={th}>Review</th>
                  <th className={th}>Store reply</th>
                  <th className={th}>Date</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {state.reviews.map((review, index) => (
                  <tr key={`${review.orderId}-${index}`} className="hover:bg-slate-50">
                    <td className={td}>{(page - 1) * LIMIT + index + 1}</td>
                    <td className={`${td} whitespace-nowrap`}>
                      <Link to={`/admin/food/orders/details/${encodeURIComponent(review.orderId)}`} className="font-medium text-teal-700 hover:underline">
                        {review.orderId}
                      </Link>
                    </td>
                    <td className={td}>{review.customer}</td>
                    <td className={`${td} whitespace-nowrap`}><Stars value={review.rating} /></td>
                    <td className={`${td} max-w-xs break-words text-xs`}>{review.review || "-"}</td>
                    <td className={`${td} max-w-xs break-words text-xs`}>{review.storeReply || <span className="text-slate-400">No reply</span>}</td>
                    <td className={`${td} whitespace-nowrap text-xs`}>{formatDateTime(review.submittedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </TableBox>
            <Pager page={page} pages={Math.ceil(state.total / LIMIT) || 1} onPage={setPage} />
          </>
        )}
      </Panel>
    </div>
  )
}
