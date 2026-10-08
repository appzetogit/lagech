import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Search, Plus, Edit, Trash2, Upload, Image as ImageIcon, Loader2, X } from "@food/components/admin/theme/icons"
import api, { adminAPI } from "@food/api"
import { resolveMediaUrl } from "../../../../shared/utils/mediaUrl.js"

/**
 * Home banners, as the old Banners page had them: title, zone, type with its
 * target (a restaurant, a dish, or a link), a 3:1 image, Featured and Status.
 * Backed by food_hero_banners -- the carousel at the top of the customer app.
 */
const ADMIN = { contextModule: "admin" }

const TYPE_OPTIONS = [
  { value: "restaurant", label: "Restaurant wise" },
  { value: "food", label: "Food wise" },
  { value: "link", label: "Default (link)" },
]
const typeLabel = (value) => TYPE_OPTIONS.find((t) => t.value === value)?.label || value

const EMPTY_FORM = {
  title: "",
  zoneId: "",
  bannerType: "restaurant",
  restaurantId: "",
  linkedFoodId: "",
  ctaLink: "",
  isFeatured: false,
  file: null,
  preview: "",
}

const idOf = (row) => String(row?._id || row?.id || "")

function Switch({ checked, onChange, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      onClick={onChange}
      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${checked ? "bg-blue-600" : "bg-slate-300"}`}
    >
      <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${checked ? "translate-x-4" : "translate-x-0.5"}`} />
    </button>
  )
}

