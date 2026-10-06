import { useEffect, useState } from "react"
import { Landmark, Loader2, Plus, Search, Trash2, X } from "@food/components/admin/theme/icons"
import { toast } from "sonner"
import { adminSystemExtrasAPI } from "@food/api/adminSystemExtras"
import { PageFrame, Card, Field, Switch, Loading, inputClass, errorMessage } from "../system/SettingsUi"

const FIELD_TYPES = [
  ["text", "Text"],
  ["number", "Number"],
  ["email", "Email"],
]

const emptyField = () => ({ label: "", type: "text", required: true, placeholder: "" })

function MethodForm({ method, onClose, onSaved }) {
  const [form, setForm] = useState({
    name: method?.name || "",
    isActive: method?.isActive ?? true,
    isDefault: method?.isDefault ?? false,
    fields: method?.fields?.length ? method.fields.map((f) => ({ ...f })) : [emptyField()],
  })
  const [saving, setSaving] = useState(false)
  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }))
  const setField = (index, key, value) =>
    setForm((f) => ({ ...f, fields: f.fields.map((field, i) => (i === index ? { ...field, [key]: value } : field)) }))

  const save = async (e) => {
    e.preventDefault()
    try {
      setSaving(true)
      if (method?.id) await adminSystemExtrasAPI.updateWithdrawalMethod(method.id, form)
      else await adminSystemExtrasAPI.createWithdrawalMethod(form)
      toast.success(method?.id ? "Method saved" : "Method added")
      onSaved()
    } catch (err) {
      toast.error(errorMessage(err, "Failed to save the method"))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
      <form onSubmit={save} className="w-full max-w-3xl max-h-[90vh] overflow-y-auto rounded-xl bg-white p-6 shadow-xl space-y-5">
        <div className="flex items-start justify-between">
          <h3 className="text-lg font-bold text-slate-900">{method?.id ? "Edit withdraw method" : "New withdraw method"}</h3>
          <button type="button" onClick={onClose} aria-label="Close"><X className="w-5 h-5 text-slate-500" /></button>
        </div>
        <Field label="Method name" hint="What restaurants and riders see, for example Bank transfer or UPI.">
          <input className={inputClass} value={form.name} maxLength={80} onChange={(e) => set("name", e.target.value)} required />
        </Field>

        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold text-slate-800">Fields the payee fills in</p>
            <button
              type="button"
              onClick={() => set("fields", [...form.fields, emptyField()])}
              disabled={form.fields.length >= 20}
              className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium hover:bg-slate-50 disabled:opacity-50"
            >
              <Plus className="w-3.5 h-3.5" /> Add field
            </button>
          </div>
          {form.fields.map((field, index) => (
            <div key={index} className="grid gap-3 rounded-lg border border-slate-200 p-3 md:grid-cols-[1.4fr_0.8fr_1.4fr_auto_auto] md:items-end">
              <Field label="Label">
                <input className={inputClass} value={field.label} maxLength={80} onChange={(e) => setField(index, "label", e.target.value)} required />
              </Field>
              <Field label="Type">
                <select className={inputClass} value={field.type} onChange={(e) => setField(index, "type", e.target.value)}>
                  {FIELD_TYPES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </Field>
              <Field label="Placeholder">
                <input className={inputClass} value={field.placeholder || ""} maxLength={120} onChange={(e) => setField(index, "placeholder", e.target.value)} />
              </Field>
              <label className="flex items-center gap-2 pb-2 text-xs font-medium text-slate-700">
                <input type="checkbox" checked={Boolean(field.required)} onChange={(e) => setField(index, "required", e.target.checked)} /> Required
              </label>
              <button
                type="button"
                onClick={() => set("fields", form.fields.filter((_, i) => i !== index))}
                disabled={form.fields.length <= 1}
                className="mb-1 rounded-lg border border-slate-300 p-2 text-slate-500 hover:text-red-600 disabled:opacity-40"
                aria-label="Remove field"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          ))}
          {method?.id && <p className="text-[11px] text-slate-500">Renaming a field keeps what payees already entered for it.</p>}
        </div>

        <div className="flex flex-wrap items-center gap-6 text-sm">
          <label className="flex items-center gap-2"><Switch checked={form.isActive} onChange={(v) => set("isActive", v)} label="Active" /> Active</label>
          <label className="flex items-center gap-2"><Switch checked={form.isDefault} onChange={(v) => set("isDefault", v)} disabled={!form.isActive} label="Default" /> Default method</label>
        </div>

        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-lg border border-slate-300 px-4 py-2 text-sm">Cancel</button>
          <button type="submit" disabled={saving} className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60">
            {saving && <Loader2 className="w-4 h-4 animate-spin" />} Save
          </button>
        </div>
      </form>
    </div>
  )
}

/** Payout method types restaurants and riders choose from when saving payout details. */
export default function WithdrawMethod() {
  const [methods, setMethods] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState("")
  const [editing, setEditing] = useState(null)

  const load = async (term = search) => {
    try {
      setLoading(true)
      const res = await adminSystemExtrasAPI.getWithdrawalMethods({ search: term || undefined })
      setMethods(res?.data?.data?.methods || [])
    } catch (err) {
      toast.error(errorMessage(err, "Failed to load withdraw methods"))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load("")
  }, [])

  const update = async (method, body, done) => {
    try {
      await adminSystemExtrasAPI.updateWithdrawalMethod(method.id, body)
      toast.success(done)
      load()
    } catch (err) {
      toast.error(errorMessage(err, "Failed to update"))
    }
  }

  const remove = async (method) => {
    if (!window.confirm(`Delete "${method.name}"?`)) return
    try {
      await adminSystemExtrasAPI.deleteWithdrawalMethod(method.id)
      toast.success("Method deleted")
      load()
    } catch (err) {
      toast.error(errorMessage(err, "Failed to delete"))
    }
  }

  return (
    <PageFrame
      icon={Landmark}
      title="Withdraw Methods"
      description="How restaurants and riders can be paid, and what each needs them to fill in. Bank account and UPI details already on their profiles keep working alongside these."
      actions={
        <button type="button" onClick={() => setEditing({})} className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700">
          <Plus className="w-4 h-4" /> Add method
        </button>
      }
    >
      <Card>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            load()
          }}
          className="mb-4 flex max-w-sm items-center gap-2"
        >
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input className={`${inputClass} pl-9`} placeholder="Search by name" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <button type="submit" className="rounded-lg border border-slate-300 px-3 py-2 text-sm">Search</button>
        </form>
        {loading ? (
          <Loading />
        ) : !methods.length ? (
          <p className="py-12 text-center text-sm text-slate-500">No withdraw methods yet. Add one so restaurants and riders can choose how to be paid.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr>
                  {["Method", "Fields", "Used by", "Active", "Default", ""].map((h) => (
                    <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-slate-700">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {methods.map((method) => (
                  <tr key={method.id} className="hover:bg-slate-50 align-top">
                    <td className="px-4 py-3 text-sm font-semibold text-slate-900">{method.name}</td>
                    <td className="px-4 py-3 text-xs text-slate-600">
                      <div className="flex flex-wrap gap-1.5">
                        {method.fields.map((f) => (
                          <span key={f.key} className="rounded bg-slate-100 px-2 py-0.5">
                            {f.label} <span className="text-slate-400">({f.type}{f.required ? ", required" : ""})</span>
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-sm text-slate-600">{method.payeeCount ?? 0}</td>
                    <td className="px-4 py-3"><Switch checked={method.isActive} onChange={(v) => update(method, { isActive: v }, v ? "Switched on" : "Switched off")} label="Active" /></td>
                    <td className="px-4 py-3">
                      <Switch checked={method.isDefault} disabled={!method.isActive} onChange={(v) => update(method, { isDefault: v }, v ? "Now the default" : "No longer the default")} label="Default" />
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      <button type="button" onClick={() => setEditing(method)} className="rounded border border-slate-300 px-2.5 py-1 text-xs">Edit</button>
                      <button type="button" onClick={() => remove(method)} className="ml-1.5 rounded border border-slate-300 px-2.5 py-1 text-xs text-slate-500 hover:text-red-600">Delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {editing && (
        <MethodForm
          method={editing.id ? editing : null}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            load()
          }}
        />
      )}
    </PageFrame>
  )
}
