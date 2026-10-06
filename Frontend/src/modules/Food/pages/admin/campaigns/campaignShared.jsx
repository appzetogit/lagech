import { useState } from "react"
import { toast } from "sonner"
import { uploadAPI } from "@food/api"

/** ISO instant -> value for <input type="datetime-local"> in the admin's own time. */
export const toLocalInput = (iso) => {
  if (!iso) return ""
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ""
  const pad = (n) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** datetime-local value -> ISO instant (the browser reads it as local time). */
export const fromLocalInput = (value) => (value ? new Date(value).toISOString() : "")

export const formatWhen = (iso) =>
  iso ? new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }) : ""

export const STATE_BADGE = {
  running: "bg-emerald-100 text-emerald-800",
  scheduled: "bg-blue-100 text-blue-800",
  expired: "bg-slate-100 text-slate-500",
  off: "bg-slate-200 text-slate-700",
}

export const STATE_LABEL = { running: "Running", scheduled: "Scheduled", expired: "Ended", off: "Switched off" }

export const STATE_TABS = [
  ["", "All"],
  ["running", "Running"],
  ["scheduled", "Scheduled"],
  ["expired", "Ended"],
  ["off", "Switched off"],
]

/** Image picker that uploads straight away and reports the URL. */
export function ImageUpload({ value, onChange, folder }) {
  const [busy, setBusy] = useState(false)
  const pick = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      setBusy(true)
      const res = await uploadAPI.uploadMedia(file, { folder })
      onChange(res?.data?.data?.url || res?.data?.url || "")
    } catch (err) {
      toast.error(err?.response?.data?.message || "Upload failed")
    } finally {
      setBusy(false)
      e.target.value = ""
    }
  }
  return (
    <div className="flex flex-wrap items-center gap-3">
      {value && <img src={value} alt="" className="h-20 w-32 rounded object-cover border" />}
      <label className="cursor-pointer rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium">
        {busy ? "Uploading…" : value ? "Replace image" : "Upload image"}
        <input type="file" accept="image/*" className="sr-only" onChange={pick} disabled={busy} />
      </label>
      {value && (
        <button type="button" onClick={() => onChange("")} className="text-xs text-slate-500 underline">Remove</button>
      )}
    </div>
  )
}
