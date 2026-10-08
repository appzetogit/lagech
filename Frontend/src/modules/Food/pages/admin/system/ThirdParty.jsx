import { useCallback, useEffect, useMemo, useState } from "react"
import { Link as RouterLink } from "react-router-dom"
import { toast } from "sonner"
import { Settings, Lock, Eye, EyeOff, Download, Info, CheckCircle, Mail, Phone, ExternalLink, Clock } from "@food/components/admin/theme/icons"
import { adminThirdPartyAPI } from "@food/api/adminThirdParty"
import { PageFrame, Card, Field, Switch, SaveButton, Loading, inputClass, errorMessage, formatDateTime } from "./SettingsUi"

/**
 * 3rd Party: the credentials the server uses for SMS, email, maps, payments
 * and the rest, one tab per area as on the old panel.
 *
 * Every field shows where its value comes from: "Using server setting" (the
 * server's own configuration) or "Saved in admin" (saved here, which wins).
 * Secrets never come back from the server — only a mask — so a secret input
 * is always empty; leaving it empty keeps what is saved. Only the fields the
 * admin touched are sent on save, so saving one field never copies the rest.
 */

const TABS = ["sms", "mail", "maps", "social_login", "recaptcha", "storage", "payment"]

function SourceBadge({ field }) {
  if (field.unreadable) {
    return <span className="rounded-full bg-red-50 px-2 py-0.5 text-[11px] font-medium text-red-700">Saved value unreadable — enter it again</span>
  }
  if (field.source === "admin") {
    return <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-medium text-blue-700">Saved in admin</span>
  }
  if (field.source === "server") {
    return <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">Using server setting</span>
  }
  return <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">Not set</span>
}

function SecretInput({ field, value, onChange, clearing, onClear }) {
  const [show, setShow] = useState(false)
  const placeholder = clearing
    ? "Will use the server setting after saving"
    : field.hasValue
      ? `${field.masked || "Set"} — leave empty to keep`
      : "Not set"
  const Tag = field.type === "textarea" ? "textarea" : "input"
  return (
    <div className="space-y-1">
      <div className="relative">
        <Tag
          className={`${inputClass} pr-10 ${field.type === "textarea" ? "min-h-24 font-mono text-xs" : ""}`}
          type={field.type === "textarea" ? undefined : show ? "text" : "password"}
          autoComplete="new-password"
          spellCheck={false}
          placeholder={placeholder}
          value={value ?? ""}
          disabled={clearing}
          onChange={(e) => onChange(e.target.value)}
        />
        {field.type !== "textarea" && (
          <button
            type="button"
            onClick={() => setShow((s) => !s)}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
            aria-label={show ? "Hide what you typed" : "Show what you typed"}
          >
            {show ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
          </button>
        )}
      </div>
      {field.source === "admin" && (
        <button type="button" onClick={onClear} className="text-[11px] text-slate-500 hover:text-red-600">
          {clearing ? "Keep the saved value" : "Remove the saved value (use the server setting)"}
        </button>
      )}
    </div>
  )
}

function FieldInput({ field, draft, setDraft, clearing, toggleClear }) {
  const edited = Object.prototype.hasOwnProperty.call(draft, field.key)
  const value = edited ? draft[field.key] : field.value
  const set = (v) => setDraft((cur) => ({ ...cur, [field.key]: v }))

  let control
  if (field.secret) {
    control = (
      <SecretInput
        field={field}
        value={edited ? draft[field.key] : ""}
        onChange={set}
        clearing={clearing}
        onClear={() => toggleClear(field.key)}
      />
    )
  } else if (field.type === "boolean") {
    control = <Switch checked={Boolean(value)} onChange={set} label={field.label} />
  } else if (field.type === "select") {
    control = (
      <select className={inputClass} value={value ?? ""} onChange={(e) => set(e.target.value)}>
        {field.options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    )
  } else if (field.type === "textarea") {
    control = <textarea className={`${inputClass} min-h-20`} value={value ?? ""} onChange={(e) => set(e.target.value)} />
  } else {
    control = (
      <input
        className={inputClass}
        type={field.type === "number" ? "number" : "text"}
        value={value ?? ""}
        onChange={(e) => set(e.target.value)}
      />
    )
  }

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-1 text-xs font-semibold text-slate-600">
          {field.secret && <Lock className="w-3 h-3" />} {field.label}
        </span>
        <span className="flex items-center gap-2">
          {edited && <span className="text-[11px] text-amber-700">Changed</span>}
          <SourceBadge field={field} />
        </span>
      </div>
      {control}
      {field.help && <span className="block text-[11px] text-slate-500">{field.help}</span>}
      {field.storedOnly && <span className="block text-[11px] text-amber-700">Stored only — see the note above.</span>}
    </div>
  )
}

function TestSend({ kind, disabled }) {
  const [target, setTarget] = useState("")
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  const isSms = kind === "sms"

  const send = async () => {
    try {
      setBusy(true)
      setResult(null)
      const res = isSms ? await adminThirdPartyAPI.testSms(target) : await adminThirdPartyAPI.testMail(target)
      const d = res?.data?.data || {}
      setResult(d)
      if (d.sent) toast.success(isSms ? "Test SMS sent" : "Test email sent")
      else toast.error(d.reason || "Not sent")
    } catch (err) {
      toast.error(errorMessage(err, "Test failed"))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card
      title={isSms ? "Send a test SMS" : "Send a test email"}
      description={
        isSms
          ? "Sends the OTP message with a random code through the saved settings. Save your changes first."
          : "Sends a short test email through the saved settings. Save your changes first."
      }
    >
      <div className="flex flex-wrap items-end gap-3">
        <Field label={isSms ? "Mobile number" : "Email address"} className="flex-1 min-w-56">
          <input
            className={inputClass}
            type={isSms ? "tel" : "email"}
            placeholder={isSms ? "10-digit mobile number" : "you@example.com"}
            value={target}
            onChange={(e) => setTarget(e.target.value)}
          />
        </Field>
        <button
          type="button"
          onClick={send}
          disabled={busy || disabled || !target.trim()}
          className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-60"
        >
          {isSms ? <Phone className="w-4 h-4" /> : <Mail className="w-4 h-4" />} {busy ? "Sending…" : "Send test"}
        </button>
      </div>
      {disabled && <p className="mt-2 text-[11px] text-amber-700">Save or discard your changes before testing.</p>}
      {result && (
        <div className={`mt-3 rounded-lg px-3 py-2 text-xs ${result.sent ? "bg-green-50 text-green-800" : "bg-red-50 text-red-800"}`}>
          {result.sent ? "Sent." : `Not sent: ${result.reason || "unknown reason"}`}
          {result.reply ? <span className="block mt-1 font-mono text-[11px] break-all">Provider reply: {result.reply}</span> : null}
          {isSms && result.fixedOtpMode && (
            <span className="block mt-1">
              Note: the server runs with the fixed test OTP, so logins do not send SMS until that is turned off on the server.
            </span>
          )}
        </div>
      )}
    </Card>
  )
}

function ImportControls({ label, onImport, busy }) {
  const [overwrite, setOverwrite] = useState(false)
  return (
    <div className="flex flex-wrap items-center gap-3">
      <label className="flex items-center gap-2 text-xs text-slate-600">
        <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} />
        Also replace values saved in admin
      </label>
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          const msg = overwrite
            ? "Copy the server's current settings into admin, replacing values already saved here?"
            : "Copy the server's current settings into admin? Values already saved here are kept."
          if (window.confirm(msg)) onImport(overwrite)
        }}
        className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-60"
      >
        <Download className="w-4 h-4" /> {busy ? "Importing…" : label}
      </button>
    </div>
  )
}

