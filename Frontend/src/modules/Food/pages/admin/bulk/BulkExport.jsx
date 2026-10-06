import { useEffect, useState } from "react"
import { Download, FileSpreadsheet, Loader2 } from "@food/components/admin/theme/icons"
import { toast } from "sonner"
import { adminAPI } from "@food/api"
import { adminCatalogExtrasAPI, blobErrorMessage, loadRestaurantOptions, saveBlobResponse } from "@food/api/adminCatalogExtras"

const COPY = {
  categories: { title: "Category Bulk Export", what: "global categories and sub-categories" },
  addons: { title: "Addon Bulk Export", what: "add-ons (deleted ones are left out)" },
  restaurants: { title: "Restaurant Bulk Export", what: "restaurants" },
  foods: { title: "Food Bulk Export", what: "dishes" },
}

/** Download the current categories, add-ons, restaurants or foods as CSV or Excel. */
export default function BulkExport({ entity }) {
  const copy = COPY[entity]
  const [format, setFormat] = useState("xlsx")
  const [filters, setFilters] = useState({})
  const [restaurants, setRestaurants] = useState([])
  const [categories, setCategories] = useState([])
  const [busy, setBusy] = useState(false)
  const set = (k, v) => setFilters((f) => ({ ...f, [k]: v }))

  useEffect(() => {
    if (entity !== "addons" && entity !== "foods") return
    loadRestaurantOptions(adminAPI).then(setRestaurants).catch(() => {})
    if (entity !== "foods") return
    // Top-level categories: choosing one also exports its sub-categories' dishes.
    adminAPI
      .getCategories({ parentId: "root", limit: 1000 })
      .then((res) => {
        const list = res?.data?.data?.categories || []
        setCategories(
          list
            .map((c) => ({ id: String(c.id || c._id || ""), name: String(c.name || "").trim() }))
            .filter((c) => c.id && c.name)
            .sort((a, b) => a.name.localeCompare(b.name)),
        )
      })
      .catch(() => {})
  }, [entity])

  const run = async () => {
    try {
      setBusy(true)
      const params = { format, ...Object.fromEntries(Object.entries(filters).filter(([, v]) => v)) }
      const res = await adminCatalogExtrasAPI.bulkExport(entity, params)
      saveBlobResponse(res, `${entity}.${format}`)
    } catch (err) {
      toast.error(await blobErrorMessage(err, "Export failed"))
    } finally {
      setBusy(false)
    }
  }

  const select = "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm bg-white"

  return (
    <div className="p-4 lg:p-6 bg-slate-50 min-h-screen">
      <div className="max-w-3xl mx-auto space-y-6">
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
          <div className="flex items-center gap-3">
            <FileSpreadsheet className="w-5 h-5 text-blue-600" />
            <h1 className="text-2xl font-bold text-slate-900">{copy.title}</h1>
          </div>
          <p className="text-sm text-slate-600 mt-1">
            Download the current {copy.what}. The file uses the import template's columns, so it can be edited and imported back.
          </p>
        </div>

        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block space-y-1">
              <span className="text-xs font-semibold text-slate-600">File type</span>
              <select className={select} value={format} onChange={(e) => setFormat(e.target.value)}>
                <option value="xlsx">Excel (.xlsx)</option>
                <option value="csv">CSV</option>
              </select>
            </label>

            {entity === "categories" && (
              <label className="block space-y-1">
                <span className="text-xs font-semibold text-slate-600">Which categories</span>
                <select className={select} value={filters.parentId || ""} onChange={(e) => set("parentId", e.target.value)}>
                  <option value="">All</option>
                  <option value="root">Top-level only</option>
                  <option value="sub">Sub-categories only</option>
                </select>
              </label>
            )}

            {entity === "addons" && (
              <>
                <label className="block space-y-1">
                  <span className="text-xs font-semibold text-slate-600">Restaurant</span>
                  <select className={select} value={filters.restaurantId || ""} onChange={(e) => set("restaurantId", e.target.value)}>
                    <option value="">All restaurants</option>
                    {restaurants.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                  </select>
                </label>
                <label className="block space-y-1">
                  <span className="text-xs font-semibold text-slate-600">Approval</span>
                  <select className={select} value={filters.approvalStatus || ""} onChange={(e) => set("approvalStatus", e.target.value)}>
                    <option value="">Any</option>
                    <option value="approved">Approved</option>
                    <option value="pending">Pending</option>
                    <option value="rejected">Rejected</option>
                  </select>
                </label>
              </>
            )}

            {entity === "foods" && (
              <>
                <label className="block space-y-1">
                  <span className="text-xs font-semibold text-slate-600">Restaurant</span>
                  <select className={select} value={filters.restaurantId || ""} onChange={(e) => set("restaurantId", e.target.value)}>
                    <option value="">All restaurants</option>
                    {restaurants.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                  </select>
                </label>
                <label className="block space-y-1">
                  <span className="text-xs font-semibold text-slate-600">Category</span>
                  <select className={select} value={filters.categoryId || ""} onChange={(e) => set("categoryId", e.target.value)}>
                    <option value="">All categories</option>
                    {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </label>
                <label className="block space-y-1">
                  <span className="text-xs font-semibold text-slate-600">Approval</span>
                  <select className={select} value={filters.approvalStatus || ""} onChange={(e) => set("approvalStatus", e.target.value)}>
                    <option value="">Any</option>
                    <option value="approved">Approved</option>
                    <option value="pending">Pending</option>
                    <option value="rejected">Rejected</option>
                  </select>
                </label>
                <label className="block space-y-1">
                  <span className="text-xs font-semibold text-slate-600">Status</span>
                  <select className={select} value={filters.available || ""} onChange={(e) => set("available", e.target.value)}>
                    <option value="">Any</option>
                    <option value="yes">Available</option>
                    <option value="no">Unavailable</option>
                  </select>
                </label>
              </>
            )}

            {entity === "restaurants" && (
              <label className="block space-y-1">
                <span className="text-xs font-semibold text-slate-600">Status</span>
                <select className={select} value={filters.status || ""} onChange={(e) => set("status", e.target.value)}>
                  <option value="">Any</option>
                  <option value="approved">Approved</option>
                  <option value="pending">Pending</option>
                  <option value="rejected">Rejected</option>
                </select>
              </label>
            )}
          </div>

          <div className="flex justify-end">
            <button type="button" onClick={run} disabled={busy} className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60">
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />} Export
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
