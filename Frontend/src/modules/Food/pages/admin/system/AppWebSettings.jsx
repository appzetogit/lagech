import { Smartphone } from "@food/components/admin/theme/icons"
import { PageFrame, Card, Field, SaveButton, Loading, inputClass, setIn, formatDateTime, useSettingsArea } from "./SettingsUi"

/**
 * Minimum and latest versions and store links for each app. The apps read
 * these from GET /food/public/app-settings: older than the minimum must
 * update, older than the latest is offered the update.
 */
export default function AppWebSettings() {
  const { value, setValue, catalog, updatedAt, loading, saving, save } = useSettingsArea("app_settings")
  const apps = catalog.apps || []
  const platforms = catalog.platforms || []

  return (
    <PageFrame
      icon={Smartphone}
      title="App Settings"
      description="Versions and store links for the customer, restaurant and rider apps. An app older than its minimum version asks the user to update before going on; older than the latest version, it offers the update. Leave a version blank to skip the check."
      actions={<SaveButton saving={saving} onClick={() => save()} disabled={loading} />}
    >
      {loading || !value ? (
        <Card><Loading /></Card>
      ) : (
        <>
          {apps.map((app) => (
            <Card key={app.key} title={app.label}>
              <div className="grid gap-6 md:grid-cols-2">
                {platforms.map((platform) => {
                  const entry = value?.[app.key]?.[platform.key] || {}
                  const set = (field, next) => setValue((v) => setIn(v, [app.key, platform.key, field], next))
                  return (
                    <div key={platform.key} className="space-y-3 rounded-lg border border-slate-200 p-4">
                      <p className="text-sm font-semibold text-slate-800">{platform.label}</p>
                      <div className="grid gap-3 sm:grid-cols-2">
                        <Field label="Minimum version" hint="Older must update">
                          <input className={inputClass} placeholder="e.g. 1.0.0" value={entry.minVersion || ""} onChange={(e) => set("minVersion", e.target.value)} />
                        </Field>
                        <Field label="Latest version" hint="Older is offered the update">
                          <input className={inputClass} placeholder="e.g. 1.2.0" value={entry.latestVersion || ""} onChange={(e) => set("latestVersion", e.target.value)} />
                        </Field>
                      </div>
                      <Field label={platform.key === "ios" ? "App Store link" : "Play Store link"}>
                        <input className={inputClass} type="url" placeholder="https://" value={entry.storeUrl || ""} onChange={(e) => set("storeUrl", e.target.value)} />
                      </Field>
                    </div>
                  )
                })}
              </div>
            </Card>
          ))}
          <p className="text-xs text-slate-500">{updatedAt ? `Last saved ${formatDateTime(updatedAt)}` : "Not saved yet"}</p>
        </>
      )}
    </PageFrame>
  )
}