export default function ThirdParty() {
  const [areas, setAreas] = useState(null)
  const [tab, setTab] = useState("sms")
  const [draft, setDraft] = useState({})
  const [clear, setClear] = useState([])
  const [saving, setSaving] = useState(false)
  const [importing, setImporting] = useState(false)
  const [audit, setAudit] = useState([])
  const [loadError, setLoadError] = useState("")

  const loadAudit = useCallback(() => {
    adminThirdPartyAPI
      .getAudit(20)
      .then((res) => setAudit(res?.data?.data?.entries || []))
      .catch(() => {})
  }, [])

  useEffect(() => {
    adminThirdPartyAPI
      .getAll()
      .then((res) => setAreas(res?.data?.data?.areas || []))
      .catch((err) => setLoadError(errorMessage(err, "Failed to load settings")))
    loadAudit()
  }, [loadAudit])

  const byKey = useMemo(() => Object.fromEntries((areas || []).map((a) => [a.area, a])), [areas])
  const area = byKey[tab]
  const dirty = Object.keys(draft).length > 0 || clear.length > 0

  const replaceArea = (next) => setAreas((cur) => (cur || []).map((a) => (a.area === next.area ? next : a)))

  const switchTab = (next) => {
    if (dirty && !window.confirm("Discard your unsaved changes on this tab?")) return
    setDraft({})
    setClear([])
    setTab(next)
  }

  const toggleClear = (key) => {
    setClear((cur) => (cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key]))
    setDraft((cur) => {
      const { [key]: _drop, ...rest } = cur
      return rest
    })
  }

  const save = async () => {
    try {
      setSaving(true)
      const res = await adminThirdPartyAPI.saveArea(tab, { values: draft, clear })
      const d = res?.data?.data
      if (d) replaceArea(d)
      setDraft({})
      setClear([])
      toast.success(d?.changed?.length ? "Saved" : "Nothing to save")
      loadAudit()
    } catch (err) {
      toast.error(errorMessage(err, "Failed to save"))
    } finally {
      setSaving(false)
    }
  }

  const importArea = async (overwrite) => {
    try {
      setImporting(true)
      const res = await adminThirdPartyAPI.importArea(tab, overwrite)
      const d = res?.data?.data
      if (d) replaceArea(d)
      setDraft({})
      setClear([])
      toast.success(d?.imported?.length ? `Imported ${d.imported.length} setting(s)` : "Nothing new to import")
      loadAudit()
    } catch (err) {
      toast.error(errorMessage(err, "Import failed"))
    } finally {
      setImporting(false)
    }
  }

  const importAll = async (overwrite) => {
    try {
      setImporting(true)
      const res = await adminThirdPartyAPI.importAll(overwrite)
      const list = res?.data?.data?.areas || []
      setAreas((cur) => (cur || []).map((a) => list.find((n) => n.area === a.area) || a))
      setDraft({})
      setClear([])
      const count = list.reduce((sum, a) => sum + (a.imported?.length || 0), 0)
      toast.success(count ? `Imported ${count} setting(s)` : "Nothing new to import")
      loadAudit()
    } catch (err) {
      toast.error(errorMessage(err, "Import failed"))
    } finally {
      setImporting(false)
    }
  }

  return (
    <PageFrame
      icon={Settings}
      title="3rd Party"
      description="Credentials for SMS, email, maps, payments and storage. Each field shows whether the server's own setting is in use or a value saved here. Secrets are stored encrypted and never shown again after saving."
      actions={areas && <ImportControls label="Import all server settings" onImport={importAll} busy={importing} />}
    >
      {loadError ? (
        <Card>
          <p className="text-sm text-red-700">{loadError}</p>
        </Card>
      ) : !areas ? (
        <Card><Loading /></Card>
      ) : (
        <>
          <div className="flex flex-wrap gap-2 border-b border-slate-200">
            {TABS.filter((key) => byKey[key]).map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => switchTab(key)}
                className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${tab === key ? "border-blue-600 text-blue-700" : "border-transparent text-slate-600 hover:text-slate-900"}`}
              >
                {byKey[key].label}
              </button>
            ))}
          </div>

          {area && (
            <>
              <div className={`flex items-start gap-2 rounded-xl border px-4 py-3 text-sm ${area.wired ? "border-green-200 bg-green-50 text-green-900" : "border-amber-200 bg-amber-50 text-amber-900"}`}>
                {area.wired ? <CheckCircle className="w-4 h-4 mt-0.5 shrink-0" /> : <Info className="w-4 h-4 mt-0.5 shrink-0" />}
                <div>
                  <p className="font-semibold">{area.wired ? "Used by the server" : "Stored only"}</p>
                  <p className="mt-0.5">{area.note}</p>
                  {area.area === "social_login" && (
                    <RouterLink to="/admin/food/login-setup" className="mt-1 inline-flex items-center gap-1 text-blue-700 hover:underline">
                      Open Login Setup <ExternalLink className="w-3 h-3" />
                    </RouterLink>
                  )}
                </div>
              </div>

              <Card
                title={area.label}
                description={area.savedAt ? `Last saved in admin ${formatDateTime(area.savedAt)}.` : "Nothing saved in admin yet: the server settings are in use."}
              >
                <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
                  {area.fields.map((field) => (
                    <FieldInput
                      key={field.key}
                      field={field}
                      draft={draft}
                      setDraft={setDraft}
                      clearing={clear.includes(field.key)}
                      toggleClear={toggleClear}
                    />
                  ))}
                </div>
                <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4">
                  <ImportControls label="Import server settings" onImport={importArea} busy={importing} />
                  <div className="flex items-center gap-3">
                    {dirty && (
                      <button type="button" onClick={() => { setDraft({}); setClear([]) }} className="text-sm text-slate-600 hover:text-slate-900">
                        Discard changes
                      </button>
                    )}
                    <SaveButton saving={saving} onClick={save} disabled={!dirty} />
                  </div>
                </div>
              </Card>

              {(tab === "sms" || tab === "mail") && <TestSend key={tab} kind={tab} disabled={dirty} />}
            </>
          )}

          <Card title="Recent changes" description="Who changed which settings. Values are never recorded.">
            {audit.length === 0 ? (
              <p className="text-sm text-slate-500">No changes yet.</p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {audit.map((entry) => (
                  <li key={entry.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-xs text-slate-600">
                    <span>
                      <span className="font-semibold text-slate-800">{byKey[entry.area]?.label || entry.area}</span>
                      {" — "}
                      {entry.action.replace(/_/g, " ")}
                      {entry.fields?.length ? `: ${entry.fields.join(", ")}` : ""}
                      {entry.adminEmail ? ` by ${entry.adminEmail}` : ""}
                    </span>
                    <span className="flex items-center gap-1 text-slate-400">
                      <Clock className="w-3 h-3" /> {formatDateTime(entry.createdAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}
    </PageFrame>
  )
}
