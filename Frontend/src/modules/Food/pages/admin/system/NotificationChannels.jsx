import { BellRing } from "lucide-react"
import { PageFrame, Card, Switch, SaveButton, Loading, setIn, formatDateTime, useSettingsArea } from "./SettingsUi"

const CHANNELS = [
  ["push", "Push"],
  ["sms", "SMS"],
  ["email", "Email"],
]

/**
 * Which channels each notification goes out on. Push switches take effect
 * straight away (within half a minute). The system does not send SMS or email
 * for these events yet, so those switches are saved for later.
 */
export default function NotificationChannels() {
  const { value, setValue, catalog, updatedAt, loading, saving, save } = useSettingsArea("notification_channels")
  const events = catalog.events || []
  const wired = catalog.wired || { push: true }

  return (
    <PageFrame
      icon={BellRing}
      title="Notification Channels"
      description="Choose which notifications are sent, and how. Switching push off stops that notification reaching phones within about 30 seconds. New-order offers to riders are always sent."
      actions={<SaveButton saving={saving} onClick={() => save()} disabled={loading} />}
    >
      {loading || !value ? (
        <Card><Loading /></Card>
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-slate-700">Notification</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-slate-700">Goes to</th>
                  {CHANNELS.map(([key, label]) => (
                    <th key={key} className="px-4 py-3 text-center text-xs font-semibold text-slate-700">
                      {label}
                      {!wired[key] && <span className="block text-[10px] font-normal text-slate-400">saved for later</span>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {events.map((event) => (
                  <tr key={event.key} className="hover:bg-slate-50">
                    <td className="px-4 py-3 text-sm font-medium text-slate-900">{event.label}</td>
                    <td className="px-4 py-3 text-xs text-slate-500">{event.audience}</td>
                    {CHANNELS.map(([channel, label]) => (
                      <td key={channel} className="px-4 py-3 text-center">
                        <div className="inline-flex">
                          <Switch
                            checked={Boolean(value?.events?.[event.key]?.[channel])}
                            onChange={(v) => setValue((cur) => setIn(cur, ["events", event.key, channel], v))}
                            label={`${event.label} by ${label}`}
                          />
                        </div>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-4 text-xs text-slate-500">
            The system does not send SMS or email for these notifications yet; those switches are kept for when it does.
            {updatedAt ? ` Last saved ${formatDateTime(updatedAt)}.` : ""}
          </p>
        </Card>
      )}
    </PageFrame>
  )
}
