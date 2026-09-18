import { useEffect, useState } from "react"
import { Camera, Eye, Heart, Loader2, Plus, Store, X } from "lucide-react"
import { toast } from "sonner"
import { adminAPI, uploadAPI } from "@food/api"

const iso = (d) => (d ? new Date(d).toISOString().slice(0, 10) : "")
const BADGE = {
  showing: "bg-emerald-100 text-emerald-800",
  scheduled: "bg-blue-100 text-blue-800",
  expired: "bg-slate-100 text-slate-500",
  off: "bg-slate-200 text-slate-700",
}

function ReelForm({ reel, restaurants, onClose, onSaved }) {
  const [form, setForm] = useState({
    restaurantId: reel?.restaurantId || "",
    description: reel?.description || "",
    videoUrl: reel?.videoUrl || "",
    thumbnail: reel?.thumbnail || "",
    alwaysVisible: reel?.alwaysVisible ?? true,
    startDate: iso(reel?.startDate),
    endDate: iso(reel?.endDate),
    isActive: reel?.isActive ?? true,
    sortOrder: reel?.sortOrder ?? 0,
  })
  const [busy, setBusy] = useState("")
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }))
  const input = "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"

  const upload = async (e, kind) => {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      setBusy(kind)
      const res = kind === "video"
        ? await uploadAPI.uploadVideo(file, { folder: "food/reels", contextModule: "admin" })
        : await uploadAPI.uploadMedia(file, { folder: "food/reels" })
      set(kind === "video" ? "videoUrl" : "thumbnail", res?.data?.data?.url || "")
    } catch (err) {
      toast.error(err?.response?.data?.message || err?.message || "Upload failed")
    } finally {
      setBusy("")
      e.target.value = ""
    }
  }

  const save = async (e) => {
    e.preventDefault()
    try {
      setBusy("save")
      const body = { ...form, startDate: form.alwaysVisible ? null : form.startDate, endDate: form.alwaysVisible ? null : form.endDate }
      if (reel) await adminAPI.updateReel(reel.id, body)
      else await adminAPI.createReel(body)
      toast.success(reel ? "Reel saved" : "Reel added")
      onSaved()
    } catch (err) {
      toast.error(err?.response?.data?.message || "Failed to save the reel")
    } finally {
      setBusy("")
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
      <form onSubmit={save} className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-xl bg-white p-6 shadow-xl space-y-4">
        <div className="flex items-start justify-between">
          <h3 className="text-lg font-bold text-slate-900">{reel ? "Edit reel" : "New reel"}</h3>
          <button type="button" onClick={onClose} aria-label="Close"><X className="w-5 h-5 text-slate-500" /></button>
        </div>
        <label className="block space-y-1">
          <span className="text-xs font-semibold text-slate-600">Restaurant</span>
          <select className={input} value={form.restaurantId} onChange={(e) => set("restaurantId", e.target.value)} required>
            <option value="">Choose</option>
            {restaurants.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </label>
        <div className="flex flex-wrap items-center gap-3">
          {form.videoUrl && <video src={form.videoUrl} className="h-28 w-20 rounded bg-black object-cover" muted controls />}
          <label className="cursor-pointer rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium">
            {busy === "video" ? "Uploading…" : form.videoUrl ? "Replace video" : "Upload video (MP4, up to 50 MB)"}
            <input type="file" className="sr-only" accept="video/mp4,video/quicktime,video/webm" onChange={(e) => upload(e, "video")} />
          </label>
          {form.thumbnail && <img src={form.thumbnail} alt="" className="h-28 w-20 rounded object-cover border" />}
          <label className="cursor-pointer rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium">
            {busy === "image" ? "Uploading…" : form.thumbnail ? "Replace cover" : "Cover image (optional)"}
            <input type="file" className="sr-only" accept="image/*" onChange={(e) => upload(e, "image")} />
          </label>
        </div>
        <label className="block space-y-1">
          <span className="text-xs font-semibold text-slate-600">Caption</span>
          <input className={input} maxLength={300} value={form.description} onChange={(e) => set("description", e.target.value)} />
        </label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.alwaysVisible} onChange={(e) => set("alwaysVisible", e.target.checked)} /> Always show (no dates)</label>
        {!form.alwaysVisible && (
          <div className="grid grid-cols-2 gap-3">
            <input type="date" className={input} value={form.startDate} onChange={(e) => set("startDate", e.target.value)} required />
            <input type="date" className={input} value={form.endDate} onChange={(e) => set("endDate", e.target.value)} required />
          </div>
        )}
        <div className="flex items-center gap-4 text-sm">
          <label className="flex items-center gap-2"><input type="checkbox" checked={form.isActive} onChange={(e) => set("isActive", e.target.checked)} /> Switched on</label>
          <label className="flex items-center gap-2">Order <input type="number" className="w-20 rounded border border-slate-300 px-2 py-1" value={form.sortOrder} onChange={(e) => set("sortOrder", e.target.value)} /></label>
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-lg border border-slate-300 px-4 py-2 text-sm">Cancel</button>
          <button type="submit" disabled={Boolean(busy) || !form.videoUrl} className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60">
            {busy === "save" && <Loader2 className="w-4 h-4 animate-spin" />} Save
          </button>
        </div>
      </form>
    </div>
  )
}

