import { useState } from "react"
import { Link } from "react-router-dom"
import { CreditCard, Plus, Trash2, Edit } from "@food/components/admin/theme/icons"
import { PageFrame, Card, Field, Switch, SaveButton, Loading, inputClass, formatDateTime, useSettingsArea } from "./SettingsUi"

const FIELD_TYPES = [
  ["text", "Text"],
  ["number", "Number"],
  ["email", "Email"],
]

const emptyMethod = () => ({
  name: "",
  isActive: true,
  paymentInfo: [{ label: "", value: "" }],
  fields: [{ label: "Transaction id", type: "text", required: true, placeholder: "" }],
})

/**
 * Offline payment methods (bank transfer, UPI, ...) offered at checkout. The
 * customer is shown the payment details, pays outside the app and fills in
 * the required fields; the order then waits in Orders -> Offline Payments
 * until it is verified or rejected there.
 */
export default function OfflinePaymentSetup() {
  const { value, setValue, updatedAt, loading, saving, save } = useSettingsArea("offline_payment")
  const [editing, setEditing] = useState(null) // { index, method } ; index -1 = new

  const methods = value?.methods || []

  const saveAll = async (nextMethods, enabled = value?.enabled) => {
    const next = { ...(value || {}), enabled: Boolean(enabled), methods: nextMethods }
    const ok = await save(next)
    if (ok) setEditing(null)
  }

  const toggleFeature = (enabled) => saveAll(methods, enabled)
  const toggleMethod = (index, isActive) => saveAll(methods.map((m, i) => (i === index ? { ...m, isActive } : m)))
  const removeMethod = (index) => {
    if (!window.confirm(`Delete "${methods[index]?.name}"? Orders already paid with it keep their record.`)) return
    saveAll(methods.filter((_, i) => i !== index))
  }
  const submitEdit = () => {
    const { index, method } = editing
    const next = index === -1 ? [...methods, method] : methods.map((m, i) => (i === index ? method : m))
    saveAll(next)
  }

  const editMethod = (patch) => setEditing((cur) => ({ ...cur, method: { ...cur.method, ...patch } }))
  const editRow = (list, index, patch) =>
    editMethod({ [list]: editing.method[list].map((row, i) => (i === index ? { ...row, ...patch } : row)) })

  return (
    <PageFrame
      icon={CreditCard}
      title="Offline Payment Setup"
      description="Payment methods the customer pays outside the app, such as bank transfer or UPI. Orders paid this way wait in Orders, Offline Payments, until you verify or reject the payment."
      actions={
        value && (
          <div className="flex items-center gap-3">
            <span className="text-sm text-slate-700">Offline payment {value.enabled ? "on" : "off"}</span>
            <Switch checked={Boolean(value.enabled)} onChange={toggleFeature} disabled={saving} label="Offline payment" />
          </div>
        )
      }
    >
      {loading || !value ? (
        <Card><Loading /></Card>
      ) : (
        <>
          {editing ? (
            <Card title={editing.index === -1 ? "Add payment method" : `Edit ${editing.method.name || "payment method"}`}>
              <div className="space-y-5">
                <Field label="Payment method name">
                  <input
                    className={inputClass}
                    maxLength={80}
                    placeholder="e.g. Bank transfer"
                    value={editing.method.name}
                    onChange={(e) => editMethod({ name: e.target.value })}
                  />
                </Field>

                <div>
                  <p className="text-xs font-semibold text-slate-600">Payment information shown to the customer</p>
                  <p className="text-[11px] text-slate-500 mb-2">Where to send the money, e.g. bank name, account number, IFSC, UPI id.</p>
                  <div className="space-y-2">
                    {editing.method.paymentInfo.map((row, i) => (
                      <div key={i} className="grid grid-cols-1 sm:grid-cols-[1fr_2fr_auto] gap-2">
                        <input className={inputClass} placeholder="Title, e.g. Account number" maxLength={80} value={row.label} onChange={(e) => editRow("paymentInfo", i, { label: e.target.value })} />
                        <input className={inputClass} placeholder="Value" maxLength={300} value={row.value} onChange={(e) => editRow("paymentInfo", i, { value: e.target.value })} />
                        <button type="button" onClick={() => editMethod({ paymentInfo: editing.method.paymentInfo.filter((_, j) => j !== i) })} className="px-2 text-slate-500 hover:text-red-600" aria-label="Remove">
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    ))}
                  </div>
                  <button type="button" onClick={() => editMethod({ paymentInfo: [...editing.method.paymentInfo, { label: "", value: "" }] })} className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-blue-600">
                    <Plus className="w-3 h-3" /> Add information
                  </button>
                </div>

                <div>
                  <p className="text-xs font-semibold text-slate-600">Information the customer fills in</p>
                  <p className="text-[11px] text-slate-500 mb-2">What you need to find the payment, e.g. transaction id or the sender's account name.</p>
                  <div className="space-y-2">
                    {editing.method.fields.map((field, i) => (
                      <div key={i} className="grid grid-cols-1 sm:grid-cols-[2fr_1fr_2fr_auto_auto] gap-2 items-center">
                        <input className={inputClass} placeholder="Field name" maxLength={80} value={field.label} onChange={(e) => editRow("fields", i, { label: e.target.value })} />
                        <select className={inputClass} value={field.type || "text"} onChange={(e) => editRow("fields", i, { type: e.target.value })}>
                          {FIELD_TYPES.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
                        </select>
                        <input className={inputClass} placeholder="Placeholder" maxLength={120} value={field.placeholder || ""} onChange={(e) => editRow("fields", i, { placeholder: e.target.value })} />
                        <label className="inline-flex items-center gap-1 text-xs text-slate-700">
                          <input type="checkbox" checked={Boolean(field.required)} onChange={(e) => editRow("fields", i, { required: e.target.checked })} /> Required
                        </label>
                        <button type="button" onClick={() => editMethod({ fields: editing.method.fields.filter((_, j) => j !== i) })} className="px-2 text-slate-500 hover:text-red-600" aria-label="Remove">
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    ))}
                  </div>
                  <button type="button" onClick={() => editMethod({ fields: [...editing.method.fields, { label: "", type: "text", required: false, placeholder: "" }] })} className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-blue-600">
                    <Plus className="w-3 h-3" /> Add field
                  </button>
                </div>

                <div className="flex justify-end gap-2">
                  <button type="button" onClick={() => setEditing(null)} className="rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-700 hover:bg-slate-50">Cancel</button>
                  <SaveButton saving={saving} onClick={submitEdit} />
                </div>
              </div>
            </Card>
          ) : (
            <Card>
              <div className="flex items-center justify-between gap-3 mb-4">
                <h2 className="text-base font-semibold text-slate-900">Payment methods</h2>
                <button type="button" onClick={() => setEditing({ index: -1, method: emptyMethod() })} className="inline-flex items-center gap-1 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700">
                  <Plus className="w-4 h-4" /> Add method
                </button>
              </div>
              {!methods.length ? (
                <p className="text-sm text-slate-500 py-8 text-center">No offline payment methods yet.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead className="bg-slate-50 border-b border-slate-200">
                      <tr>
                        <th className="px-4 py-3 text-left text-xs font-semibold text-slate-700">Method</th>
                        <th className="px-4 py-3 text-left text-xs font-semibold text-slate-700">Payment info</th>
                        <th className="px-4 py-3 text-left text-xs font-semibold text-slate-700">Customer fills in</th>
                        <th className="px-4 py-3 text-center text-xs font-semibold text-slate-700">Active</th>
                        <th className="px-4 py-3 text-right text-xs font-semibold text-slate-700">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {methods.map((method, index) => (
                        <tr key={method.id || index} className="align-top">
                          <td className="px-4 py-3 text-sm font-medium text-slate-900">{method.name}</td>
                          <td className="px-4 py-3 text-xs text-slate-600">
                            {method.paymentInfo.map((row) => <div key={row.label}>{row.label}: {row.value}</div>)}
                          </td>
                          <td className="px-4 py-3 text-xs text-slate-600">
                            {method.fields.map((field) => <div key={field.key || field.label}>{field.label}{field.required ? " *" : ""}</div>)}
                          </td>
                          <td className="px-4 py-3 text-center">
                            <div className="inline-flex">
                              <Switch checked={method.isActive !== false} onChange={(v) => toggleMethod(index, v)} disabled={saving} label={`${method.name} active`} />
                            </div>
                          </td>
                          <td className="px-4 py-3 text-right whitespace-nowrap">
                            <button type="button" onClick={() => setEditing({ index, method: JSON.parse(JSON.stringify(method)) })} className="p-2 text-slate-600 hover:text-blue-600" aria-label="Edit">
                              <Edit className="w-4 h-4" />
                            </button>
                            <button type="button" onClick={() => removeMethod(index)} className="p-2 text-slate-600 hover:text-red-600" aria-label="Delete">
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="mt-4 text-xs text-slate-500">
                Payments to verify are in{" "}
                <Link to="/admin/food/orders/offline-payments" className="text-blue-600 hover:underline">Orders, Offline Payments</Link>.
                {updatedAt ? ` Last saved ${formatDateTime(updatedAt)}.` : ""}
              </p>
            </Card>
          )}
        </>
      )}
    </PageFrame>
  )
}
