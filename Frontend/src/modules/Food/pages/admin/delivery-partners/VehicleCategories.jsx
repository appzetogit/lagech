import { useEffect, useState } from "react"
import { Car, Loader2, Pencil, Plus, Search, Trash2, X } from "lucide-react"
import { toast } from "sonner"
import { adminRiderExtrasAPI } from "@food/api/adminRiderExtras"

const rupees = (value) =>
  `₹${Number(value || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const km = (value) => `${Number(value || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })} km`

const input =
  "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"

function CategoryForm({ category, onClose, onSaved }) {
  const [form, setForm] = useState({
    type: category?.type || "",
    startingCoverageKm: category?.startingCoverageKm ?? 0,
    maxCoverageKm: category?.maxCoverageKm ?? "",
    extraCharges: category?.extraCharges ?? 0,
    isActive: category?.isActive ?? true,
  })
  const [saving, setSaving] = useState(false)
  const set = (key, value) => setForm((prev) => ({ ...prev, [key]: value }))

  const save = async (event) => {
    event.preventDefault()
    if (Number(form.maxCoverageKm) < Number(form.startingCoverageKm)) {
      toast.error("Maximum coverage must be at least the starting coverage")
      return
    }
    try {
      setSaving(true)
      const body = {
        type: form.type.trim(),
        startingCoverageKm: Number(form.startingCoverageKm),
        maxCoverageKm: Number(form.maxCoverageKm),
        extraCharges: Number(form.extraCharges),
        isActive: form.isActive,
      }
      if (category) await adminRiderExtrasAPI.updateVehicleCategory(category.id, body)
      else await adminRiderExtrasAPI.createVehicleCategory(body)
      toast.success(category ? "Vehicle category updated" : "Vehicle category added")
      onSaved()
    } catch (err) {
      toast.error(err?.response?.data?.message || "Failed to save the vehicle category")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
      <form onSubmit={save} className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl space-y-4">
        <div className="flex items-start justify-between">
          <h3 className="text-lg font-bold text-slate-900">{category ? "Edit vehicle category" : "Add vehicle category"}</h3>
          <button type="button" onClick={onClose} aria-label="Close"><X className="w-5 h-5 text-slate-500" /></button>
        </div>
        <label className="block space-y-1">
          <span className="text-sm font-semibold text-slate-700">Vehicle type <span className="text-red-500">*</span></span>
          <input className={input} value={form.type} maxLength={64} onChange={(e) => set("type", e.target.value)} required />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block space-y-1">
            <span className="text-sm font-semibold text-slate-700">Starting coverage (km)</span>
            <input type="number" min="0" step="0.01" className={input} value={form.startingCoverageKm} onChange={(e) => set("startingCoverageKm", e.target.value)} required />
          </label>
          <label className="block space-y-1">
            <span className="text-sm font-semibold text-slate-700">Maximum coverage (km) <span className="text-red-500">*</span></span>
            <input type="number" min="0.01" step="0.01" className={input} value={form.maxCoverageKm} onChange={(e) => set("maxCoverageKm", e.target.value)} required />
          </label>
        </div>
        <label className="block space-y-1">
          <span className="text-sm font-semibold text-slate-700">Extra charges (₹)</span>
          <input type="number" min="0" step="0.01" className={input} value={form.extraCharges} onChange={(e) => set("extraCharges", e.target.value)} required />
          <span className="block text-xs text-slate-500">Charged on deliveries beyond the starting coverage, up to the maximum.</span>
        </label>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={form.isActive} onChange={(e) => set("isActive", e.target.checked)} /> Switched on
        </label>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">Cancel</button>
          <button type="submit" disabled={saving} className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60">
            {saving && <Loader2 className="w-4 h-4 animate-spin" />} Save
          </button>
        </div>
      </form>
    </div>
  )
}

/** The kinds of vehicle delivery men may use, and how far each may deliver. */
export default function VehicleCategories() {
  const [categories, setCategories] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState("")
  const [editing, setEditing] = useState(null)
  const [busyId, setBusyId] = useState("")

  const load = async () => {
    try {
      setLoading(true)
      const res = await adminRiderExtrasAPI.getVehicleCategories()
      setCategories(res?.data?.data?.categories || [])
    } catch (err) {
      toast.error(err?.response?.data?.message || "Failed to load vehicle categories")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [])

  const toggle = async (category) => {
    try {
      setBusyId(category.id)
      await adminRiderExtrasAPI.updateVehicleCategory(category.id, { isActive: !category.isActive })
      setCategories((prev) => prev.map((c) => (c.id === category.id ? { ...c, isActive: !c.isActive } : c)))
    } catch (err) {
      toast.error(err?.response?.data?.message || "Failed to update")
    } finally {
      setBusyId("")
    }
  }

  const remove = async (category) => {
    const riders = category.riders ? ` ${category.riders} delivery men use it; they keep it on their profile.` : ""
    if (!window.confirm(`Delete "${category.type}"?${riders}`)) return
    try {
      setBusyId(category.id)
      await adminRiderExtrasAPI.deleteVehicleCategory(category.id)
      toast.success("Vehicle category deleted")
      setCategories((prev) => prev.filter((c) => c.id !== category.id))
    } catch (err) {
      toast.error(err?.response?.data?.message || "Failed to delete")
    } finally {
      setBusyId("")
    }
  }

  const q = search.trim().toLowerCase()
  const visible = q ? categories.filter((c) => c.type.toLowerCase().includes(q)) : categories

  return (
    <div className="p-4 lg:p-6 bg-slate-50 min-h-screen">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-3">
              <Car className="w-5 h-5 text-teal-700" />
              <h1 className="text-2xl font-bold text-slate-900">Vehicles Category</h1>
            </div>
            <p className="text-sm text-slate-600 mt-1 max-w-3xl">
              The vehicle types a delivery man can be added with, and how far each may deliver. Only switched-on types
              can be chosen when adding a delivery man.
            </p>
          </div>
          <button type="button" onClick={() => setEditing({})} className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700">
            <Plus className="w-4 h-4" /> Add vehicle category
          </button>
        </div>

        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
          <div className="flex flex-wrap items-center gap-3 mb-4">
            <h2 className="text-xl font-bold text-slate-900">Vehicle categories</h2>
            <span className="px-3 py-1 rounded-full text-sm font-semibold bg-slate-100 text-slate-700">{categories.length}</span>
            <div className="relative ml-auto w-full sm:w-64">
              <input
                type="text"
                placeholder="Search by type"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-9 pr-3 py-2 w-full text-sm rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            </div>
          </div>

          {loading ? (
            <div className="py-16 text-center"><Loader2 className="w-7 h-7 animate-spin text-teal-600 mx-auto" /></div>
          ) : !visible.length ? (
            <p className="py-16 text-center text-sm text-slate-500">
              {categories.length ? "No vehicle category matches this search." : "No vehicle categories yet. Add one to start adding delivery men."}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-slate-50 border-b border-slate-200">
                  <tr>
                    {["SL", "Type", "Starting coverage", "Maximum coverage", "Extra charges", "Delivery men", "Status", ""].map((h) => (
                      <th key={h} className="px-4 py-3 text-left text-[10px] font-bold text-slate-700 uppercase tracking-wider">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {visible.map((c, i) => (
                    <tr key={c.id} className="hover:bg-slate-50">
                      <td className="px-4 py-3 text-sm text-slate-500">{i + 1}</td>
                      <td className="px-4 py-3 text-sm font-semibold text-slate-800">{c.type}</td>
                      <td className="px-4 py-3 text-sm text-slate-700">{km(c.startingCoverageKm)}</td>
                      <td className="px-4 py-3 text-sm text-slate-700">{km(c.maxCoverageKm)}</td>
                      <td className="px-4 py-3 text-sm text-slate-700">{rupees(c.extraCharges)}</td>
                      <td className="px-4 py-3 text-sm text-slate-700">{c.riders}</td>
                      <td className="px-4 py-3">
                        <button
                          type="button"
                          role="switch"
                          aria-checked={c.isActive}
                          aria-label={`${c.isActive ? "Switch off" : "Switch on"} ${c.type}`}
                          disabled={busyId === c.id}
                          onClick={() => toggle(c)}
                          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors disabled:opacity-60 ${c.isActive ? "bg-blue-600" : "bg-slate-300"}`}
                        >
                          <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${c.isActive ? "translate-x-4" : "translate-x-0.5"}`} />
                        </button>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex justify-end gap-2">
                          <button type="button" onClick={() => setEditing(c)} className="rounded-lg border border-slate-300 p-1.5 text-slate-600 hover:bg-slate-100" aria-label={`Edit ${c.type}`}>
                            <Pencil className="w-4 h-4" />
                          </button>
                          <button type="button" disabled={busyId === c.id} onClick={() => remove(c)} className="rounded-lg border border-red-200 p-1.5 text-red-600 hover:bg-red-50 disabled:opacity-60" aria-label={`Delete ${c.type}`}>
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
      {editing && (
        <CategoryForm
          category={editing.id ? editing : null}
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