/** Short restaurant videos shown in the customer app. */
export default function Reels() {
  const [reels, setReels] = useState([])
  const [loading, setLoading] = useState(true)
  const [restaurants, setRestaurants] = useState([])
  const [editing, setEditing] = useState(null)

  const load = async () => {
    try {
      setLoading(true)
      const res = await adminAPI.getReels()
      setReels(res?.data?.data?.reels || [])
    } catch (err) {
      toast.error(err?.response?.data?.message || "Failed to load reels")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    adminAPI.getRestaurants({ limit: 1000 }).then((res) => {
      const d = res?.data?.data || {}
      const list = d.restaurants || d.items || d.docs || []
      setRestaurants(list.map((r) => ({ id: r.id || r._id, name: r.restaurantName || r.name })).filter((r) => r.id))
    }).catch(() => {})
  }, [])

  const remove = async (reel) => {
    if (!window.confirm("Delete this reel?")) return
    try {
      await adminAPI.deleteReel(reel.id)
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
              <Camera className="w-5 h-5 text-teal-700" />
              <h1 className="text-2xl font-bold text-slate-900">Reels</h1>
            </div>
            <p className="text-sm text-slate-600 mt-1">Short restaurant videos in the customer app. Views, likes and taps through to the restaurant are counted.</p>
          </div>
          <button type="button" onClick={() => setEditing({})} className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white">
            <Plus className="w-4 h-4" /> New reel
          </button>
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
          {loading ? (
            <div className="py-12 text-center"><Loader2 className="w-6 h-6 animate-spin text-slate-400 mx-auto" /></div>
          ) : !reels.length ? (
            <p className="py-12 text-center text-sm text-slate-500">No reels yet.</p>
          ) : (
            <div className="grid gap-4 grid-cols-2 md:grid-cols-4 xl:grid-cols-5">
              {reels.map((reel) => (
                <div key={reel.id} className="rounded-lg border border-slate-200 overflow-hidden">
                  <video src={reel.videoUrl} poster={reel.thumbnail || undefined} className="aspect-[9/16] w-full bg-black object-cover" controls preload="metadata" />
                  <div className="p-2.5 space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-xs font-semibold text-slate-800 truncate">{reel.restaurantName}</p>
                      <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${BADGE[reel.state] || ""}`}>{reel.state}</span>
                    </div>
                    {reel.description && <p className="text-xs text-slate-600 line-clamp-2">{reel.description}</p>}
                    <p className="flex gap-3 text-[11px] text-slate-500">
                      <span><Eye className="inline w-3 h-3" /> {reel.views}</span>
                      <span><Heart className="inline w-3 h-3" /> {reel.likes}</span>
                      <span><Store className="inline w-3 h-3" /> {reel.restaurantVisits}</span>
                    </p>
                    <div className="flex gap-1.5">
                      <button type="button" onClick={() => setEditing(reel)} className="rounded border border-slate-300 px-2 py-0.5 text-xs">Edit</button>
                      <button type="button" onClick={() => remove(reel)} className="rounded border border-slate-300 px-2 py-0.5 text-xs text-slate-500">Delete</button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      {editing && (
        <ReelForm reel={editing.id ? editing : null} restaurants={restaurants} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load() }} />
      )}
    </div>
  )
}
