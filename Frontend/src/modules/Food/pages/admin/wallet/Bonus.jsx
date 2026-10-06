import { useEffect, useState } from "react"
import { Gift, Loader2, Pencil, Plus, Search, Trash2, X } from "@food/components/admin/theme/icons"
import { toast } from "sonner"
import {
  customerExtrasAPI,
  dataOf,
  errorMessage,
  formatDate,
  formatMoney,
  istDateInput,
} from "@food/api/adminCustomerExtras"
import { PageHeader, inputClass } from "./shared"

const STATE = {
  running: { label: "Running", cls: "bg-emerald-100 text-emerald-800" },
  scheduled: { label: "Scheduled", cls: "bg-blue-100 text-blue-800" },
  expired: { label: "Expired", cls: "bg-slate-100 text-slate-500" },
  off: { label: "Off", cls: "bg-slate-200 text-slate-700" },
}

const blank = () => ({
  title: "",
  description: "",
  bonusType: "percentage",
  bonusAmount: "",
  minimumAddAmount: "",
  maximumBonus: "",
  startDate: istDateInput(new Date()),
  endDate: "",
  isActive: true,
})

const describe = (b) =>
  b.bonusType === "percentage"
    ? `${b.bonusAmount}% of the amount added${b.maximumBonus > 0 ? `, up to ${formatMoney(b.maximumBonus)}` : ""}`
    : `${formatMoney(b.bonusAmount)} flat`

function BonusForm({ bonus, onClose, onSaved }) {
  const [form, setForm] = useState(() =>
    bonus?.id
      ? {
          title: bonus.title,
          description: bonus.description || "",
          bonusType: bonus.bonusType,
          bonusAmount: String(bonus.bonusAmount),
          minimumAddAmount: String(bonus.minimumAddAmount || ""),
          maximumBonus: bonus.maximumBonus ? String(bonus.maximumBonus) : "",
          startDate: istDateInput(bonus.startDate),
          endDate: istDateInput(bonus.endDate),
          isActive: bonus.isActive,
        }
      : blank(),
  )
  const [saving, setSaving] = useState(false)
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }))
  const percent = form.bonusType === "percentage"

  const save = async (e) => {
    e.preventDefault()
    try {
      setSaving(true)
      const body = { ...form, maximumBonus: percent ? form.maximumBonus || 0 : 0, minimumAddAmount: form.minimumAddAmount || 0 }
      if (bonus?.id) await customerExtrasAPI.updateWalletBonus(bonus.id, body)
      else await customerExtrasAPI.createWalletBonus(body)
      toast.success(bonus?.id ? "Bonus saved" : "Bonus added")
      onSaved()
    } catch (err) {
      toast.error(errorMessage(err, "Could not save the bonus"))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
      <form onSubmit={save} className="max-h-[90vh] w-full max-w-xl space-y-4 overflow-y-auto rounded-xl bg-white p-6 shadow-xl">
        <div className="flex items-start justify-between">
          <h3 className="text-lg font-bold text-slate-900">{bonus?.id ? "Edit bonus" : "New bonus"}</h3>
          <button type="button" onClick={onClose} aria-label="Close"><X className="h-5 w-5 text-slate-500" /></button>
        </div>
        <label className="block space-y-1">
          <span className="text-xs font-semibold text-slate-600">Title <span className="text-red-500">*</span></span>
          <input className={inputClass} maxLength={120} value={form.title} onChange={(e) => set("title", e.target.value)} required />
        </label>
        <label className="block space-y-1">
          <span className="text-xs font-semibold text-slate-600">Short description</span>
          <input className={inputClass} maxLength={500} value={form.description} onChange={(e) => set("description", e.target.value)} />
        </label>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block space-y-1">
            <span className="text-xs font-semibold text-slate-600">Bonus type</span>
            <select className={inputClass} value={form.bonusType} onChange={(e) => set("bonusType", e.target.value)}>
              <option value="percentage">Percentage of amount added</option>
              <option value="amount">Fixed amount (₹)</option>
            </select>
          </label>
          <label className="block space-y-1">
            <span className="text-xs font-semibold text-slate-600">Bonus {percent ? "(%)" : "(₹)"} <span className="text-red-500">*</span></span>
            <input type="number" min="0.01" step="0.01" max={percent ? 100 : undefined} className={inputClass} value={form.bonusAmount} onChange={(e) => set("bonusAmount", e.target.value)} required />
          </label>
          <label className="block space-y-1">
            <span className="text-xs font-semibold text-slate-600">Minimum add amount (₹)</span>
            <input type="number" min="0" step="0.01" className={inputClass} value={form.minimumAddAmount} onChange={(e) => set("minimumAddAmount", e.target.value)} placeholder="0 = any amount" />
          </label>
          {percent && (
            <label className="block space-y-1">
              <span className="text-xs font-semibold text-slate-600">Maximum bonus (₹)</span>
              <input type="number" min="0" step="0.01" className={inputClass} value={form.maximumBonus} onChange={(e) => set("maximumBonus", e.target.value)} placeholder="0 = no cap" />
            </label>
          )}
          <label className="block space-y-1">
            <span className="text-xs font-semibold text-slate-600">Start date <span className="text-red-500">*</span></span>
            <input type="date" className={inputClass} value={form.startDate} onChange={(e) => set("startDate", e.target.value)} required />
          </label>
          <label className="block space-y-1">
            <span className="text-xs font-semibold text-slate-600">End date <span className="text-red-500">*</span></span>
            <input type="date" className={inputClass} min={form.startDate || undefined} value={form.endDate} onChange={(e) => set("endDate", e.target.value)} required />
          </label>
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={form.isActive} onChange={(e) => set("isActive", e.target.checked)} /> Switched on
        </label>
        <p className="text-xs text-slate-500">
          When a customer adds money to their wallet, the running bonus that pays them the most is credited as a separate wallet entry.
        </p>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-lg border border-slate-300 px-4 py-2 text-sm">Cancel</button>
          <button type="submit" disabled={saving} className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60">
            {saving && <Loader2 className="h-4 w-4 animate-spin" />} Save
          </button>
        </div>
      </form>
    </div>
  )
}

