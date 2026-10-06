import { useEffect, useState } from "react"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"
import { adminSystemExtrasAPI } from "@food/api/adminSystemExtras"
import { uploadAPI } from "@food/api"

/**
 * Building blocks shared by the system settings pages: the page frame, cards,
 * labelled inputs, a switch, an image picker, and a hook that loads and saves
 * one settings area.
 */

export const inputClass = "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"

export const errorMessage = (err, fallback) => err?.response?.data?.message || err?.message || fallback

export function PageFrame({ icon: Icon, title, description, actions, children }) {
  return (
    <div className="p-4 lg:p-6 bg-slate-50 min-h-screen">
      <div className="max-w-6xl mx-auto space-y-6">
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-3">
              {Icon && <Icon className="w-5 h-5 text-teal-700" />}
              <h1 className="text-2xl font-bold text-slate-900">{title}</h1>
            </div>
            {description && <p className="text-sm text-slate-600 mt-1 max-w-3xl">{description}</p>}
          </div>
          {actions}
        </div>
        {children}
      </div>
    </div>
  )
}

export function Card({ title, description, children, className = "" }) {
  return (
    <section className={`bg-white rounded-xl shadow-sm border border-slate-200 p-6 ${className}`}>
      {title && <h2 className="text-base font-semibold text-slate-900">{title}</h2>}
      {description && <p className="text-xs text-slate-500 mt-1">{description}</p>}
      <div className={title || description ? "mt-4" : ""}>{children}</div>
    </section>
  )
}

export function Field({ label, hint, children, className = "" }) {
  return (
    <label className={`block space-y-1 ${className}`}>
      <span className="block text-xs font-semibold text-slate-600">{label}</span>
      {children}
      {hint && <span className="block text-[11px] text-slate-500">{hint}</span>}
    </label>
  )
}

export function Switch({ checked, onChange, disabled = false, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${checked ? "bg-blue-600" : "bg-slate-300"} ${disabled ? "opacity-50 cursor-not-allowed" : ""}`}
    >
      <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${checked ? "translate-x-5" : "translate-x-0.5"}`} />
    </button>
  )
}

export function SaveButton({ saving, onClick, children = "Save", disabled = false }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={saving || disabled}
      className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60"
    >
      {saving && <Loader2 className="w-4 h-4 animate-spin" />} {children}
    </button>
  )
}

export function Loading() {
  return (
    <div className="py-16 text-center">
      <Loader2 className="w-7 h-7 animate-spin text-teal-600 mx-auto" />
    </div>
  )
}

/** An image URL field with upload, preview and clear. */
export function ImageInput({ value, onChange, folder = "food/site", label = "Image" }) {
  const [busy, setBusy] = useState(false)
  const pick = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      setBusy(true)
      const res = await uploadAPI.uploadMedia(file, { folder })
      onChange(res?.data?.data?.url || "")
    } catch (err) {
      toast.error(errorMessage(err, "Upload failed"))
    } finally {
      setBusy(false)
      e.target.value = ""
    }
  }
  return (
    <div className="flex flex-wrap items-center gap-3">
      {value ? (
        <img src={value} alt="" className="h-16 w-24 rounded-lg border border-slate-200 object-cover bg-slate-50" />
      ) : (
        <div className="h-16 w-24 rounded-lg border border-dashed border-slate-300 bg-slate-50 text-[11px] text-slate-400 flex items-center justify-center">No image</div>
      )}
      <label className="cursor-pointer rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50">
        {busy ? "Uploading…" : value ? `Replace ${label.toLowerCase()}` : `Upload ${label.toLowerCase()}`}
        <input type="file" className="sr-only" accept="image/*" onChange={pick} disabled={busy} />
      </label>
      {value && (
        <button type="button" onClick={() => onChange("")} className="text-xs text-slate-500 hover:text-red-600">
          Remove
        </button>
      )}
    </div>
  )
}

/**
 * Load one settings area and save it back. Returns the current value, a
 * setter that takes an updater, the area's catalog (fixed lists the backend
 * renders from), and save().
 */
export function useSettingsArea(area) {
  const [value, setValue] = useState(null)
  const [catalog, setCatalog] = useState({})
  const [updatedAt, setUpdatedAt] = useState(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let alive = true
    adminSystemExtrasAPI
      .getSettings(area)
      .then((res) => {
        if (!alive) return
        const d = res?.data?.data || {}
        setValue(d.value || {})
        setCatalog(d.catalog || {})
        setUpdatedAt(d.updatedAt || null)
      })
      .catch((err) => alive && toast.error(errorMessage(err, "Failed to load settings")))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [area])

  const save = async (next = value) => {
    try {
      setSaving(true)
      const res = await adminSystemExtrasAPI.saveSettings(area, next)
      const d = res?.data?.data || {}
      setValue(d.value || next)
      setUpdatedAt(d.updatedAt || null)
      toast.success("Saved")
      return true
    } catch (err) {
      toast.error(errorMessage(err, "Failed to save"))
      return false
    } finally {
      setSaving(false)
    }
  }

  return { value, setValue, catalog, updatedAt, loading, saving, save }
}

/** Set a value deep inside an object by path, returning a new object. */
export function setIn(obj, path, next) {
  const [head, ...rest] = path
  const base = Array.isArray(obj) ? [...obj] : { ...(obj || {}) }
  base[head] = rest.length ? setIn(base[head], rest, next) : next
  return base
}

export const formatDateTime = (value) =>
  value ? new Date(value).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : ""
