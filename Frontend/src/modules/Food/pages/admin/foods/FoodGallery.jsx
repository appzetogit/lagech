import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { Images, Loader2, Pencil, Search } from "@food/components/admin/theme/icons"
import { toast } from "sonner"
import { adminAPI } from "@food/api"
import { adminCatalogExtrasAPI, errorMessage, loadRestaurantOptions } from "@food/api/adminCatalogExtras"

const PAGE_SIZE = 48
const EMPTY = { restaurantId: "", categoryId: "", search: "" }

const editLink = (food) => {
  const params = new URLSearchParams({ editId: food.id, restaurantId: food.restaurantId, name: food.name })
  return `/admin/food/foods?${params.toString()}`
}

/** Food Setup -> Food Gallery: every dish photo across restaurants. Read-only; edit opens the dish. */
export default function FoodGallery() {
  const [filters, setFilters] = useState(EMPTY)
  const [searchText, setSearchText] = useState("")
  const [page, setPage] = useState(1)
  const [data, setData] = useState({ foods: [], pagination: null })
  const [loading, setLoading] = useState(true)
  const [restaurants, setRestaurants] = useState([])
  const [categories, setCategories] = useState([])

  useEffect(() => {
    loadRestaurantOptions(adminAPI).then(setRestaurants).catch(() => {})
    adminAPI
      .getCategories({ limit: 1000 })
      .then((res) => {
        const list = res?.data?.data?.categories || []
        setCategories(
          list
            .map((c) => ({ id: c.id || c._id, name: c.parentName ? `${c.parentName} › ${c.name}` : c.name }))
            .filter((c) => c.id)
            .sort((a, b) => a.name.localeCompare(b.name)),
        )
      })
      .catch(() => {})
  }, [])

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
      .getFoodGallery(params)
      .then((res) => !cancelled && setData(res?.data?.data || { foods: [] }))
      .catch((err) => !cancelled && toast.error(errorMessage(err, "Failed to load the gallery")))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [filters, page])

  const setFilter = (key, value) => {
    setFilters((f) => ({ ...f, [key]: value }))
    setPage(1)
  }

  const input = "rounded-lg border border-slate-300 px-3 py-2 text-sm bg-white"
  const { foods = [], pagination } = data

  return (
    <div className="p-4 lg:p-6 bg-slate-50 min-h-screen">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
          <div className="flex items-center gap-3">
            <Images className="w-5 h-5 text-blue-600" />
            <h1 className="text-2xl font-bold text-slate-900">Food Gallery</h1>
          </div>
          <p className="text-sm text-slate-600 mt-1">
            Every dish with a photo, across restaurants{pagination ? ` (${pagination.total})` : ""}. Choose a dish to edit it.
          </p>
        </div>

        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-4 flex flex-wrap gap-3">
          <label className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-3 top-2.5 w-4 h-4 text-slate-400" />
            <input className={`${input} w-full pl-9`} placeholder="Search by dish" value={searchText} onChange={(e) => setSearchText(e.target.value)} />
          </label>
          <select className={input} value={filters.restaurantId} onChange={(e) => setFilter("restaurantId", e.target.value)} aria-label="Restaurant">
            <option value="">All restaurants</option>
            {restaurants.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
          <select className={input} value={filters.categoryId} onChange={(e) => setFilter("categoryId", e.target.value)} aria-label="Category">
            <option value="">All categories</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>

        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-4">
          {loading ? (
            <div className="py-16 text-center"><Loader2 className="w-6 h-6 animate-spin text-slate-400 mx-auto" /></div>
          ) : !foods.length ? (
            <p className="py-16 text-center text-sm text-slate-500">No dish photos match these filters.</p>
          ) : (
            <div className="grid gap-4 grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
              {foods.map((food) => (
                <Link key={food.id} to={editLink(food)} className="group rounded-lg border border-slate-200 overflow-hidden hover:border-blue-400 hover:shadow-sm">
                  <div className="relative aspect-square bg-slate-100">
                    <img src={food.image} alt={food.name} loading="lazy" className="h-full w-full object-cover" />
                    {food.imageCount > 1 && (
                      <span className="absolute right-1.5 top-1.5 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-semibold text-white">{food.imageCount} photos</span>
                    )}
                    <span className="absolute inset-0 hidden items-center justify-center bg-black/30 group-hover:flex">
                      <span className="inline-flex items-center gap-1 rounded bg-white px-2 py-1 text-xs font-semibold text-slate-800"><Pencil className="w-3 h-3" /> Edit</span>
                    </span>
                  </div>
                  <div className="p-2 space-y-0.5">
                    <p className="text-sm font-semibold text-slate-800 truncate" title={food.name}>{food.name}</p>
                    <p className="text-xs text-slate-500 truncate" title={food.restaurantName}>{food.restaurantName}</p>
                    <p className="text-xs text-slate-400 truncate">{food.categoryName || "Uncategorised"} · ₹{food.price}</p>
                    {food.approvalStatus !== "approved" && (
                      <span className="inline-block rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-amber-800">{food.approvalStatus}</span>
                    )}
                  </div>
                </Link>
              ))}
            </div>
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