export default function Banners() {
  const [banners, setBanners] = useState([])
  const [zones, setZones] = useState([])
  const [restaurants, setRestaurants] = useState([])
  const [foods, setFoods] = useState([])
  const [foodRestaurantId, setFoodRestaurantId] = useState("")
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const [form, setForm] = useState(EMPTY_FORM)
  const [editing, setEditing] = useState(null)
  const [search, setSearch] = useState("")
  const [typeFilter, setTypeFilter] = useState("all")
  const fileInput = useRef(null)
  const formTop = useRef(null)

  const loadBanners = useCallback(async () => {
    try {
      setLoading(true)
      const response = await api.get("/food/hero-banners", ADMIN)
      setBanners(response.data?.data?.banners || [])
    } catch {
      setBanners([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadBanners()
    adminAPI.getZones({ limit: 1000 })
      .then((res) => setZones(res.data?.data?.zones || []))
      .catch(() => setZones([]))
    adminAPI.getRestaurants({ limit: 1000, status: "approved" })
      .then((res) => setRestaurants(res.data?.data?.restaurants || []))
      .catch(() => setRestaurants([]))
  }, [loadBanners])

  // Dishes are picked within a restaurant, so the list stays short.
  useEffect(() => {
    if (!foodRestaurantId) {
      setFoods([])
      return
    }
    let cancelled = false
    adminAPI.getFoods({ restaurantId: foodRestaurantId, approvalStatus: "approved", limit: 1000 })
      .then((res) => { if (!cancelled) setFoods(res.data?.data?.foods || []) })
      .catch(() => { if (!cancelled) setFoods([]) })
    return () => { cancelled = true }
  }, [foodRestaurantId])

  const zoneRestaurants = useMemo(
    () => restaurants.filter((r) => !form.zoneId || String(r.zoneId || "") === form.zoneId),
    [restaurants, form.zoneId]
  )

  const set = (field, value) => setForm((prev) => ({ ...prev, [field]: value }))

  const resetForm = () => {
    setForm(EMPTY_FORM)
    setEditing(null)
    setFoodRestaurantId("")
    setError("")
    if (fileInput.current) fileInput.current.value = ""
  }

  const handleFile = (event) => {
    const file = event.target.files?.[0]
    if (!file) return
    if (file.size > 2 * 1024 * 1024) {
      setError("Image must be 2 MB or smaller")
      return
    }
    setError("")
    setForm((prev) => ({ ...prev, file, preview: URL.createObjectURL(file) }))
  }

  const startEdit = (banner) => {
    setEditing(banner)
    setError("")
    setForm({
      title: banner.title || "",
      zoneId: banner.zoneId || "",
      bannerType: banner.bannerType || "restaurant",
      restaurantId: banner.linkedRestaurantIds?.[0] || "",
      linkedFoodId: banner.linkedFoodId || "",
      ctaLink: banner.ctaLink || "",
      isFeatured: Boolean(banner.isFeatured),
      file: null,
      preview: resolveMediaUrl(banner.imageUrl),
    })
    setFoodRestaurantId(banner.linkedFood?.restaurantId || "")
    formTop.current?.scrollIntoView({ behavior: "smooth" })
  }

  const handleSubmit = async (event) => {
    event.preventDefault()
    setError("")
    if (!form.title.trim()) return setError("Title is required")
    if (!editing && !form.file) return setError("Banner image is required")
    if (form.bannerType === "restaurant" && !form.restaurantId) return setError("Select a restaurant")
    if (form.bannerType === "food" && !form.linkedFoodId) return setError("Select a dish")

    const data = new FormData()
    if (form.file) data.append("file", form.file)
    data.append("title", form.title.trim())
    data.append("zoneId", form.zoneId || "all")
    data.append("bannerType", form.bannerType)
    if (form.bannerType === "restaurant") data.append("linkedRestaurantIds", JSON.stringify([form.restaurantId]))
    if (form.bannerType === "food") data.append("linkedFoodId", form.linkedFoodId)
    data.append("ctaLink", form.ctaLink.trim())
    data.append("isFeatured", String(form.isFeatured))

    try {
      setSaving(true)
      const config = { ...ADMIN, headers: { "Content-Type": "multipart/form-data" } }
      if (editing) await api.patch(`/food/hero-banners/${idOf(editing)}`, data, config)
      else await api.post("/food/hero-banners", data, config)
      resetForm()
      await loadBanners()
    } catch (err) {
      setError(err.response?.data?.message || "Failed to save banner")
    } finally {
      setSaving(false)
    }
  }

  const toggle = async (banner, field) => {
    const next = !banner[field]
    try {
      await api.patch(
        `/food/hero-banners/${idOf(banner)}/${field === "isActive" ? "status" : "featured"}`,
        { [field]: next },
        ADMIN
      )
      setBanners((prev) => prev.map((b) => (idOf(b) === idOf(banner) ? { ...b, [field]: next } : b)))
    } catch (err) {
      alert(err.response?.data?.message || "Failed to update banner")
    }
  }

  const remove = async (banner) => {
    if (!window.confirm("Delete this banner?")) return
    try {
      await api.delete(`/food/hero-banners/${idOf(banner)}`, ADMIN)
      if (editing && idOf(editing) === idOf(banner)) resetForm()
      await loadBanners()
    } catch (err) {
      alert(err.response?.data?.message || "Failed to delete banner")
    }
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return banners.filter((b) =>
      (typeFilter === "all" || b.bannerType === typeFilter) &&
      (!q || String(b.title || "").toLowerCase().includes(q))
    )
  }, [banners, search, typeFilter])

  const targetLabel = (banner) => {
    if (banner.bannerType === "restaurant") return banner.linkedRestaurantNames?.join(", ") || "Restaurant removed"
    if (banner.bannerType === "food") return banner.linkedFood?.name || "Dish removed"
    return banner.ctaLink || "No link"
  }

  const input = "w-full px-3 py-2.5 border border-slate-300 rounded-lg bg-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
  const label = "block text-sm font-semibold text-slate-700 mb-1.5"

  return (
    <div className="p-4 lg:p-6 bg-slate-50 min-h-screen">
      <div className="max-w-7xl mx-auto space-y-6">
        <div ref={formTop} className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
          <div className="flex items-center justify-between mb-5">
            <div className="flex items-center gap-3">
              {editing ? <Edit className="w-5 h-5 text-blue-600" /> : <Plus className="w-5 h-5 text-blue-600" />}
              <h1 className="text-2xl font-bold text-slate-900">{editing ? "Edit Banner" : "Add New Banner"}</h1>
            </div>
            {editing && (
              <button type="button" onClick={resetForm} className="flex items-center gap-1 text-sm text-slate-600 hover:text-slate-900">
                <X className="w-4 h-4" /> Cancel edit
              </button>
            )}
          </div>

          <form onSubmit={handleSubmit}>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <div className="space-y-4">
                <div>
                  <label className={label}>Title <span className="text-red-500">*</span></label>
                  <input value={form.title} onChange={(e) => set("title", e.target.value)} placeholder="New banner" className={input} />
                </div>
                <div>
                  <label className={label}>Zone</label>
                  <select value={form.zoneId} onChange={(e) => set("zoneId", e.target.value)} className={input}>
                    <option value="">All zones</option>
                    {zones.map((z) => <option key={idOf(z)} value={idOf(z)}>{z.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className={label}>Banner type <span className="text-red-500">*</span></label>
                  <select value={form.bannerType} onChange={(e) => set("bannerType", e.target.value)} className={input}>
                    {TYPE_OPTIONS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                  </select>
                </div>

                {form.bannerType === "restaurant" && (
                  <div>
                    <label className={label}>Restaurant <span className="text-red-500">*</span></label>
                    <select value={form.restaurantId} onChange={(e) => set("restaurantId", e.target.value)} className={input}>
                      <option value="">Select restaurant</option>
                      {zoneRestaurants.map((r) => <option key={idOf(r)} value={idOf(r)}>{r.restaurantName || r.name}</option>)}
                    </select>
                  </div>
                )}

                {form.bannerType === "food" && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className={label}>Restaurant</label>
                      <select
                        value={foodRestaurantId}
                        onChange={(e) => { setFoodRestaurantId(e.target.value); set("linkedFoodId", "") }}
                        className={input}
                      >
                        <option value="">Select restaurant</option>
                        {zoneRestaurants.map((r) => <option key={idOf(r)} value={idOf(r)}>{r.restaurantName || r.name}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className={label}>Dish <span className="text-red-500">*</span></label>
                      <select value={form.linkedFoodId} onChange={(e) => set("linkedFoodId", e.target.value)} className={input} disabled={!foodRestaurantId}>
                        <option value="">{foodRestaurantId ? "Select dish" : "Pick a restaurant first"}</option>
                        {foods.map((f) => <option key={idOf(f)} value={idOf(f)}>{f.name}</option>)}
                        {form.linkedFoodId && !foods.some((f) => idOf(f) === form.linkedFoodId) && (
                          <option value={form.linkedFoodId}>{editing?.linkedFood?.name || "Current dish"}</option>
                        )}
                      </select>
                    </div>
                  </div>
                )}

                <div>
                  <label className={label}>
                    Link {form.bannerType === "link" ? "" : <span className="font-normal text-slate-500">(optional)</span>}
                  </label>
                  <input
                    value={form.ctaLink}
                    onChange={(e) => set("ctaLink", e.target.value)}
                    placeholder="https://"
                    className={input}
                  />
                </div>

                <label className="flex items-center gap-2 text-sm text-slate-700">
                  <input type="checkbox" checked={form.isFeatured} onChange={(e) => set("isFeatured", e.target.checked)} className="h-4 w-4" />
                  Featured
                </label>
              </div>

              <div>
                <label className={label}>Banner image {editing ? "" : <span className="text-red-500">*</span>}</label>
                <button
                  type="button"
                  onClick={() => fileInput.current?.click()}
                  className="w-full aspect-[3/1] border-2 border-dashed border-slate-300 rounded-lg overflow-hidden flex items-center justify-center bg-slate-50 hover:border-blue-500 transition-colors"
                >
                  {form.preview ? (
                    <img src={form.preview} alt="" className="w-full h-full object-cover" />
                  ) : (
                    <div className="text-center">
                      <Upload className="w-10 h-10 text-slate-400 mx-auto mb-2" />
                      <p className="text-sm font-medium text-blue-600">Click to upload</p>
                    </div>
                  )}
                </button>
                <input ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp,image/gif" onChange={handleFile} className="hidden" />
                <p className="text-xs text-slate-500 mt-2">JPG, PNG, WebP or GIF, max 2 MB. Ratio 3:1.</p>
              </div>
            </div>

            {error && <p className="mt-4 text-sm text-red-600">{error}</p>}

            <div className="flex items-center justify-end gap-3 mt-6">
              <button type="button" onClick={resetForm} className="px-5 py-2.5 text-sm font-medium rounded-lg border border-slate-300 bg-white text-slate-700 hover:bg-slate-50">
                Reset
              </button>
              <button type="submit" disabled={saving} className="flex items-center gap-2 px-5 py-2.5 text-sm font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-60">
                {saving && <Loader2 className="w-4 h-4 animate-spin" />}
                {editing ? "Update" : "Submit"}
              </button>
            </div>
          </form>
        </div>

        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-4">
            <div className="flex items-center gap-2">
              <h2 className="text-xl font-bold text-slate-900">Banner List</h2>
              <span className="px-3 py-1 rounded-full text-sm font-semibold bg-slate-100 text-slate-700">{filtered.length}</span>
            </div>
            <div className="flex items-center gap-3">
              <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} className="px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white">
                <option value="all">All types</option>
                {TYPE_OPTIONS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
              <div className="relative min-w-[200px]">
                <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by title" className="pl-9 pr-3 py-2 w-full text-sm rounded-lg border border-slate-300" />
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              </div>
            </div>
          </div>

          {loading ? (
            <div className="py-10 flex items-center justify-center gap-2 text-sm text-slate-500">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading banners...
            </div>
          ) : filtered.length === 0 ? (
            <div className="py-10 text-center text-sm text-slate-500">
              <ImageIcon className="w-10 h-10 mx-auto mb-2 text-slate-300" />
              No banners found.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 border-b border-slate-200">
                  <tr className="text-left text-[11px] font-bold text-slate-700 uppercase tracking-wider">
                    <th className="px-4 py-3">SL</th>
                    <th className="px-4 py-3">Banner</th>
                    <th className="px-4 py-3">Zone</th>
                    <th className="px-4 py-3">Type</th>
                    <th className="px-4 py-3">Opens</th>
                    <th className="px-4 py-3 text-center">Featured</th>
                    <th className="px-4 py-3 text-center">Status</th>
                    <th className="px-4 py-3 text-center">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filtered.map((banner, index) => (
                    <tr key={idOf(banner)} className="hover:bg-slate-50">
                      <td className="px-4 py-3 text-slate-700">{index + 1}</td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          <img src={resolveMediaUrl(banner.imageUrl)} alt="" className="w-24 h-8 rounded object-cover bg-slate-100 flex-shrink-0" />
                          <span className="font-medium text-slate-900">{banner.title || "Untitled"}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-slate-700">{banner.zoneName || "All zones"}</td>
                      <td className="px-4 py-3 text-slate-700">{typeLabel(banner.bannerType)}</td>
                      <td className="px-4 py-3 text-slate-600 max-w-[220px] truncate" title={targetLabel(banner)}>{targetLabel(banner)}</td>
                      <td className="px-4 py-3 text-center"><Switch label="Featured" checked={Boolean(banner.isFeatured)} onChange={() => toggle(banner, "isFeatured")} /></td>
                      <td className="px-4 py-3 text-center"><Switch label="Status" checked={Boolean(banner.isActive)} onChange={() => toggle(banner, "isActive")} /></td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-center gap-1">
                          <button type="button" onClick={() => startEdit(banner)} className="p-1.5 rounded text-blue-600 hover:bg-blue-50" title="Edit">
                            <Edit className="w-4 h-4" />
                          </button>
                          <button type="button" onClick={() => remove(banner)} className="p-1.5 rounded text-red-600 hover:bg-red-50" title="Delete">
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
