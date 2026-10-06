import { useEffect, useMemo, useState } from "react"
import { Layers, Loader2, Pencil, Plus, Store, Trash2, X } from "@food/components/admin/theme/icons"
import { toast } from "sonner"
import { adminAPI } from "@food/api"
import { adminCatalogExtrasAPI, errorMessage, loadRestaurantOptions } from "@food/api/adminCatalogExtras"
import ExportMenu from "@food/components/admin/ExportMenu"
import { exportDate } from "@food/utils/listExport"
import { ImageUpload, STATE_BADGE, STATE_LABEL, STATE_TABS, formatWhen, fromLocalInput, toLocalInput } from "./campaignShared"

const EXPORT_COLUMNS = [
  { label: "Sl", value: (_c, index) => index + 1 },
  { label: "Title", value: (c) => c.title },
  { label: "Description", value: (c) => c.description },
  { label: "Starts", value: (c) => exportDate(c.startsAt) },
  { label: "Ends", value: (c) => exportDate(c.endsAt) },
  { label: "Restaurants", value: (c) => Number(c.restaurantCount || 0) },
  { label: "Status", value: (c) => STATE_LABEL[c.state] || c.state },
]

function CampaignForm({ campaign, onClose, onSaved }) {
  const [form, setForm] = useState({
    title: campaign?.title || "",
    description: campaign?.description || "",
    image: campaign?.image || "",
    startsAt: toLocalInput(campaign?.startsAt),
    endsAt: toLocalInput(campaign?.endsAt),
    isActive: campaign?.isActive ?? true,
  })
  const [busy, setBusy] = useState(false)
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }))
  const input = "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"

  const save = async (e) => {
    e.preventDefault()
    try {
      setBusy(true)
      const body = { ...form, startsAt: fromLocalInput(form.startsAt), endsAt: fromLocalInput(form.endsAt) }
      if (campaign) await adminCatalogExtrasAPI.updateBasicCampaign(campaign.id, body)
      else await adminCatalogExtrasAPI.createBasicCampaign(body)
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
      <form onSubmit={save} className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-xl bg-white p-6 shadow-xl space-y-4">
        <div className="flex items-start justify-between">
          <h3 className="text-lg font-bold text-slate-900">{campaign ? "Edit campaign" : "New basic campaign"}</h3>
          <button type="button" onClick={onClose} aria-label="Close"><X className="w-5 h-5 text-slate-500" /></button>
        </div>
        <label className="block space-y-1">
          <span className="text-xs font-semibold text-slate-600">Title</span>
          <input className={input} maxLength={120} value={form.title} onChange={(e) => set("title", e.target.value)} required />
        </label>
        <label className="block space-y-1">
          <span className="text-xs font-semibold text-slate-600">Description</span>
          <textarea className={input} rows={3} maxLength={1000} value={form.description} onChange={(e) => set("description", e.target.value)} />
        </label>
        <div className="space-y-1">
          <span className="text-xs font-semibold text-slate-600">Banner image</span>
          <ImageUpload value={form.image} onChange={(v) => set("image", v)} folder="food/campaigns" />
        </div>
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

function Participants({ campaign, restaurants, onClose, onChanged }) {
  const [list, setList] = useState([])
  const [loading, setLoading] = useState(true)
  const [choice, setChoice] = useState("")
  const [busy, setBusy] = useState("")

  const load = () =>
    adminCatalogExtrasAPI
      .getCampaignRestaurants(campaign.id)
      .then((res) => setList(res?.data?.data?.restaurants || []))
      .catch((err) => toast.error(errorMessage(err, "Failed to load restaurants")))
      .finally(() => setLoading(false))

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaign.id])

  const available = useMemo(
    () => restaurants.filter((r) => (!r.status || r.status === "approved") && !list.some((x) => x.id === r.id)),
    [restaurants, list],
  )

  const join = async () => {
    try {
      setBusy("add")
      await adminCatalogExtrasAPI.addCampaignRestaurant(campaign.id, choice)
      setChoice("")
      await load()
      onChanged()
    } catch (err) {
      toast.error(errorMessage(err, "Could not add the restaurant"))
    } finally {
      setBusy("")
    }
  }
  const leave = async (id) => {
    try {
      setBusy(id)
      await adminCatalogExtrasAPI.removeCampaignRestaurant(campaign.id, id)
      setList((l) => l.filter((r) => r.id !== id))
      onChanged()
    } catch (err) {
      toast.error(errorMessage(err, "Could not remove the restaurant"))
    } finally {
      setBusy("")
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-xl bg-white p-6 shadow-xl space-y-4">
        <div className="flex items-start justify-between">
          <div>
            <h3 className="text-lg font-bold text-slate-900">Restaurants taking part</h3>
            <p className="text-sm text-slate-500">{campaign.title}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close"><X className="w-5 h-5 text-slate-500" /></button>
        </div>
        <div className="flex gap-2">
          <select value={choice} onChange={(e) => setChoice(e.target.value)} className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm bg-white" aria-label="Restaurant to add">
            <option value="">Choose an approved restaurant</option>
            {available.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
          <button type="button" onClick={join} disabled={!choice || busy === "add"} className="inline-flex items-center gap-1 rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">
            <Plus className="w-4 h-4" /> Add
          </button>
        </div>
        {loading ? (
          <div className="py-8 text-center"><Loader2 className="w-5 h-5 animate-spin text-slate-400 mx-auto" /></div>
        ) : !list.length ? (
          <p className="py-8 text-center text-sm text-slate-500">No restaurants have joined yet.</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {list.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-3 py-2">
                <span className="text-sm text-slate-800">{r.name}</span>
                <button type="button" disabled={busy === r.id} onClick={() => leave(r.id)} className="text-xs text-rose-600 hover:underline">Remove</button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

/** Basic campaigns: a promotion with a banner and a schedule that restaurants take part in. */
export default function BasicCampaign() {
  const [data, setData] = useState({ campaigns: [], counts: {} })
  const [state, setState] = useState("")
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(null)
  const [participantsFor, setParticipantsFor] = useState(null)
  const [restaurants, setRestaurants] = useState([])

  const load = async () => {
    try {
      setLoading(true)
      const res = await adminCatalogExtrasAPI.getBasicCampaigns(state ? { state } : {})
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
  }, [state])

  useEffect(() => {
    loadRestaurantOptions(adminAPI).then(setRestaurants).catch(() => {})
  }, [])

  const remove = async (c) => {
    if (!window.confirm(`Delete "${c.title}"?`)) return
    try {
      await adminCatalogExtrasAPI.deleteBasicCampaign(c.id)
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
              <h1 className="text-2xl font-bold text-slate-900">Basic Campaign</h1>
            </div>
            <p className="text-sm text-slate-600 mt-1">Promotions restaurants take part in. Customers see a campaign while it is switched on and between its start and end.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {/* The list endpoint is unpaged, so data.campaigns is every campaign in the chosen tab. */}
            <ExportMenu filename="basic_campaigns" sheetName="Basic Campaigns" columns={EXPORT_COLUMNS} getRows={() => data.campaigns} disabled={loading} className="py-2" />
            <button type="button" onClick={() => setEditing({})} className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white">
              <Plus className="w-4 h-4" /> New campaign
            </button>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          {STATE_TABS.map(([key, label]) => (
            <button key={key || "all"} type="button" onClick={() => setState(key)} className={`rounded-lg px-3 py-1.5 text-sm font-medium border ${state === key ? "bg-blue-600 text-white border-blue-600" : "bg-white text-slate-700 border-slate-300"}`}>
              {label} {key ? `(${data.counts?.[key] || 0})` : `(${total})`}
            </button>
          ))}
        </div>

        <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-x-auto">
          {loading ? (
            <div className="py-16 text-center"><Loader2 className="w-6 h-6 animate-spin text-slate-400 mx-auto" /></div>
          ) : !data.campaigns.length ? (
            <p className="py-16 text-center text-sm text-slate-500">No campaigns here yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-left text-slate-600">
                  <th className="px-4 py-3 font-semibold">Campaign</th>
                  <th className="px-4 py-3 font-semibold">Schedule</th>
                  <th className="px-4 py-3 font-semibold">Restaurants</th>
                  <th className="px-4 py-3 font-semibold">Status</th>
                  <th className="px-4 py-3 font-semibold text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {data.campaigns.map((c) => (
                  <tr key={c.id} className="border-b border-slate-100 align-top">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        {c.image ? <img src={c.image} alt="" className="h-12 w-20 rounded object-cover border" /> : <div className="h-12 w-20 rounded bg-slate-100" />}
                        <div>
                          <p className="font-medium text-slate-800">{c.title}</p>
                          {c.description && <p className="text-xs text-slate-500 line-clamp-2 max-w-xs">{c.description}</p>}
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-600 whitespace-nowrap">{formatWhen(c.startsAt)}<br />to {formatWhen(c.endsAt)}</td>
                    <td className="px-4 py-3">
                      <button type="button" onClick={() => setParticipantsFor(c)} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-medium">
                        <Store className="w-3.5 h-3.5" /> {c.restaurantCount} · Manage
                      </button>
                    </td>
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
        <CampaignForm campaign={editing.id ? editing : null} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load() }} />
      )}
      {participantsFor && (
        <Participants campaign={participantsFor} restaurants={restaurants} onClose={() => setParticipantsFor(null)} onChanged={load} />
      )}
    </div>
  )
}
