import { useEffect, useState } from "react"
import { Layers, Loader2, Pencil, Plus, Trash2, X } from "@food/components/admin/theme/icons"
import { toast } from "sonner"
import { adminAPI } from "@food/api"
import { adminCatalogExtrasAPI, errorMessage, loadRestaurantOptions } from "@food/api/adminCatalogExtras"
import ExportMenu from "@food/components/admin/ExportMenu"
import { exportDate, exportMoney } from "@food/utils/listExport"
import { ImageUpload, STATE_BADGE, STATE_LABEL, STATE_TABS, formatWhen, fromLocalInput, toLocalInput } from "./campaignShared"

const EXPORT_COLUMNS = [
  { label: "Sl", value: (_c, index) => index + 1 },
  { label: "Title", value: (c) => c.title },
  { label: "Restaurant", value: (c) => c.restaurantName },
  { label: "Food Type", value: (c) => c.foodType },
  { label: "Price", value: (c) => exportMoney(c.price) },
  { label: "Discount", value: (c) => (Number(c.discount) > 0 ? (c.discountType === "percent" ? `${c.discount}%` : exportMoney(c.discount)) : "") },
  { label: "Final Price", value: (c) => exportMoney(c.finalPrice) },
  { label: "Starts", value: (c) => exportDate(c.startsAt) },
  { label: "Ends", value: (c) => exportDate(c.endsAt) },
  { label: "Status", value: (c) => STATE_LABEL[c.state] || c.state },
]

const finalPrice = (price, type, discount) => {
  const p = Number(price) || 0
  const d = Number(discount) || 0
  return Math.max(0, Math.round((p - (type === "percent" ? (p * d) / 100 : d)) * 100) / 100)
}

