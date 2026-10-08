import { useEffect, useState } from "react"
import { FolderTree, Loader2, Pencil, Plus, Trash2, X } from "@food/components/admin/theme/icons"
import { toast } from "sonner"
import { adminCatalogExtrasAPI, errorMessage } from "@food/api/adminCatalogExtras"
import ExportMenu from "@food/components/admin/ExportMenu"

const EMPTY = { name: "", sortOrder: 0, isActive: true }

const EXPORT_COLUMNS = [
  { label: "Sl", value: (_c, index) => index + 1 },
  { label: "Id", value: (c) => c.id },
  { label: "Name", value: (c) => c.name },
  { label: "Add-ons", value: (c) => Number(c.addonCount || 0) },
  { label: "Order", value: (c) => Number(c.sortOrder || 0) },
  { label: "Status", value: (c) => (c.isActive ? "Active" : "Inactive") },
]

/** Addons -> Addon Category: admin groupings for the add-on list. */
export default function AddonCategories() {
  const [categories, setCategories] = useState([])
  const [loading, setLoading] = useState(true)
  const [form, setForm] = useState(EMPTY)
  const [editingId, setEditingId] = useState("")
  const [busy, setBusy] = useState("")

  const load = async () => {
    try {
      setLoading(true)
      const res = await adminCatalogExtrasAPI.getAddonCategories()
      setCategories(res?.data?.data?.categories || [])
    } catch (err) {
      toast.error(errorMessage(err, "Failed to load addon categories"))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [])

  const reset = () => {
    setForm(EMPTY)
    setEditingId("")
  }

  const save = async (e) => {
    e.preventDefault()
    const body = { name: form.name.trim(), sortOrder: Number(form.sortOrder) || 0, isActive: form.isActive }
    if (!body.name) return toast.error("Name is required")
    try {
      setBusy("save")
      if (editingId) await adminCatalogExtrasAPI.updateAddonCategory(editingId, body)
      else await adminCatalogExtrasAPI.createAddonCategory(body)
      toast.success(editingId ? "Addon category saved" : "Addon category added")
      reset()
      load()
    } catch (err) {
      toast.error(errorMessage(err, "Failed to save"))
    } finally {
      setBusy("")
    }
  }

  const toggle = async (c) => {
    try {
      setBusy(c.id)
      await adminCatalogExtrasAPI.updateAddonCategory(c.id, { isActive: !c.isActive })
      setCategories((list) => list.map((x) => (x.id === c.id ? { ...x, isActive: !c.isActive } : x)))
    } catch (err) {
      toast.error(errorMessage(err, "Failed to update"))
    } finally {
      setBusy("")
    }
  }

  const remove = async (c) => {
    const note = c.addonCount ? ` Its ${c.addonCount} add-on(s) will be left without a category.` : ""
    if (!window.confirm(`Delete "${c.name}"?${note}`)) return
    try {
      setBusy(c.id)
      await adminCatalogExtrasAPI.deleteAddonCategory(c.id)
      if (editingId === c.id) reset()
      load()
    } catch (err) {
      toast.error(errorMessage(err, "Failed to delete"))
    } finally {
      setBusy("")
    }
  }

  const input = "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm bg-white"

  return (
    <div className="p-4 lg:p-6 bg-slate-50 min-h-screen">
      <div className="max-w-5xl mx-auto space-y-6">
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-3">
              <FolderTree className="w-5 h-5 text-blue-600" />
              <h1 className="text-2xl font-bold text-slate-900">Addon Category</h1>
            </div>
            <p className="text-sm text-slate-600 mt-1">Group add-ons (for example drinks or extra toppings) so the add-on list can be filtered by group.</p>
          </div>
          {/* The endpoint is unpaged, so `categories` is the whole list. */}
          <ExportMenu filename="addon_categories" sheetName="Addon Categories" columns={EXPORT_COLUMNS} getRows={() => categories} disabled={loading} />
        </div>

        <form onSubmit={save} className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 grid gap-4 sm:grid-cols-[1fr_120px_auto_auto] items-end">
          <label className="block space-y-1">
            <span className="text-xs font-semibold text-slate-600">{editingId ? "Edit name" : "Name"}</span>
            <input className={input} maxLength={100} value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
          </label>
          <label className="block space-y-1">
            <span className="text-xs font-semibold text-slate-600">Order</span>
            <input type="number" min={0} className={input} value={form.sortOrder} onChange={(e) => setForm((f) => ({ ...f, sortOrder: e.target.value }))} />
          </label>
          <label className="flex items-center gap-2 text-sm pb-2">
            <input type="checkbox" checked={form.isActive} onChange={(e) => setForm((f) => ({ ...f, isActive: e.target.checked }))} /> Active
          </label>
          <div className="flex gap-2">
            {editingId && (
              <button type="button" onClick={reset} className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-3 py-2 text-sm"><X className="w-4 h-4" /> Cancel</button>
            )}
            <button type="submit" disabled={busy === "save"} className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60">
              {busy === "save" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} {editingId ? "Save" : "Add"}
            </button>
          </div>
        </form>

        <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-x-auto">
          {loading ? (
            <div className="py-16 text-center"><Loader2 className="w-6 h-6 animate-spin text-slate-400 mx-auto" /></div>
          ) : !categories.length ? (
            <p className="py-16 text-center text-sm text-slate-500">No addon categories yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-left text-slate-600">
                  <th className="px-4 py-3 font-semibold">Name</th>
                  <th className="px-4 py-3 font-semibold">Add-ons</th>
                  <th className="px-4 py-3 font-semibold">Order</th>
                  <th className="px-4 py-3 font-semibold">Active</th>
                  <th className="px-4 py-3 font-semibold text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {categories.map((c) => (
                  <tr key={c.id} className="border-b border-slate-100">
                    <td className="px-4 py-3 font-medium text-slate-800">{c.name}</td>
                    <td className="px-4 py-3 text-slate-600">{c.addonCount}</td>
                    <td className="px-4 py-3 text-slate-600">{c.sortOrder}</td>
                    <td className="px-4 py-3">
                      <button type="button" disabled={busy === c.id} onClick={() => toggle(c)} className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${c.isActive ? "bg-emerald-100 text-emerald-800" : "bg-slate-200 text-slate-600"}`}>
                        {c.isActive ? "On" : "Off"}
                      </button>
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      <button type="button" onClick={() => { setEditingId(c.id); setForm({ name: c.name, sortOrder: c.sortOrder, isActive: c.isActive }) }} className="p-1.5 rounded text-blue-600 hover:bg-blue-50" title="Edit"><Pencil className="w-4 h-4" /></button>
                      <button type="button" disabled={busy === c.id} onClick={() => remove(c)} className="p-1.5 rounded text-rose-600 hover:bg-rose-50" title="Delete"><Trash2 className="w-4 h-4" /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  )
}
