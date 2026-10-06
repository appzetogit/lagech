import { LogIn } from "lucide-react"
import { PageFrame, Card, Switch, SaveButton, Loading, setIn, formatDateTime, useSettingsArea } from "../system/SettingsUi"

const APP_LABELS = { customer: "Customer app", restaurant: "Restaurant app", rider: "Rider app" }

/**
 * Sign-in options per app. Phone number with OTP is how everyone signs in
 * today, so it stays on. The other options are saved for the apps to read;
 * the server does not offer those sign-ins yet.
 */
export default function LoginSetup() {
  const { value, setValue, catalog, updatedAt, loading, saving, save } = useSettingsArea("login_setup")
  const options = catalog.options || {}

  return (
    <PageFrame
      icon={LogIn}
      title="Login Setup"
      description="How people sign in to each app. Phone number with OTP is the only sign-in the system supports today, so it cannot be switched off — doing so would lock everyone out."
      actions={<SaveButton saving={saving} onClick={() => save()} disabled={loading} />}
    >
      {loading || !value ? (
        <Card><Loading /></Card>
      ) : (
        <>
          <div className="grid gap-6 md:grid-cols-3">
            {Object.entries(options).map(([app, list]) => (
              <Card key={app} title={APP_LABELS[app] || app}>
                <ul className="space-y-4">
                  {list.map((option) => (
                    <li key={option.key} className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-medium text-slate-800">{option.label}</p>
                        <p className="text-[11px] text-slate-500">
                          {option.locked ? "Always on" : "Saved for app use — not offered by the server yet"}
                        </p>
                      </div>
                      <Switch
                        checked={Boolean(value?.[app]?.[option.key])}
                        disabled={option.locked}
                        onChange={(v) => setValue((cur) => setIn(cur, [app, option.key], v))}
                        label={option.label}
                      />
                    </li>
                  ))}
                </ul>
              </Card>
            ))}
          </div>
          <p className="text-xs text-slate-500">{updatedAt ? `Last saved ${formatDateTime(updatedAt)}` : "Not saved yet"}</p>
        </>
      )}
    </PageFrame>
  )
}