function FoodCampaignForm({ campaign, restaurants, onClose, onSaved }) {
  const [form, setForm] = useState({
    restaurantId: campaign?.restaurantId || "",
    title: campaign?.title || "",
    description: campaign?.description || "",
    image: campaign?.image || "",
    price: campaign?.price ?? "",
    discountType: campaign?.discountType || "percent",
    discount: campaign?.discount ?? 0,
    foodType: campaign?.foodType || "Veg",
    startsAt: toLocalInput(campaign?.startsAt),
    endsAt: toLocalInput(campaign?.endsAt),
    isActive: campaign?.isActive ?? true,
  })
  const [busy, setBusy] = useState(false)
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }))
  const input = "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm bg-white"

  const save = async (e) => {
    e.preventDefault()
    try {
      setBusy(true)
      const body = {
        ...form,
        price: Number(form.price),
        discount: Number(form.discount) || 0,
        startsAt: fromLocalInput(form.startsAt),
        endsAt: fromLocalInput(form.endsAt),
      }
      if (campaign) await adminCatalogExtrasAPI.updateFoodCampaign(campaign.id, body)
      else await adminCatalogExtrasAPI.createFoodCampaign(body)
      toast.success(campaign ? "Campaign saved" : "Campaign created")
      onSaved()
    } catch (err) {
      toast.error(errorMessage(err, "Failed to save the campaign"))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
      <form onSubmit={save} className="w-full max-w-xl max-h-[90vh] overflow-y-auto rounded-xl bg-white p-6 shadow-xl space-y-4">
        <div className="flex items-start justify-between">
          <h3 className="text-lg font-bold text-slate-900">{campaign ? "Edit food campaign" : "New food campaign"}</h3>
          <button type="button" onClick={onClose} aria-label="Close"><X className="w-5 h-5 text-slate-500" /></button>
        </div>
        <label className="block space-y-1">
          <span className="text-xs font-semibold text-slate-600">Restaurant</span>
          <select className={input} value={form.restaurantId} onChange={(e) => set("restaurantId", e.target.value)} required>
            <option value="">Choose an approved restaurant</option>
            {restaurants.filter((r) => !r.status || r.status === "approved" || r.id === form.restaurantId).map((r) => (
              <option key={r.id} value={r.id}>{r.name}</option>
            ))}
          </select>
        </label>
        <label className="block space-y-1">
          <span className="text-xs font-semibold text-slate-600">Dish name</span>
          <input className={input} maxLength={120} value={form.title} onChange={(e) => set("title", e.target.value)} required />
        </label>
        <label className="block space-y-1">
          <span className="text-xs font-semibold text-slate-600">Description</span>
          <textarea className={input} rows={2} maxLength={1000} value={form.description} onChange={(e) => set("description", e.target.value)} />
        </label>
        <div className="space-y-1">
          <span className="text-xs font-semibold text-slate-600">Image</span>
          <ImageUpload value={form.image} onChange={(v) => set("image", v)} folder="food/campaigns" />
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <label className="block space-y-1">
            <span className="text-xs font-semibold text-slate-600">Price (₹)</span>
            <input type="number" min="0" step="0.01" className={input} value={form.price} onChange={(e) => set("price", e.target.value)} required />
          </label>
          <label className="block space-y-1">
            <span className="text-xs font-semibold text-slate-600">Discount type</span>
            <select className={input} value={form.discountType} onChange={(e) => set("discountType", e.target.value)}>
              <option value="percent">Percent</option>
              <option value="amount">Amount (₹)</option>
            </select>
          </label>
          <label className="block space-y-1">
            <span className="text-xs font-semibold text-slate-600">Discount</span>
            <input type="number" min="0" step="0.01" className={input} value={form.discount} onChange={(e) => set("discount", e.target.value)} />
          </label>
          <label className="block space-y-1">
            <span className="text-xs font-semibold text-slate-600">Food type</span>
            <select className={input} value={form.foodType} onChange={(e) => set("foodType", e.target.value)}>
              <option value="Veg">Veg</option>
              <option value="Non-Veg">Non-Veg</option>
            </select>
          </label>
        </div>
        {Number(form.price) > 0 && (
          <p className="text-sm text-slate-600">Customer pays <b>₹{finalPrice(form.price, form.discountType, form.discount)}</b></p>
        )}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="block space-y-1">
            <span className="text-xs font-semibold text-slate-600">Starts</span>
            <input type="datetime-local" className={input} value={form.startsAt} onChange={(e) => set("startsAt", e.target.value)} required />
          </label>
          <label className="block space-y-1">
            <span className="text-xs font-semibold text-slate-600">Ends</span>
            <input type="datetime-local" className={input} value={form.endsAt} onChange={(e) => set("endsAt", e.target.value)} required />
          </label>
        </div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.isActive} onChange={(e) => set("isActive", e.target.checked)} /> Switched on</label>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-lg border border-slate-300 px-4 py-2 text-sm">Cancel</button>
          <button type="submit" disabled={busy} className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60">
            {busy && <Loader2 className="w-4 h-4 animate-spin" />} Save
          </button>
        </div>
      </form>
    </div>
  )
}

