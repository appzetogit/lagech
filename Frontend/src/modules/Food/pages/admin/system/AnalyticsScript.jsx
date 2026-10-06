import { BarChart3 } from "@food/components/admin/theme/icons"
import { PageFrame, Card, Field, Switch, SaveButton, Loading, inputClass, setIn, formatDateTime, useSettingsArea } from "./SettingsUi"

/**
 * Tracking ids for the customer website (Google Analytics, Google Tag
 * Manager, Meta Pixel). Only the id is stored; the website adds the standard
 * snippet for each tool that is switched on. The apps can read the same ids
 * from the public app settings.
 */
export default function AnalyticsScript() {
  const { value, setValue, catalog, updatedAt, loading, saving, save } = useSettingsArea("analytics_scripts")
  const tools = catalog.tools || []

  return (
    <PageFrame
      icon={BarChart3}
      title="Analytics Script"
      description="Add your tracking ids. The customer website loads each tool that is switched on; the admin, restaurant and rider panels are never tracked."
      actions={<SaveButton saving={saving} onClick={() => save()} disabled={loading} />}
    >
      {loading || !value ? (
        <Card><Loading /></Card>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {tools.map((tool) => {
              const entry = value?.[tool.key] || {}
              return (
                <Card key={tool.key}>
                  <div className="flex items-center justify-between gap-3">
                    <h2 className="text-sm font-semibold text-slate-900">{tool.label}</h2>
                    <Switch
                      checked={Boolean(entry.enabled)}
                      onChange={(v) => setValue((cur) => setIn(cur, [tool.key, "enabled"], v))}
                      label={`${tool.label} on`}
                    />
                  </div>
                  <Field label={tool.idLabel} hint={`Looks like ${tool.example}`} className="mt-3">
                    <input
                      className={inputClass}
                      placeholder={tool.example}
                      maxLength={40}
                      value={entry.id || ""}
                      onChange={(e) => setValue((cur) => setIn(cur, [tool.key, "id"], e.target.value.trim()))}
                    />
                  </Field>
                </Card>
              )
            })}
          </div>
          {updatedAt && <p className="text-xs text-slate-500">Last saved {formatDateTime(updatedAt)}.</p>}
        </>
      )}
    </PageFrame>
  )
}
