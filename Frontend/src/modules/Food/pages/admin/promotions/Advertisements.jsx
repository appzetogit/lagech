import { useEffect, useState } from "react"
import { Loader2, Megaphone, Plus, X } from "lucide-react"
import { toast } from "sonner"
import { adminAPI, uploadAPI } from "@food/api"

const STATES = [
  ["all", "All"],
  ["pending", "Requests"],
  ["running", "Running"],
  ["scheduled", "Scheduled"],
  ["paused", "Paused"],
  ["expired", "Expired"],
  ["denied", "Denied"],
]
const BADGE = {
  pending: "bg-amber-100 text-amber-800",
  running: "bg-emerald-100 text-emerald-800",
  scheduled: "bg-blue-100 text-blue-800",
  paused: "bg-slate-200 text-slate-700",
  expired: "bg-slate-100 text-slate-500",
  denied: "bg-rose-100 text-rose-700",
}
const day = (d) => (d ? new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "")
const iso = (d) => (d ? new Date(d).toISOString().slice(0, 10) : "")

/** Media upload: an image through the image endpoint, a video through the video one. */
async function uploadFile(file, kind) {
  const res =
    kind === "video"
      ? await uploadAPI.uploadVideo(file, { folder: "food/advertisements", contextModule: "admin" })
      : await uploadAPI.uploadMedia(file, { folder: "food/advertisements" })
  return res?.data?.data?.url || ""
}

function MediaField({ label, kind, value, onChange }) {
  const [busy, setBusy] = useState(false)
  const pick = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      setBusy(true)
      onChange(await uploadFile(file, kind))
    } catch (err) {
      toast.error(err?.response?.data?.message || err?.message || "Upload failed")
    } finally {
      setBusy(false)
      e.target.value = ""
    }
  }
  return (
    <div className="space-y-1">
      <span className="text-xs font-semibold text-slate-600">{label}</span>
      <div className="flex items-center gap-3">
        {value && (kind === "video"
          ? <video src={value} className="h-16 w-28 rounded object-cover bg-black" muted />
          : <img src={value} alt="" className="h-16 w-28 rounded object-cover border" />)}
        <label className="cursor-pointer rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50">
          {busy ? "Uploading…" : value ? "Replace" : "Upload"}
          <input type="file" className="sr-only" accept={kind === "video" ? "video/mp4,video/quicktime,video/webm" : "image/*"} onChange={pick} disabled={busy} />
        </label>
      </div>
    </div>
  )
}

