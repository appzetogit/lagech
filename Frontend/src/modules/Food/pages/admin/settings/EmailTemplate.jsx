import { useEffect, useRef, useState } from "react"
import { Eye, Mail, RotateCcw } from "@food/components/admin/theme/icons"
import { toast } from "sonner"
import { adminSystemExtrasAPI } from "@food/api/adminSystemExtras"
import { PageFrame, Card, Field, Switch, SaveButton, Loading, inputClass, errorMessage, formatDateTime } from "../system/SettingsUi"

/**
 * The emails the backend sends, with their wording editable. Only emails that
 * are actually sent are listed; each falls back to its built-in text when the
 * saved one is switched off or reset.
 */
export default function EmailTemplate() {
  const [templates, setTemplates] = useState([])
  const [loading, setLoading] = useState(true)
  const [selectedKey, setSelectedKey] = useState("")
  const [form, setForm] = useState(null)
  const [values, setValues] = useState({})
  const [preview, setPreview] = useState(null)
  const [busy, setBusy] = useState("")
  const [settings, setSettings] = useState(null)
  const [recipientsText, setRecipientsText] = useState("")
  const bodyRef = useRef(null)

  const selected = templates.find((t) => t.key === selectedKey)

  const load = async (keepKey) => {
    try {
      setLoading(true)
      const res = await adminSystemExtrasAPI.getEmailTemplates()
      const list = res?.data?.data?.templates || []
      setTemplates(list)
      const loadedSettings = res?.data?.data?.settings || null
      setSettings(loadedSettings)
      setRecipientsText((loadedSettings?.adminRecipients || []).join("\n"))
      const key = keepKey || list[0]?.key || ""
      setSelectedKey(key)
      const current = list.find((t) => t.key === key)
      if (current) setForm({ subject: current.subject, body: current.body, isActive: current.isActive })
    } catch (err) {
      toast.error(errorMessage(err, "Failed to load email templates"))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [])

  const choose = (template) => {
    setSelectedKey(template.key)
    setForm({ subject: template.subject, body: template.body, isActive: template.isActive })
    setPreview(null)
    setValues({})
  }

  const insertPlaceholder = (key) => {
    const token = `{{${key}}}`
    const el = bodyRef.current
    if (!el) return setForm((f) => ({ ...f, body: `${f.body}${token}` }))
    const start = el.selectionStart ?? form.body.length
    const end = el.selectionEnd ?? form.body.length
    const body = `${form.body.slice(0, start)}${token}${form.body.slice(end)}`
    setForm((f) => ({ ...f, body }))
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(start + token.length, start + token.length)
    })
  }

  const runPreview = async () => {
    try {
      setBusy("preview")
      const res = await adminSystemExtrasAPI.previewEmailTemplate(selectedKey, { ...form, values })
      setPreview(res?.data?.data || null)
    } catch (err) {
      toast.error(errorMessage(err, "Could not preview"))
    } finally {
      setBusy("")
    }
  }

  const save = async () => {
    try {
      setBusy("save")
      await adminSystemExtrasAPI.saveEmailTemplate(selectedKey, form)
      toast.success("Template saved")
      load(selectedKey)
    } catch (err) {
      toast.error(errorMessage(err, "Failed to save"))
    } finally {
      setBusy("")
    }
  }

  const toggleSending = async (template, enabled) => {
    try {
      setBusy("sending")
      const res = await adminSystemExtrasAPI.saveEmailSettings({ switches: { [template.key]: enabled } })
      const saved = res?.data?.data
      if (saved) setSettings(saved)
      setTemplates((list) => list.map((t) => (t.key === template.key ? { ...t, sendEnabled: enabled } : t)))
      toast.success(enabled ? "This email will be sent" : "This email will not be sent")
    } catch (err) {
      toast.error(errorMessage(err, "Failed to save"))
    } finally {
      setBusy("")
    }
  }

  const saveRecipients = async () => {
    try {
      setBusy("recipients")
      const adminRecipients = recipientsText.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean)
      const res = await adminSystemExtrasAPI.saveEmailSettings({ adminRecipients })
      const saved = res?.data?.data
      if (saved) {
        setSettings(saved)
        setRecipientsText((saved.adminRecipients || []).join("\n"))
      }
      toast.success("Admin addresses saved")
    } catch (err) {
      toast.error(errorMessage(err, "Failed to save"))
    } finally {
      setBusy("")
    }
  }

  const reset = async () => {
    if (!window.confirm("Go back to the built-in wording for this email?")) return
    try {
      setBusy("reset")
      await adminSystemExtrasAPI.resetEmailTemplate(selectedKey)
      toast.success("Back to the built-in wording")
      setPreview(null)
      load(selectedKey)
    } catch (err) {
      toast.error(errorMessage(err, "Failed to reset"))
    } finally {
      setBusy("")
    }
  }

  return (
    <PageFrame icon={Mail} title="Email Templates" description="The wording of the emails this system sends. Placeholders in double braces are filled in when the email goes out.">
      {loading && !templates.length ? (
        <Card><Loading /></Card>
      ) : !templates.length ? (
        <Card><p className="py-10 text-center text-sm text-slate-500">This system sends no emails yet.</p></Card>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[260px_1fr]">
          <div className="space-y-6">
          <Card title="Admin notifications" description="Where emails to the admin go (new registrations). One address per line.">
            <textarea
              className={`${inputClass} text-xs`}
              rows={3}
              value={recipientsText}
              placeholder={settings?.businessEmail || "admin@example.com"}
              onChange={(e) => setRecipientsText(e.target.value)}
            />
            <p className="mt-1 text-[11px] text-slate-500">
              {settings?.adminRecipients?.length
                ? "Admin emails go to these addresses."
                : `Empty: admin emails go to the Business Info email${settings?.businessEmail ? ` (${settings.businessEmail})` : ""}.`}
            </p>
            <div className="mt-2 flex justify-end">
              <SaveButton saving={busy === "recipients"} onClick={saveRecipients} disabled={Boolean(busy) && busy !== "recipients"} />
            </div>
          </Card>
          <Card className="h-fit">
            <ul className="space-y-1">
              {templates.map((t) => (
                <li key={t.key}>
                  <button
                    type="button"
                    onClick={() => choose(t)}
                    className={`w-full rounded-lg px-3 py-2 text-left text-sm ${t.key === selectedKey ? "bg-blue-50 text-blue-800 font-semibold" : "text-slate-700 hover:bg-slate-50"}`}
                  >
                    {t.name}
                    <span className="block text-[11px] font-normal text-slate-500">
                      {t.sendEnabled === false ? "Not sent · " : ""}
                      {t.isCustomized ? (t.isActive ? "Custom wording" : "Custom wording, switched off") : "Built-in wording"}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </Card>
          </div>

          {selected && form && (
            <div className="space-y-6">
              <Card title={selected.name} description={selected.description}>
                <div className="space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                    <p className="text-xs text-slate-600">
                      Goes to: {(selected.audience || []).map((a) => (a === "rider" ? "delivery partner" : a)).join(", ") || "-"}
                      {(selected.audience || []).includes("customer") && " (only customers with an email address)"}
                    </p>
                    {selected.canDisable ? (
                      <label className="flex items-center gap-2 text-sm text-slate-700">
                        <Switch checked={selected.sendEnabled !== false} disabled={Boolean(busy)} onChange={(v) => toggleSending(selected, v)} label="Send this email" />
                        Send this email
                      </label>
                    ) : (
                      <span className="text-xs text-slate-500">Always sent</span>
                    )}
                  </div>
                  <Field label="Subject">
                    <input className={inputClass} maxLength={200} value={form.subject} onChange={(e) => setForm((f) => ({ ...f, subject: e.target.value }))} />
                  </Field>
                  <div>
                    <p className="text-xs font-semibold text-slate-600 mb-1.5">Placeholders — click to insert at the cursor</p>
                    <div className="flex flex-wrap gap-2">
                      {selected.placeholders.map((p) => (
                        <button key={p.key} type="button" onClick={() => insertPlaceholder(p.key)} title={p.description} className="rounded-md border border-slate-300 bg-slate-50 px-2 py-1 font-mono text-xs text-slate-700 hover:bg-slate-100">
                          {`{{${p.key}}}`}
                        </button>
                      ))}
                    </div>
                    <ul className="mt-2 space-y-0.5 text-[11px] text-slate-500">
                      {selected.placeholders.map((p) => <li key={p.key}><span className="font-mono">{`{{${p.key}}}`}</span> — {p.description}</li>)}
                    </ul>
                  </div>
                  <Field label="Body (HTML)">
                    <textarea ref={bodyRef} className={`${inputClass} font-mono text-xs`} rows={14} value={form.body} onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))} />
                  </Field>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <label className="flex items-center gap-2 text-sm text-slate-700">
                      <Switch checked={form.isActive} onChange={(v) => setForm((f) => ({ ...f, isActive: v }))} label="Use this wording" />
                      Use this wording (off sends the built-in text)
                    </label>
                    <div className="flex flex-wrap gap-2">
                      {selected.isCustomized && (
                        <button type="button" onClick={reset} disabled={Boolean(busy)} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50">
                          <RotateCcw className="w-4 h-4" /> Reset to built-in
                        </button>
                      )}
                      <button type="button" onClick={runPreview} disabled={Boolean(busy)} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50">
                        <Eye className="w-4 h-4" /> Preview
                      </button>
                      <SaveButton saving={busy === "save"} onClick={save} disabled={Boolean(busy) && busy !== "save"} />
                    </div>
                  </div>
                  {selected.updatedAt && <p className="text-[11px] text-slate-500">Last saved {formatDateTime(selected.updatedAt)}</p>}
                </div>
              </Card>

              <Card title="Preview" description="Type values to see the email filled in. Empty placeholders show their name in brackets.">
                <div className="grid gap-3 sm:grid-cols-3 mb-4">
                  {selected.placeholders.map((p) => (
                    <Field key={p.key} label={p.key}>
                      <input className={inputClass} value={values[p.key] || ""} onChange={(e) => setValues((v) => ({ ...v, [p.key]: e.target.value }))} />
                    </Field>
                  ))}
                </div>
                {preview ? (
                  <div className="rounded-lg border border-slate-200">
                    <p className="border-b border-slate-200 bg-slate-50 px-4 py-2 text-sm"><span className="text-slate-500">Subject:</span> <span className="font-medium text-slate-900">{preview.subject}</span></p>
                    <iframe title="Email preview" sandbox="" srcDoc={preview.html} className="h-96 w-full rounded-b-lg bg-white" />
                  </div>
                ) : (
                  <p className="text-sm text-slate-500">Press Preview to render the email.</p>
                )}
              </Card>
            </div>
          )}
        </div>
      )}
    </PageFrame>
  )
}
