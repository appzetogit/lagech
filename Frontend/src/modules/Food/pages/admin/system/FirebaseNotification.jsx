import { useMemo, useState } from "react"
import { Link } from "react-router-dom"
import { Bell } from "@food/components/admin/theme/icons"
import { PageFrame, Card, Switch, SaveButton, Loading, inputClass, setIn, formatDateTime, useSettingsArea } from "./SettingsUi"

const AUDIENCES = ["Customer", "Restaurant", "Delivery man"]

/**
 * The text and on/off of each order push (6amMart's "push notification
 * messages"). A blank title or body keeps the system's own wording, shown as
 * the placeholder. Every message has its own switch, like the old panel;
 * Notification Channels stays the master switch for a whole group of events,
 * so a push goes out only when both are on. The delivery offer to riders
 * always goes out.
 *
 * Used by this page (3rd Party & Configurations -> Firebase) and by Business
 * Settings -> Push Notification; both edit the same push_messages document.
 */
export function PushMessagesEditor() {
  const { value, setValue, catalog, updatedAt, loading, saving, save } = useSettingsArea("push_messages")
  const [audience, setAudience] = useState("Customer")
  const messages = catalog.messages || []
  const eventLabel = useMemo(
    () => Object.fromEntries((catalog.events || []).map((event) => [event.key, event.label])),
    [catalog.events],
  )
  const shown = messages.filter((message) => message.audience === audience)

  const set = (key, field, next) => setValue((cur) => setIn(cur, ["messages", key, field], next))

  if (loading || !value) return <Card><Loading /></Card>

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
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
        <SaveButton saving={saving} onClick={() => save()} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {shown.map((message) => {
          const entry = value?.messages?.[message.key] || {}
          const on = entry.enabled !== false
          return (
            <Card key={message.key} className={on ? "" : "opacity-80"}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="text-sm font-semibold text-slate-900">{message.label}</h2>
                  <p className="text-[11px] text-slate-500 mt-0.5">
                    {message.switchedOn === "never" ? (
                      "Always sent: without it orders are not delivered."
                    ) : (
                      <>
                        {on ? "Sent." : "Off: this push is not sent."}
                        {message.channel && (
                          <>
                            {" "}Also needs{" "}
                            <Link to="/admin/food/notification-channels" className="text-blue-600 hover:underline">
                              Notification Channels
                            </Link>
                            {eventLabel[message.channel] ? ` ("${eventLabel[message.channel]}")` : ""} on.
                          </>
                        )}
                      </>
                    )}
                  </p>
                  {message.legacyKey && <p className="text-[10px] text-slate-400 mt-0.5 break-all">Old panel: {message.legacyKey}</p>}
                </div>
                {message.switchable && (
                  <Switch checked={on} onChange={(v) => set(message.key, "enabled", v)} label={`Send "${message.label}"`} />
                )}
              </div>
              <div className="mt-3 space-y-2">
                <input
                  className={inputClass}
                  placeholder={message.defaultTitle ? `Default: ${message.defaultTitle}` : "Title (blank keeps the default)"}
                  maxLength={120}
                  value={entry.title || ""}
                  onChange={(e) => set(message.key, "title", e.target.value)}
                  aria-label={`${message.label} title`}
                />
                <textarea
                  className={`${inputClass} min-h-[72px]`}
                  placeholder={message.defaultBody ? `Default: ${message.defaultBody}` : "Message (blank keeps the default)"}
                  maxLength={500}
                  value={entry.body || ""}
                  onChange={(e) => set(message.key, "body", e.target.value)}
                  aria-label={`${message.label} message`}
                />
                <div className="flex flex-wrap gap-1">
                  {message.placeholders.map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => set(message.key, "body", `${entry.body || ""}{${p}}`)}
                      className="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[11px] font-mono text-slate-600 hover:bg-slate-100"
                      title="Add to the message"
                    >
                      {`{${p}}`}
                    </button>
                  ))}
                </div>
              </div>
            </Card>
          )
        })}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        {updatedAt ? <p className="text-xs text-slate-500">Last saved {formatDateTime(updatedAt)}.</p> : <span />}
        <SaveButton saving={saving} onClick={() => save()} />
      </div>
    </>
  )
}

export default function FirebaseNotification() {
  return (
    <PageFrame
      icon={Bell}
      title="Firebase Notification"
      description="Write the push message sent for each order event, or switch it off. Leave a field blank to keep the system's own wording. Changes reach phones within about 30 seconds."
    >
      <PushMessagesEditor />
    </PageFrame>
  )
}