function AdForm({ ad, restaurants, onClose, onSaved }) {
  const [form, setForm] = useState({
    restaurantId: ad?.restaurantId || "",
    type: ad?.type || "restaurant",
    title: ad?.title || "",
    description: ad?.description || "",
    coverImage: ad?.coverImage || "",
    logoImage: ad?.logoImage || "",
    videoUrl: ad?.videoUrl || "",
    startDate: iso(ad?.startDate) || iso(new Date()),
    endDate: iso(ad?.endDate) || iso(Date.now() + 7 * 864e5),
    priority: ad?.priority ?? "",
    showRating: ad?.showRating ?? true,
    showReviews: ad?.showReviews ?? true,
  })
  const [saving, setSaving] = useState(false)
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }))
  const input = "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"

  const save = async (e) => {
    e.preventDefault()
    try {
      setSaving(true)
      if (ad) await adminAPI.updateAdvertisement(ad.id, form)
      else await adminAPI.createAdvertisement(form)
      toast.success(ad ? "Advertisement saved" : "Advertisement placed")
      onSaved()
    } catch (err) {
      toast.error(err?.response?.data?.message || "Failed to save the advertisement")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
      <form onSubmit={save} className="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-xl bg-white p-6 shadow-xl space-y-4">
        <div className="flex items-start justify-between">
          <h3 className="text-lg font-bold text-slate-900">{ad ? "Edit advertisement" : "New advertisement"}</h3>
          <button type="button" onClick={onClose} aria-label="Close"><X className="w-5 h-5 text-slate-500" /></button>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1">
            <span className="text-xs font-semibold text-slate-600">Restaurant</span>
            <select className={input} value={form.restaurantId} onChange={(e) => set("restaurantId", e.target.value)} disabled={Boolean(ad)} required>
              <option value="">Choose</option>
              {restaurants.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </label>
          <label className="space-y-1">
            <span className="text-xs font-semibold text-slate-600">Type</span>
            <select className={input} value={form.type} onChange={(e) => set("type", e.target.value)}>
              <option value="restaurant">Restaurant card (cover + logo)</option>
              <option value="video">Video</option>
            </select>
          </label>
          <label className="space-y-1 sm:col-span-2">
            <span className="text-xs font-semibold text-slate-600">Title</span>
            <input className={input} maxLength={120} value={form.title} onChange={(e) => set("title", e.target.value)} required />
          </label>
          <label className="space-y-1 sm:col-span-2">
            <span className="text-xs font-semibold text-slate-600">Description</span>
            <textarea className={input} rows={2} maxLength={500} value={form.description} onChange={(e) => set("description", e.target.value)} />
          </label>
          {form.type === "video" ? (
            <MediaField label="Video (MP4, up to 50 MB)" kind="video" value={form.videoUrl} onChange={(v) => set("videoUrl", v)} />
          ) : (
            <>
              <MediaField label="Cover image" kind="image" value={form.coverImage} onChange={(v) => set("coverImage", v)} />
              <MediaField label="Logo (optional; the restaurant's own if blank)" kind="image" value={form.logoImage} onChange={(v) => set("logoImage", v)} />
            </>
          )}
          <label className="space-y-1">
            <span className="text-xs font-semibold text-slate-600">Start</span>
            <input type="date" className={input} value={form.startDate} onChange={(e) => set("startDate", e.target.value)} required />
          </label>
          <label className="space-y-1">
            <span className="text-xs font-semibold text-slate-600">End</span>
            <input type="date" className={input} value={form.endDate} onChange={(e) => set("endDate", e.target.value)} required />
          </label>
          <label className="space-y-1">
            <span className="text-xs font-semibold text-slate-600">Priority (1 shows first; blank = last)</span>
            <input type="number" min="0" className={input} value={form.priority} onChange={(e) => set("priority", e.target.value)} />
          </label>
          <div className="flex items-end gap-4 text-sm text-slate-700">
            <label className="flex items-center gap-2"><input type="checkbox" checked={form.showRating} onChange={(e) => set("showRating", e.target.checked)} /> Show rating</label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={form.showReviews} onChange={(e) => set("showReviews", e.target.checked)} /> Show review count</label>
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-lg border border-slate-300 px-4 py-2 text-sm">Cancel</button>
          <button type="submit" disabled={saving} className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60">
            {saving && <Loader2 className="w-4 h-4 animate-spin" />} {ad ? "Save" : "Place advertisement"}
          </button>
        </div>
      </form>
    </div>
  )
}

/** Restaurant advertisements: requests to decide, and what is running. */
export default function Advertisements() {
  const [data, setData] = useState({ ads: [], counts: {} })
  const [state, setState] = useState("all")
  const [loading, setLoading] = useState(true)
  const [restaurants, setRestaurants] = useState([])
  const [editing, setEditing] = useState(null) // null | {} (new) | ad

  const load = async () => {
    try {
      setLoading(true)
      const res = await adminAPI.getAdvertisements({ state })
      setData(res?.data?.data || { ads: [], counts: {} })
    } catch (err) {
      toast.error(err?.response?.data?.message || "Failed to load advertisements")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [state])

  useEffect(() => {
    adminAPI.getRestaurants({ limit: 1000 }).then((res) => {
      const d = res?.data?.data || {}
      const list = d.restaurants || d.items || d.docs || []
      setRestaurants(list.map((r) => ({ id: r.id || r._id, name: r.restaurantName || r.name })).filter((r) => r.id))
    }).catch(() => {})
  }, [])

  const decide = async (ad, status) => {
    let note = ""
    if (status !== "approved") {
      note = window.prompt(status === "denied" ? "Why is it denied? The restaurant sees this." : "Why is it paused?") || ""
      if (!note.trim()) return
    }
    try {
      await adminAPI.decideAdvertisement(ad.id, { status, note })
      toast.success({ approved: "Approved", denied: "Denied", paused: "Paused" }[status])
      load()
    } catch (err) {
      toast.error(err?.response?.data?.message || "Failed to update the advertisement")
    }
  }

  const remove = async (ad) => {
    if (!window.confirm(`Delete "${ad.title}"?`)) return
    try {
      await adminAPI.deleteAdvertisement(ad.id)
      load()
    } catch (err) {
      toast.error(err?.response?.data?.message || "Failed to delete")
    }
  }

  return (
    <div className="p-4 lg:p-6 bg-slate-50 min-h-screen">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-3">
              <Megaphone className="w-5 h-5 text-teal-700" />
              <h1 className="text-2xl font-bold text-slate-900">Advertisements</h1>
            </div>
            <p className="text-sm text-slate-600 mt-1 max-w-3xl">
              Restaurants promoting themselves in the customer app, as a card or a video. Restaurants send requests from their panel; approve, deny or pause them here, or place one directly. An approved ad runs between its dates.
            </p>
          </div>
          <button type="button" onClick={() => setEditing({})} className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white">
            <Plus className="w-4 h-4" /> New advertisement
          </button>
        </div>

        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
          <div className="flex flex-wrap gap-2 mb-4">
            {STATES.map(([key, label]) => (
              <button key={key} type="button" onClick={() => setState(key)}
                className={`rounded-full px-3 py-1 text-xs font-semibold ${state === key ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}>
                {label}{key !== "all" && data.counts?.[key] ? ` (${data.counts[key]})` : ""}
              </button>
            ))}
          </div>
          {loading ? (
            <div className="py-12 text-center"><Loader2 className="w-6 h-6 animate-spin text-slate-400 mx-auto" /></div>
          ) : !data.ads.length ? (
            <p className="py-12 text-center text-sm text-slate-500">No advertisements here.</p>
          ) : (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {data.ads.map((ad) => (
                <div key={ad.id} className="rounded-lg border border-slate-200 overflow-hidden">
                  <div className="aspect-video bg-slate-100">
                    {ad.type === "video" && ad.videoUrl
                      ? <video src={ad.videoUrl} className="h-full w-full object-cover" controls preload="metadata" />
                      : ad.coverImage && <img src={ad.coverImage} alt="" className="h-full w-full object-cover" />}
                  </div>
                  <div className="p-3 space-y-2">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="text-sm font-bold text-slate-900">{ad.title}</p>
                        <p className="text-xs text-slate-600">{ad.restaurantName} · {ad.type === "video" ? "Video" : "Card"}{ad.createdBy === "restaurant" ? " · requested" : ""}</p>
                      </div>
                      <span className={`shrink-0 rounded px-2 py-0.5 text-[10px] font-bold uppercase ${BADGE[ad.state] || ""}`}>{ad.state}</span>
                    </div>
                    <p className="text-xs text-slate-500">{day(ad.startDate)} – {day(ad.endDate)}{ad.priority != null ? ` · priority ${ad.priority}` : ""}</p>
                    {ad.note && <p className="text-xs text-rose-700">Note: {ad.note}</p>}
                    <div className="flex flex-wrap gap-1.5 pt-1">
                      {ad.state === "pending" && <button type="button" onClick={() => decide(ad, "approved")} className="rounded bg-emerald-600 px-2.5 py-1 text-xs font-semibold text-white">Approve</button>}
                      {ad.state === "pending" && <button type="button" onClick={() => decide(ad, "denied")} className="rounded border border-rose-300 px-2.5 py-1 text-xs font-semibold text-rose-700">Deny</button>}
                      {["running", "scheduled"].includes(ad.state) && <button type="button" onClick={() => decide(ad, "paused")} className="rounded border border-slate-300 px-2.5 py-1 text-xs font-semibold text-slate-700">Pause</button>}
                      {["paused", "denied"].includes(ad.state) && <button type="button" onClick={() => decide(ad, "approved")} className="rounded border border-emerald-500 px-2.5 py-1 text-xs font-semibold text-emerald-700">{ad.state === "paused" ? "Resume" : "Approve"}</button>}
                      <button type="button" onClick={() => setEditing(ad)} className="rounded border border-slate-300 px-2.5 py-1 text-xs font-semibold text-slate-700">Edit</button>
                      <button type="button" onClick={() => remove(ad)} className="rounded border border-slate-300 px-2.5 py-1 text-xs font-semibold text-slate-500">Delete</button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      {editing && (
        <AdForm
          ad={editing.id ? editing : null}
          restaurants={restaurants}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            load()
          }}
        />
      )}
    </div>
  )
}
