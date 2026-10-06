import { useMemo, useState } from "react"
import { Link } from "react-router-dom"
import { Bell } from "@food/components/admin/theme/icons"
import { PageFrame, Card, Switch, SaveButton, Loading, inputClass, setIn, formatDateTime, useSettingsArea } from "./SettingsUi"

const AUDIENCES = ["Customer", "Restaurant", "Delivery man"]

/**
 * The text of each order push (6amMart's "push notification messages").
 * A blank title or body keeps the system's own wording. On/off lives on
 * Notification Channels for the events that page already switches, so each
 * event has one switch; the rest are switched here, except the delivery offer
 * to riders, which always goes out.
 */
export default function FirebaseNotification() {
  const { value, setValue, catalog, updatedAt, loading, saving, save } = useSettingsArea("push_messages")
  const [audience, setAudience] = useState("Customer")
  const messages = catalog.messages || []
  const eventLabel = useMemo(
    () => Object.fromEntries((catalog.events || []).map((event) => [event.key, event.label])),
    [catalog.events],
  )
  const shown = messages.filter((message) => message.audience === audience)

  const set = (key, field, next) => setValue((cur) => setIn(cur, ["messages", key, field], next))

  return (
    <PageFrame
      icon={Bell}
      title="Firebase Notification"
      description="Write the push message sent for each order event. Leave a field blank to keep the system's own wording. Changes reach phones within about 30 seconds."
      actions={<SaveButton saving={saving} onClick={() => save()} disabled={loading} />}
    >
      {loading || !value ? (
        <Card><Loading /></Card>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            {AUDIENCES.map((name) => (
              <button
                key={name}
                type="button"
                onClick={() => setAudience(name)}
                className={`rounded-lg px-4 py-2 text-sm font-medium border ${audience === name ? "bg-blue-600 text-white border-blue-600" : "bg-white text-slate-700 border-slate-300 hover:bg-slate-50"}`}
              >
                {name}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {shown.map((message) => {
              const entry = value?.messages?.[message.key] || {}
              return (
                <Card key={message.key}>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h2 className="text-sm font-semibold text-slate-900">{message.label}</h2>
                      <p className="text-[11px] text-slate-500 mt-0.5">
                        {message.switchedOn === "here" && "Switch it off to stop this message."}
                        {message.switchedOn === "never" && "Always sent: without it orders are not delivered."}
                        {message.switchedOn === "notification_channels" && (
                          <>
                            Switched on{" "}
                            <Link to="/admin/food/notification-channels" className="text-blue-600 hover:underline">
                              Notification Channels
                            </Link>
                            {eventLabel[message.channel] ? ` ("${eventLabel[message.channel]}")` : ""}
                          </>
                        )}
                      </p>
                    </div>
                    {message.switchable && (
                      <Switch
                        checked={entry.enabled !== false}
                        onChange={(v) => set(message.key, "enabled", v)}
                        label={`Send "${message.label}"`}
                      />
                    )}
                  </div>
                  <div className="mt-3 space-y-2">
                    <input
                      className={inputClass}
                      placeholder="Title (blank keeps the default)"
                      maxLength={120}
                      value={entry.title || ""}
                      onChange={(e) => set(message.key, "title", e.target.value)}
                    />
                    <textarea
                      className={`${inputClass} min-h-[72px]`}
                      placeholder="Message (blank keeps the default)"
                      maxLength={500}
                      value={entry.body || ""}
                      onChange={(e) => set(message.key, "body", e.target.value)}
                    />
                    <p className="text-[11px] text-slate-500">
                      Placeholders: {message.placeholders.map((p) => `{${p}}`).join(" ")}
                    </p>
                  </div>
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
