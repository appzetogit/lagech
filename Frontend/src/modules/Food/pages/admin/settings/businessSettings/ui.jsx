import { Link } from "react-router-dom"
import { Plus, Trash2, ExternalLink } from "@food/components/admin/theme/icons"
import { Card, Field, Switch, SaveButton, Loading, inputClass, formatDateTime } from "../../system/SettingsUi"

/**
 * Small pieces shared by the Business Settings tabs.
 */

/** Marks a setting that is saved and published to the apps but not enforced by the server yet. */
export function NotApplied({ children = "Saved, not yet applied" }) {
  return (
    <span className="ml-2 inline-flex items-center rounded-full bg-amber-50 border border-amber-200 px-2 py-0.5 text-[10px] font-semibold text-amber-700 align-middle">
      {children}
    </span>
  )
}

/** One switch row: label, hint, and the switch on the right. */
export function SwitchRow({ label, hint, checked, onChange, notApplied, disabled }) {
  return (
    <div className="flex items-start justify-between gap-4 py-3 border-b border-slate-100 last:border-b-0">
      <div className="min-w-0">
        <p className="text-sm font-medium text-slate-800">
          {label}
          {notApplied && <NotApplied>{typeof notApplied === "string" ? notApplied : undefined}</NotApplied>}
        </p>
        {hint && <p className="text-xs text-slate-500 mt-0.5">{hint}</p>}
      </div>
      <Switch checked={Boolean(checked)} onChange={onChange} label={label} disabled={disabled} />
    </div>
  )
}

/** A number input that keeps what is typed (the server checks the range). */
export function NumberField({ label, hint, value, onChange, min = 0, max, step = "1", suffix, notApplied }) {
  return (
    <Field
      label={
        <>
          {label}
          {notApplied && <NotApplied />}
        </>
      }
      hint={hint}
    >
      <div className="flex items-center gap-2">
        <input
          type="number"
          className={inputClass}
          min={min}
          max={max}
          step={step}
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value === "" ? "" : Number(e.target.value))}
        />
        {suffix && <span className="text-xs text-slate-500 whitespace-nowrap">{suffix}</span>}
      </div>
    </Field>
  )
}

/** Links to the pages where related settings already live. */
export function RelatedLinks({ title = "Related settings", links }) {
  return (
    <Card title={title}>
      <ul className="grid gap-2 sm:grid-cols-2">
        {links.map((link) => (
          <li key={link.to}>
            <Link to={link.to} className="inline-flex items-center gap-1.5 text-sm text-blue-700 hover:underline">
              <ExternalLink className="w-3.5 h-3.5" /> {link.label}
            </Link>
            {link.hint && <p className="text-xs text-slate-500 ml-5">{link.hint}</p>}
          </li>
        ))}
      </ul>
    </Card>
  )
}

/** The tab's Save button with when it was last saved. */
export function SaveBar({ saving, onSave, updatedAt, disabled }) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-3">
      <span className="text-xs text-slate-500">{updatedAt ? `Last saved ${formatDateTime(updatedAt)}` : "Not saved yet: showing the defaults"}</span>
      <SaveButton saving={saving} onClick={onSave} disabled={disabled} />
    </div>
  )
}

/** Shows a loading card until the area has loaded. */
export function AreaGate({ area, children }) {
  if (area.loading || !area.value) {
    return (
      <Card>
        <Loading />
      </Card>
    )
  }
  return children
}

/** Add, edit, switch off and remove reasons ({ id, text, isActive }). */
export function ReasonListEditor({ reasons = [], onChange, placeholder = "Add a reason" }) {
  const update = (index, patch) => onChange(reasons.map((r, i) => (i === index ? { ...r, ...patch } : r)))
  const remove = (index) => onChange(reasons.filter((_, i) => i !== index))
  const add = () => onChange([...reasons, { text: "", isActive: true }])
  return (
    <div className="space-y-2">
      {reasons.length === 0 && <p className="text-sm text-slate-500">None yet.</p>}
      {reasons.map((reason, index) => (
        <div key={reason.id || `new-${index}`} className="flex items-center gap-3">
          <input
            className={inputClass}
            value={reason.text}
            maxLength={200}
            placeholder={placeholder}
            onChange={(e) => update(index, { text: e.target.value })}
          />
          <Switch checked={reason.isActive !== false} onChange={(v) => update(index, { isActive: v })} label="Active" />
          <button type="button" onClick={() => remove(index)} className="p-2 text-slate-400 hover:text-red-600" aria-label="Remove">
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={add}
        className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
      >
        <Plus className="w-3.5 h-3.5" /> Add
      </button>
    </div>
  )
}
