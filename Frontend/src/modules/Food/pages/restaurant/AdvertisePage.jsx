import { useEffect, useState } from "react"
import { ArrowLeft, Loader2, Megaphone } from "lucide-react"
import { useNavigate } from "react-router-dom"
import { toast } from "sonner"
import { restaurantAPI, uploadAPI } from "@food/api"

const STATE_TEXT = {
  pending: ["Waiting for approval", "bg-amber-100 text-amber-800"],
  running: ["Running", "bg-emerald-100 text-emerald-800"],
  scheduled: ["Approved, starts soon", "bg-blue-100 text-blue-800"],
  paused: ["Paused by Lagech", "bg-slate-200 text-slate-700"],
  expired: ["Ended", "bg-slate-100 text-slate-500"],
  denied: ["Not approved", "bg-rose-100 text-rose-700"],
}
const iso = (d) => new Date(d).toISOString().slice(0, 10)
const day = (d) => new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "short" })

/** A restaurant asking Lagech to promote it, and the state of its requests. */
export default function AdvertisePage() {
  const navigate = useNavigate()
  const [ads, setAds] = useState([])
  const [loading, setLoading] = useState(true)
  const [form, setForm] = useState({ type: "restaurant", title: "", description: "", coverImage: "", videoUrl: "", startDate: iso(new Date()), endDate: iso(Date.now() + 7 * 864e5) })
  const [busy, setBusy] = useState("")
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }))

  const load = async () => {
    try {
      setLoading(true)
      const res = await restaurantAPI.getMyAdvertisements()
      setAds(res?.data?.data?.ads || [])
    } catch {
      setAds([])
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    load()
  }, [])

  const upload = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      setBusy("upload")
      const res = form.type === "video"
        ? await uploadAPI.uploadVideo(file, { folder: "food/advertisements", contextModule: "restaurant" })
        : await uploadAPI.uploadMedia(file, { folder: "food/advertisements" })
      set(form.type === "video" ? "videoUrl" : "coverImage", res?.data?.data?.url || "")
    } catch (err) {
      toast.error(err?.response?.data?.message || err?.message || "Upload failed")
    } finally {
      setBusy("")
      e.target.value = ""
    }
  }

  const submit = async (e) => {
    e.preventDefault()
    try {
      setBusy("send")
      await restaurantAPI.requestAdvertisement(form)
      toast.success("Request sent. Lagech will review it.")
      setForm((f) => ({ ...f, title: "", description: "", coverImage: "", videoUrl: "" }))
      load()
    } catch (err) {
      toast.error(err?.response?.data?.message || "Failed to send the request")
    } finally {
      setBusy("")
    }
  }

  const withdraw = async (ad) => {
    if (!window.confirm("Withdraw this request?")) return
    try {
      await restaurantAPI.withdrawAdvertisement(ad.id)
      load()
    } catch (err) {
      toast.error(err?.response?.data?.message || "Failed to withdraw")
    }
  }

  const input = "w-full rounded-xl border border-gray-300 px-3 py-2.5 text-sm"
  const media = form.type === "video" ? form.videoUrl : form.coverImage

  return (
    <div className="min-h-screen bg-gray-50 pb-24">
      <div className="sticky top-0 z-10 bg-white border-b px-4 py-3 flex items-center gap-3">
        <button type="button" onClick={() => navigate(-1)} aria-label="Back"><ArrowLeft className="w-5 h-5" /></button>
        <Megaphone className="w-5 h-5 text-gray-700" />
        <h1 className="text-lg font-bold text-gray-900">Advertise</h1>
      </div>
      <div className="max-w-2xl mx-auto p-4 space-y-6">
        <form onSubmit={submit} className="bg-white rounded-2xl border p-4 space-y-3">
          <p className="text-sm text-gray-600">Ask Lagech to feature your restaurant in the customer app. Your request is reviewed before it runs.</p>
          <div className="flex gap-2">
            {[["restaurant", "Photo card"], ["video", "Video"]].map(([key, label]) => (
              <button key={key} type="button" onClick={() => set("type", key)} className={`flex-1 rounded-xl border px-3 py-2 text-sm font-medium ${form.type === key ? "border-gray-900 bg-gray-900 text-white" : "border-gray-300"}`}>{label}</button>
            ))}
          </div>
          <input className={input} placeholder="Title, e.g. Try our new biryani" maxLength={120} value={form.title} onChange={(e) => set("title", e.target.value)} required />
          <textarea className={input} rows={2} placeholder="A line about the offer" maxLength={500} value={form.description} onChange={(e) => set("description", e.target.value)} />
          <div className="flex items-center gap-3">
            {media && (form.type === "video" ? <video src={media} className="h-16 w-28 rounded-lg bg-black object-cover" muted /> : <img src={media} alt="" className="h-16 w-28 rounded-lg object-cover" />)}
            <label className="cursor-pointer rounded-xl border border-gray-300 px-3 py-2 text-sm">
              {busy === "upload" ? "Uploading…" : media ? "Replace" : form.type === "video" ? "Upload video (up to 50 MB)" : "Upload cover photo"}
              <input type="file" className="sr-only" accept={form.type === "video" ? "video/mp4,video/quicktime,video/webm" : "image/*"} onChange={upload} disabled={busy === "upload"} />
            </label>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <label className="text-xs text-gray-600">From<input type="date" className={input} value={form.startDate} onChange={(e) => set("startDate", e.target.value)} required /></label>
            <label className="text-xs text-gray-600">To<input type="date" className={input} value={form.endDate} onChange={(e) => set("endDate", e.target.value)} required /></label>
          </div>
          <button type="submit" disabled={Boolean(busy) || !media} className="w-full rounded-xl bg-gray-900 py-3 text-sm font-semibold text-white disabled:opacity-50">
            {busy === "send" ? <Loader2 className="w-4 h-4 animate-spin mx-auto" /> : "Send for approval"}
          </button>
        </form>

        <div className="space-y-3">
          <h2 className="text-sm font-bold text-gray-700 uppercase tracking-wide">Your requests</h2>
          {loading ? <Loader2 className="w-5 h-5 animate-spin text-gray-400" /> : !ads.length ? (
            <p className="text-sm text-gray-500">No requests yet.</p>
          ) : ads.map((ad) => {
            const [label, cls] = STATE_TEXT[ad.state] || [ad.state, ""]
            return (
              <div key={ad.id} className="bg-white rounded-2xl border p-3 flex gap-3">
                {ad.type === "video" ? <video src={ad.videoUrl} className="h-16 w-24 rounded-lg bg-black object-cover" muted /> : <img src={ad.coverImage} alt="" className="h-16 w-24 rounded-lg object-cover" />}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-gray-900 truncate">{ad.title}</p>
                  <p className="text-xs text-gray-500">{day(ad.startDate)} – {day(ad.endDate)}</p>
                  <span className={`mt-1 inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold ${cls}`}>{label}</span>
                  {ad.note && <p className="text-xs text-rose-600 mt-1">{ad.note}</p>}
                </div>
                {ad.state === "pending" && <button type="button" onClick={() => withdraw(ad)} className="self-start text-xs text-gray-500 underline">Withdraw</button>}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
