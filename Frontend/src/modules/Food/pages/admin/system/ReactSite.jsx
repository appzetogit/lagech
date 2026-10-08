import { Link } from "react-router-dom"
import { Monitor } from "@food/components/admin/theme/icons"
import { PageFrame, Card, Field, Switch, SaveButton, Loading, inputClass, setIn, formatDateTime, useSettingsArea } from "./SettingsUi"

/**
 * The customer website: its address and a maintenance notice. The website
 * reads these with the landing page (GET /food/public/landing, `website`).
 */
export default function ReactSite() {
  const { value, setValue, updatedAt, loading, saving, save } = useSettingsArea("website")
  const set = (key, next) => setValue((v) => setIn(v, [key], next))

  return (
    <PageFrame
      icon={Monitor}
      title="Website"
      description="The customer website's address, and a notice to show while it is under maintenance."
      actions={<SaveButton saving={saving} onClick={() => save()} disabled={loading} />}
    >
      {loading || !value ? (
        <Card><Loading /></Card>
      ) : (
        <>
          <Card>
            <div className="space-y-4">
              <Field label="Website address" hint="Used for links to the website.">
                <input className={inputClass} type="url" placeholder="https://" value={value.siteUrl} onChange={(e) => set("siteUrl", e.target.value)} />
              </Field>
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <Switch checked={value.maintenanceMode} onChange={(v) => set("maintenanceMode", v)} label="Maintenance notice" />
                Maintenance mode: show this notice on the website and pause customer ordering (also on Business Settings)
              </label>
              <Field label="Maintenance message">
                <textarea className={inputClass} rows={3} maxLength={500} value={value.maintenanceMessage} onChange={(e) => set("maintenanceMessage", e.target.value)} />
              </Field>
              <p className="text-xs text-slate-500">{updatedAt ? `Last saved ${formatDateTime(updatedAt)}` : "Not saved yet"}</p>
            </div>
          </Card>
          <Card title="Also for the website">
            <ul className="space-y-1 text-sm">
              <li><Link className="text-blue-700 hover:underline" to="/admin/food/landing-page-settings/react">Landing page</Link></li>
              <li><Link className="text-blue-700 hover:underline" to="/admin/food/page-meta-data">Page meta data</Link></li>
              <li><Link className="text-blue-700 hover:underline" to="/admin/food/pages-social-media/social-media">Social media</Link></li>
            </ul>
          </Card>
        </>
      )}
    </PageFrame>
  )
}