/** Wallet top-up bonus rules (old panel: Customer Wallet → Bonus). */
export default function Bonus() {
  const [bonuses, setBonuses] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState("")
  const [editing, setEditing] = useState(null)

  const load = async (q = search) => {
    try {
      setLoading(true)
      const res = await customerExtrasAPI.getWalletBonuses({ search: q.trim() || undefined })
      setBonuses(dataOf(res).bonuses || [])
    } catch (err) {
      toast.error(errorMessage(err, "Could not load the bonuses"))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    const timer = setTimeout(() => load(search), 250)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search])

  const toggle = async (b) => {
    try {
      await customerExtrasAPI.updateWalletBonus(b.id, { isActive: !b.isActive })
      load()
    } catch (err) {
      toast.error(errorMessage(err, "Could not change the status"))
    }
  }

  const remove = async (b) => {
    if (!window.confirm(`Delete the bonus "${b.title}"? Bonuses already paid stay in customers' wallets.`)) return
    try {
      await customerExtrasAPI.deleteWalletBonus(b.id)
      toast.success("Bonus deleted")
      load()
    } catch (err) {
      toast.error(errorMessage(err, "Could not delete the bonus"))
    }
  }

  return (
    <div className="min-h-screen bg-slate-50 p-4 lg:p-6">
      <div className="mx-auto max-w-7xl space-y-6">
        <PageHeader icon={Gift} title="Wallet Bonus" description="Extra money customers get when they add to their wallet, e.g. 10% extra on ₹500 or more.">
          <button type="button" onClick={() => setEditing({})} className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700">
            <Plus className="h-4 w-4" /> New bonus
          </button>
        </PageHeader>

        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-6 py-4">
            <h2 className="text-base font-semibold text-slate-900">Bonus list <span className="ml-1 text-sm font-normal text-slate-500">{bonuses.length}</span></h2>
            <div className="relative w-full max-w-xs">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input className={`${inputClass} pl-9`} placeholder="Search by bonus title" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
          </div>
          {loading ? (
            <div className="py-16 text-center"><Loader2 className="mx-auto h-6 w-6 animate-spin text-slate-400" /></div>
          ) : !bonuses.length ? (
            <p className="py-16 text-center text-sm text-slate-500">{search.trim() ? "No bonus matches that title." : "No wallet bonuses yet."}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-left text-xs font-semibold text-slate-600">
                  <tr>
                    <th className="px-4 py-3">Title</th>
                    <th className="px-4 py-3">Bonus</th>
                    <th className="px-4 py-3">Minimum add</th>
                    <th className="px-4 py-3">Runs</th>
                    <th className="px-4 py-3">Paid so far</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {bonuses.map((b) => (
                    <tr key={b.id} className="align-top">
                      <td className="px-4 py-3">
                        <div className="font-medium text-slate-800">{b.title}</div>
                        {b.description && <div className="text-xs text-slate-500">{b.description}</div>}
                      </td>
                      <td className="px-4 py-3 text-slate-700">{describe(b)}</td>
                      <td className="whitespace-nowrap px-4 py-3 text-slate-700">{b.minimumAddAmount > 0 ? formatMoney(b.minimumAddAmount) : "Any amount"}</td>
                      <td className="whitespace-nowrap px-4 py-3 text-slate-600">{formatDate(b.startDate)} – {formatDate(b.endDate)}</td>
                      <td className="whitespace-nowrap px-4 py-3 text-slate-600">{b.timesPaid ? `${formatMoney(b.totalPaid)} · ${b.timesPaid}×` : "Not used yet"}</td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            role="switch"
                            aria-checked={b.isActive}
                            onClick={() => toggle(b)}
                            className={`relative h-5 w-9 rounded-full transition-colors ${b.isActive ? "bg-blue-600" : "bg-slate-300"}`}
                            aria-label={b.isActive ? "Switch off" : "Switch on"}
                          >
                            <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${b.isActive ? "left-4" : "left-0.5"}`} />
                          </button>
                          <span className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${STATE[b.state]?.cls || ""}`}>{STATE[b.state]?.label || b.state}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex justify-end gap-2">
                          <button type="button" onClick={() => setEditing(b)} className="rounded-lg border border-slate-300 p-1.5 text-slate-600 hover:bg-slate-50" aria-label="Edit">
                            <Pencil className="h-4 w-4" />
                          </button>
                          <button type="button" onClick={() => remove(b)} className="rounded-lg border border-slate-300 p-1.5 text-rose-600 hover:bg-rose-50" aria-label="Delete">
                            <Trash2 className="h-4 w-4" />
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
        <BonusForm
          bonus={editing}
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
