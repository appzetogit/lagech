import { useEffect, useState } from "react"
import { useNavigate } from "react-router-dom"
import { ArrowLeft, Bell, Mail, MessageSquare, Smartphone } from "lucide-react"
import { toast } from "sonner"
import { restaurantAPI } from "@food/api"
import { formatDateTime } from "@food/utils/dateTime"

/**
 * The old store panel's "Notification Setup": for each event, whether this
 * restaurant gets it by mail, SMS and push. A dash means that channel is not
 * offered for the event. Switches the system does not send on yet are kept for
 * when it does, and say so.
 */

const CHANNELS = [
  { key: "mail", label: "Mail", icon: Mail },
  { key: "sms", label: "SMS", icon: MessageSquare },
  { key: "push", label: "Push", icon: Smartphone },
]

function Toggle({ state, busy, onChange, label }) {
  if (!state?.offered) return <span className="text-sm text-[#9aa7b6]" aria-label={`${label}: not available`}>—</span>
  const on = state.status === "active"
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={busy}
      onClick={() => onChange(!on)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${on ? "bg-[#4f6f9a]" : "bg-[#c8d0da]"} ${busy ? "opacity-60" : ""}`}
    >
      <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${on ? "translate-x-5" : "translate-x-0.5"}`} />
    </button>
  )
}

const notSentYet = (event) => CHANNELS.some((c) => event[c.key]?.offered && !event[c.key]?.wired)

export default function NotificationSetup() {
  const navigate = useNavigate()
  const [events, setEvents] = useState([])
  const [updatedAt, setUpdatedAt] = useState(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState("")

  useEffect(() => {
    let alive = true
    restaurantAPI
      .getNotificationSettings()
      .then((res) => {
        if (!alive) return
        setEvents(res?.data?.data?.events || [])
        setUpdatedAt(res?.data?.data?.updatedAt || null)
      })
      .catch((err) => {
        if (alive && err?.response?.status !== 401) toast.error(err?.response?.data?.message || "Could not load notification settings")
      })
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [])

  const change = async (event, channel, on) => {
    const id = `${event.key}:${channel}`
    const status = on ? "active" : "inactive"
    const previous = events
    // Show the change at once; put it back if the save fails.
    setEvents((list) => list.map((e) => (e.key === event.key ? { ...e, [channel]: { ...e[channel], status } } : e)))
    try {
      setBusy(id)
      const res = await restaurantAPI.updateNotificationSetting({ key: event.key, channel, status })
      setEvents(res?.data?.data?.events || previous)
      setUpdatedAt(res?.data?.data?.updatedAt || null)
      toast.success(`${event.label}: ${channel === "sms" ? "SMS" : channel} ${on ? "on" : "off"}`)
    } catch (err) {
      setEvents(previous)
      toast.error(err?.response?.data?.message || "Could not save")
    } finally {
      setBusy("")
    }
  }

  return (
    <div className="min-h-screen bg-[#e9edf2] flex flex-col md:h-full md:overflow-hidden">
      <div className="sticky top-0 z-40 px-4 py-3 border-b border-[#d5dbe3] bg-[#f2f4f7]/95 backdrop-blur md:static md:px-8 md:pt-7 md:pb-5">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => navigate(-1)}
            className="p-1.5 hover:bg-white/80 rounded-xl transition-colors"
            aria-label="Go back"
          >
            <ArrowLeft className="w-6 h-6 text-[#141820]" />
          </button>
          <div className="flex-1 min-w-0">
            <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#5c6775]">Settings</p>
            <h1 className="text-lg md:text-3xl font-black tracking-tight text-[#141820]">Notification setup</h1>
            <p className="hidden md:block mt-1 text-sm text-[#5c6775]">Choose how you are told about orders, payouts, approvals and your account</p>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 pt-4 pb-28 md:px-8 md:pb-8 md:min-h-0">
        {loading ? (
          <div className="py-16 text-center text-sm text-[#5c6775]">Loading notification settings...</div>
        ) : events.length === 0 ? (
          <div className="flex flex-col items-center justify-center text-center px-6 py-16">
            <Bell className="w-8 h-8 text-[#5c6775] mb-3" />
            <p className="text-base font-bold text-[#141820]">Nothing to set up</p>
          </div>
        ) : (
          <>
            <div className="space-y-3 md:hidden">
              {events.map((event) => (
                <div key={event.key} className="rounded-2xl border border-[#d6dce4] bg-white p-4">
                  <p className="text-sm font-bold text-[#141820]">{event.label}</p>
                  <p className="mt-0.5 text-xs text-[#5c6775]">{event.description}</p>
                  <div className="mt-3 grid grid-cols-3 gap-2">
                    {CHANNELS.map(({ key, label, icon: Icon }) => (
                      <div key={key} className="flex flex-col items-center gap-1.5 rounded-xl bg-[#f5f7fa] py-2">
                        <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#5c6775]">
                          <Icon className="w-3.5 h-3.5" /> {label}
                        </span>
                        <Toggle
                          state={event[key]}
                          busy={busy === `${event.key}:${key}`}
                          onChange={(on) => change(event, key, on)}
                          label={`${event.label} by ${label}`}
                        />
                      </div>
                    ))}
                  </div>
                  {notSentYet(event) && <p className="mt-2 text-[11px] text-[#8b98a8]">Saved for later: this is not sent yet.</p>}
                </div>
              ))}
            </div>

            <div className="hidden md:block overflow-hidden rounded-2xl border border-[#d6dce4] bg-white">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-[#f5f7fa] text-left text-[11px] uppercase tracking-wider text-[#5c6775]">
                    <th className="px-4 py-3 font-bold">Topic</th>
                    {CHANNELS.map((c) => (
                      <th key={c.key} className="px-4 py-3 font-bold text-center w-28">{c.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {events.map((event) => (
                    <tr key={event.key} className="border-t border-[#eef1f5]">
                      <td className="px-4 py-4">
                        <p className="font-semibold text-[#141820]">{event.label}</p>
                        <p className="text-xs text-[#5c6775]">{event.description}</p>
                        {notSentYet(event) && <p className="text-[11px] text-[#8b98a8]">Saved for later: this is not sent yet.</p>}
                      </td>
                      {CHANNELS.map(({ key, label }) => (
                        <td key={key} className="px-4 py-4 text-center">
                          <Toggle
                            state={event[key]}
                            busy={busy === `${event.key}:${key}`}
                            onChange={(on) => change(event, key, on)}
                            label={`${event.label} by ${label}`}
                          />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {updatedAt && <p className="mt-3 text-xs text-[#5c6775]">Last changed {formatDateTime(updatedAt, "")}</p>}
          </>
        )}
      </div>
    </div>
  )
}