/** Food campaigns: one special dish from one restaurant, on offer for a while. */
export default function FoodCampaign() {
  const [data, setData] = useState({ campaigns: [], counts: {} })
  const [state, setState] = useState("")
  const [restaurantId, setRestaurantId] = useState("")
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(null)
  const [restaurants, setRestaurants] = useState([])

  const load = async () => {
    try {
      setLoading(true)
      const params = {}
      if (state) params.state = state
      if (restaurantId) params.restaurantId = restaurantId
      const res = await adminCatalogExtrasAPI.getFoodCampaigns(params)
      setData(res?.data?.data || { campaigns: [], counts: {} })
    } catch (err) {
      toast.error(errorMessage(err, "Failed to load campaigns"))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, restaurantId])

  useEffect(() => {
    loadRestaurantOptions(adminAPI).then(setRestaurants).catch(() => {})
  }, [])

  const remove = async (c) => {
    if (!window.confirm(`Delete "${c.title}"?`)) return
    try {
      await adminCatalogExtrasAPI.deleteFoodCampaign(c.id)
      load()
    } catch (err) {
      toast.error(errorMessage(err, "Failed to delete"))
    }
  }

  const total = Object.values(data.counts || {}).reduce((a, b) => a + b, 0)

  return (
    <div className="p-4 lg:p-6 bg-slate-50 min-h-screen">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-3">
              <Layers className="w-5 h-5 text-blue-600" />
              <h1 className="text-2xl font-bold text-slate-900">Food Campaign</h1>
            </div>
            <p className="text-sm text-slate-600 mt-1">A special dish from one restaurant with its own price and discount, shown to customers between its start and end.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {/* The list endpoint is unpaged, so data.campaigns is every campaign for the chosen tab and restaurant. */}
            <ExportMenu filename="food_campaigns" sheetName="Food Campaigns" columns={EXPORT_COLUMNS} getRows={() => data.campaigns} disabled={loading} className="py-2" />
            <button type="button" onClick={() => setEditing({})} className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white">
              <Plus className="w-4 h-4" /> New food campaign
            </button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {STATE_TABS.map(([key, label]) => (
            <button key={key || "all"} type="button" onClick={() => setState(key)} className={`rounded-lg px-3 py-1.5 text-sm font-medium border ${state === key ? "bg-blue-600 text-white border-blue-600" : "bg-white text-slate-700 border-slate-300"}`}>
              {label} {key ? `(${data.counts?.[key] || 0})` : `(${total})`}
            </button>
          ))}
          <select value={restaurantId} onChange={(e) => setRestaurantId(e.target.value)} className="ml-auto rounded-lg border border-slate-300 px-3 py-1.5 text-sm bg-white" aria-label="Restaurant">
            <option value="">All restaurants</option>
            {restaurants.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </div>

        <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-x-auto">
          {loading ? (
            <div className="py-16 text-center"><Loader2 className="w-6 h-6 animate-spin text-slate-400 mx-auto" /></div>
          ) : !data.campaigns.length ? (
            <p className="py-16 text-center text-sm text-slate-500">No food campaigns here yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-left text-slate-600">
                  <th className="px-4 py-3 font-semibold">Dish</th>
                  <th className="px-4 py-3 font-semibold">Restaurant</th>
                  <th className="px-4 py-3 font-semibold">Price</th>
                  <th className="px-4 py-3 font-semibold">Schedule</th>
                  <th className="px-4 py-3 font-semibold">Status</th>
                  <th className="px-4 py-3 font-semibold text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {data.campaigns.map((c) => (
                  <tr key={c.id} className="border-b border-slate-100 align-top">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        {c.image ? <img src={c.image} alt="" className="h-12 w-12 rounded object-cover border" /> : <div className="h-12 w-12 rounded bg-slate-100" />}
                        <div>
                          <p className="font-medium text-slate-800">{c.title}</p>
                          <p className="text-xs text-slate-500">{c.foodType}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-slate-700">{c.restaurantName}</td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <span className="font-semibold text-slate-800">₹{c.finalPrice}</span>
                      {c.discount > 0 && <span className="ml-1.5 text-xs text-slate-400 line-through">₹{c.price}</span>}
                      {c.discount > 0 && <p className="text-xs text-emerald-700">{c.discountType === "percent" ? `${c.discount}% off` : `₹${c.discount} off`}</p>}
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-600 whitespace-nowrap">{formatWhen(c.startsAt)}<br />to {formatWhen(c.endsAt)}</td>
                    <td className="px-4 py-3"><span className={`rounded px-2 py-0.5 text-xs font-semibold ${STATE_BADGE[c.state] || ""}`}>{STATE_LABEL[c.state] || c.state}</span></td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      <button type="button" onClick={() => setEditing(c)} className="p-1.5 rounded text-blue-600 hover:bg-blue-50" title="Edit"><Pencil className="w-4 h-4" /></button>
                      <button type="button" onClick={() => remove(c)} className="p-1.5 rounded text-rose-600 hover:bg-rose-50" title="Delete"><Trash2 className="w-4 h-4" /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
      {editing && (
        <FoodCampaignForm campaign={editing.id ? editing : null} restaurants={restaurants} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load() }} />
      )}
    </div>
  )
}
