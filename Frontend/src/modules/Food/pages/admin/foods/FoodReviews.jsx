import { useEffect, useState } from "react"
import { Eye, EyeOff, Loader2, Search, Star } from "@food/components/admin/theme/icons"
import { toast } from "sonner"
import { adminAPI } from "@food/api"
import { adminCatalogExtrasAPI, errorMessage, loadRestaurantOptions } from "@food/api/adminCatalogExtras"

const PAGE_SIZE = 25
const EMPTY = { restaurantId: "", rating: "", from: "", to: "", visibility: "", search: "" }

const Stars = ({ value }) => (
  <span className="inline-flex items-center gap-0.5" aria-label={`${value} out of 5`}>
    {[1, 2, 3, 4, 5].map((n) => (
      <Star key={n} className={`w-3.5 h-3.5 ${n <= value ? "fill-amber-400 text-amber-400" : "text-slate-300"}`} />
    ))}
  </span>
)

const when = (d) => (d ? new Date(d).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "")

/** Food Setup -> Review: what customers said about each dish, with a hide switch. */
export default function FoodReviews() {
  const [filters, setFilters] = useState(EMPTY)
  const [searchText, setSearchText] = useState("")
  const [page, setPage] = useState(1)
  const [data, setData] = useState({ reviews: [], summary: null, pagination: null })
  const [loading, setLoading] = useState(true)
  const [restaurants, setRestaurants] = useState([])
  const [busyId, setBusyId] = useState("")

  useEffect(() => {
    loadRestaurantOptions(adminAPI).then(setRestaurants).catch(() => {})
  }, [])

  // Search waits for a pause in typing.
  useEffect(() => {
    const t = setTimeout(() => {
      setFilters((f) => (f.search === searchText.trim() ? f : { ...f, search: searchText.trim() }))
      setPage(1)
    }, 400)
    return () => clearTimeout(t)
  }, [searchText])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const params = { page, limit: PAGE_SIZE, ...Object.fromEntries(Object.entries(filters).filter(([, v]) => v)) }
    adminCatalogExtrasAPI
      .getFoodReviews(params)
      .then((res) => !cancelled && setData(res?.data?.data || { reviews: [] }))
      .catch((err) => !cancelled && toast.error(errorMessage(err, "Failed to load reviews")))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [filters, page])

  const setFilter = (key, value) => {
    setFilters((f) => ({ ...f, [key]: value }))
    setPage(1)
  }

  const toggle = async (review) => {
    try {
      setBusyId(review.id)
      await adminCatalogExtrasAPI.setFoodReviewHidden(review.id, !review.isHidden)
      setData((d) => ({ ...d, reviews: d.reviews.map((r) => (r.id === review.id ? { ...r, isHidden: !r.isHidden } : r)) }))
      toast.success(review.isHidden ? "Review shown again" : "Review hidden from customers")
    } catch (err) {
      toast.error(errorMessage(err, "Could not update the review"))
    } finally {
      setBusyId("")
    }
  }

  const input = "rounded-lg border border-slate-300 px-3 py-2 text-sm bg-white"
  const { reviews = [], summary, pagination } = data

  return (
    <div className="p-4 lg:p-6 bg-slate-50 min-h-screen">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
          <div className="flex items-center gap-3">
            <Star className="w-5 h-5 text-blue-600" />
            <h1 className="text-2xl font-bold text-slate-900">Food Reviews</h1>
          </div>
          <p className="text-sm text-slate-600 mt-1">
            Ratings customers gave each dish after an order. Hiding a review keeps it out of the customer app; the customer still sees it on their own order.
          </p>
          {summary && (
            <div className="mt-4 flex flex-wrap gap-3 text-sm">
              <span className="rounded-lg bg-slate-100 px-3 py-1.5 text-slate-700"><b>{summary.total}</b> reviews</span>
              <span className="rounded-lg bg-amber-50 px-3 py-1.5 text-amber-800">Average <b>{summary.averageRating || "—"}</b></span>
              <span className="rounded-lg bg-slate-100 px-3 py-1.5 text-slate-700"><b>{summary.hidden}</b> hidden</span>
            </div>
          )}
        </div>

        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-4 flex flex-wrap gap-3 items-end">
          <label className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-3 top-2.5 w-4 h-4 text-slate-400" />
            <input className={`${input} w-full pl-9`} placeholder="Search by dish" value={searchText} onChange={(e) => setSearchText(e.target.value)} />
          </label>
          <select className={input} value={filters.restaurantId} onChange={(e) => setFilter("restaurantId", e.target.value)} aria-label="Restaurant">
            <option value="">All restaurants</option>
            {restaurants.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
          <select className={input} value={filters.rating} onChange={(e) => setFilter("rating", e.target.value)} aria-label="Rating">
            <option value="">Any rating</option>
            {[5, 4, 3, 2, 1].map((n) => <option key={n} value={n}>{n} star{n > 1 ? "s" : ""}</option>)}
          </select>
          <select className={input} value={filters.visibility} onChange={(e) => setFilter("visibility", e.target.value)} aria-label="Visibility">
            <option value="">Shown and hidden</option>
            <option value="visible">Shown</option>
            <option value="hidden">Hidden</option>
          </select>
          <label className="flex items-center gap-1.5 text-xs text-slate-600">
            From <input type="date" className={input} value={filters.from} onChange={(e) => setFilter("from", e.target.value)} />
          </label>
          <label className="flex items-center gap-1.5 text-xs text-slate-600">
            To <input type="date" className={input} value={filters.to} onChange={(e) => setFilter("to", e.target.value)} />
          </label>
          {Object.values(filters).some(Boolean) && (
            <button type="button" onClick={() => { setFilters(EMPTY); setSearchText(""); setPage(1) }} className="rounded-lg border border-slate-300 px-3 py-2 text-sm">
              Clear
            </button>
          )}
        </div>

        <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-x-auto">
          {loading ? (
            <div className="py-16 text-center"><Loader2 className="w-6 h-6 animate-spin text-slate-400 mx-auto" /></div>
          ) : !reviews.length ? (
            <p className="py-16 text-center text-sm text-slate-500">No dish reviews match these filters.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-left text-slate-600">
                  <th className="px-4 py-3 font-semibold">Dish</th>
                  <th className="px-4 py-3 font-semibold">Review</th>
                  <th className="px-4 py-3 font-semibold">Customer</th>
                  <th className="px-4 py-3 font-semibold">Restaurant</th>
                  <th className="px-4 py-3 font-semibold">Date</th>
                  <th className="px-4 py-3 font-semibold text-right">Shown to customers</th>
                </tr>
              </thead>
              <tbody>
                {reviews.map((r) => (
                  <tr key={r.id} className={`border-b border-slate-100 align-top ${r.isHidden ? "bg-slate-50 text-slate-500" : ""}`}>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2.5">
                        {r.dishImage ? (
                          <img src={r.dishImage} alt="" className="h-10 w-10 rounded object-cover border border-slate-200" />
                        ) : (
                          <div className="h-10 w-10 rounded bg-slate-100" />
                        )}
                        <span className="font-medium text-slate-800">{r.dishName}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 max-w-sm">
                      <Stars value={r.rating} />
                      {r.comment ? <p className="mt-1 text-slate-700 whitespace-pre-line break-words">{r.comment}</p> : <p className="mt-1 text-xs text-slate-400">No comment</p>}
                    </td>
                    <td className="px-4 py-3 text-slate-700">
                      {r.customerName}
                      {r.orderNumber && <p className="text-xs text-slate-400">{r.orderNumber}</p>}
                    </td>
                    <td className="px-4 py-3 text-slate-700">{r.restaurantName}</td>
                    <td className="px-4 py-3 whitespace-nowrap text-slate-600">{when(r.ratedAt)}</td>
                    <td className="px-4 py-3 text-right">
                      <button
                        type="button"
                        onClick={() => toggle(r)}
                        disabled={busyId === r.id}
                        className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium disabled:opacity-60 ${r.isHidden ? "border-slate-300 text-slate-600" : "border-blue-200 bg-blue-50 text-blue-700"}`}
                      >
                        {busyId === r.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : r.isHidden ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                        {r.isHidden ? "Hidden — show" : "Shown — hide"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {pagination && pagination.pages > 1 && (
          <div className="flex items-center justify-end gap-2 text-sm">
            <button type="button" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 disabled:opacity-50">Previous</button>
            <span className="text-slate-600">Page {pagination.page} of {pagination.pages}</span>
            <button type="button" disabled={page >= pagination.pages} onClick={() => setPage((p) => p + 1)} className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 disabled:opacity-50">Next</button>
          </div>
        )}
      </div>
    </div>
  )
}
