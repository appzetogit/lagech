import { useState, useEffect, useCallback, useMemo } from "react"
import { Clock, Loader2, Radio, AlertTriangle, Search } from "lucide-react"
import { adminAPI } from "@food/api"

/**
 * When each rider went online and offline, on a screen of its own.
 *
 * The same data also appears inside the delivery partner dialog, but finding it
 * there means knowing which rider you want first. This is the other way round:
 * pick a rider, pick a range, read the shifts.
 */

const fmt = (value) =>
  value
    ? new Date(value).toLocaleString(undefined, {
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—"

const fmtDuration = (minutes) => {
  const total = Math.max(0, Number(minutes) || 0)
  const hours = Math.floor(total / 60)
  const mins = total % 60
  return hours ? `${hours}h ${mins}m` : `${mins}m`
}

const iso = (date) => date.toISOString().slice(0, 10)

/** Last 30 days, which is the range a duty question is usually about. */
const defaultRange = () => {
  const to = new Date()
  const from = new Date()
  from.setDate(from.getDate() - 30)
  return { from: iso(from), to: iso(to) }
}

export default function DutyLog() {
  const [partners, setPartners] = useState([])
  const [partnersLoading, setPartnersLoading] = useState(true)
  const [partnerId, setPartnerId] = useState("")
  const [range, setRange] = useState(defaultRange)
  const [search, setSearch] = useState("")

  const [sessions, setSessions] = useState([])
  const [summary, setSummary] = useState(null)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    const load = async () => {
      try {
        const res = await adminAPI.getDeliveryPartners({ limit: 500, page: 1 })
        const payload = res?.data?.data ?? {}
        const rows = payload.deliveryPartners || payload.items || payload.data || []
        const list = Array.isArray(rows) ? rows : []
        setPartners(list)
        // Preselect, so the page shows something rather than an empty prompt.
        if (list.length) setPartnerId(String(list[0].id || list[0]._id))
      } catch (error) {
        setPartners([])
      } finally {
        setPartnersLoading(false)
      }
    }
    load()
  }, [])

  const load = useCallback(async () => {
    if (!partnerId) return
    setLoading(true)
    setFailed(false)
    try {
      // End pushed to the last moment of the day, or the final day's shifts
      // fall outside the range.
      const res = await adminAPI.getDeliveryPartnerSessions(partnerId, {
        from: `${range.from}T00:00:00.000Z`,
        to: `${range.to}T23:59:59.999Z`,
        limit: 200,
      })
      const data = res?.data?.data ?? {}
      setSessions(Array.isArray(data.sessions) ? data.sessions : [])
      setSummary(data.summary || null)
    } catch (error) {
      // Say so rather than showing an empty log, which reads as "never online".
      setFailed(true)
      setSessions([])
      setSummary(null)
    } finally {
      setLoading(false)
    }
  }, [partnerId, range])

  useEffect(() => {
    load()
  }, [load])

  const visiblePartners = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) return partners
    return partners.filter(
      (p) =>
        String(p.name || "").toLowerCase().includes(query) ||
        String(p.phone || "").toLowerCase().includes(query),
    )
  }, [partners, search])

  const selected = partners.find((p) => String(p.id || p._id) === String(partnerId))

  return (
    <div className="p-4 lg:p-6 bg-slate-50 min-h-screen">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
          <div className="flex items-center gap-3 mb-2">
            <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-teal-500 to-teal-700 flex items-center justify-center">
              <Clock className="w-5 h-5 text-white" />
            </div>
            <h1 className="text-2xl font-bold text-slate-900">Duty Log</h1>
          </div>
          <p className="text-sm text-slate-600">
            When each delivery partner went online and offline, and how long they were on
            shift.
          </p>

          <div className="mt-5 pt-5 border-t border-slate-200 flex flex-wrap items-end gap-3">
            <div>
              <label className="block text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1">
                Delivery Partner
              </label>
              <select
                value={partnerId}
                disabled={partnersLoading}
                onChange={(e) => setPartnerId(e.target.value)}
                className="text-sm rounded-lg border border-slate-300 px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-slate-400 disabled:opacity-60 min-w-[240px]"
              >
                {partnersLoading && <option>Loading…</option>}
                {!partnersLoading && visiblePartners.length === 0 && (
                  <option value="">No delivery partners</option>
                )}
                {visiblePartners.map((p) => (
                  <option key={p.id || p._id} value={p.id || p._id}>
                    {p.name || "Unnamed"} · {p.phone || "no phone"}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1">
                From
              </label>
              <input
                type="date"
                value={range.from}
                onChange={(e) => setRange({ ...range, from: e.target.value })}
                className="text-sm rounded-lg border border-slate-300 px-3 py-2 bg-white"
              />
            </div>
            <div>
              <label className="block text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1">
                To
              </label>
              <input
                type="date"
                value={range.to}
                onChange={(e) => setRange({ ...range, to: e.target.value })}
                className="text-sm rounded-lg border border-slate-300 px-3 py-2 bg-white"
              />
            </div>

            <div className="relative">
              <label className="block text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1">
                Filter the list
              </label>
              <input
                type="text"
                placeholder="Name or phone"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-9 pr-3 py-2 text-sm rounded-lg border border-slate-300 bg-white focus:outline-none focus:ring-2 focus:ring-slate-400"
              />
              <Search className="absolute left-3 bottom-2.5 w-4 h-4 text-slate-400" />
            </div>
          </div>
        </div>

        {summary && (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <Stat label="Shifts in range" value={summary.totalSessions ?? 0} />
            <Stat
              label="Time online"
              value={`${summary.totalHours ?? 0}h ${summary.remainderMinutes ?? 0}m`}
              emphasis
            />
            <Stat label="Last went online" value={fmt(summary.lastOnlineAt)} />
            <Stat
              label="Last went offline"
              value={summary.isCurrentlyOnline ? "Still online" : fmt(summary.lastOfflineAt)}
              highlight={summary.isCurrentlyOnline}
            />
          </div>
        )}

        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
          {selected && (
            <h2 className="text-lg font-bold text-slate-900 mb-4">
              {selected.name || "Delivery Partner"}{" "}
              <span className="text-sm font-normal text-slate-500">{selected.phone}</span>
            </h2>
          )}

          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-8 h-8 animate-spin text-teal-600" />
            </div>
          ) : failed ? (
            <p className="flex items-center gap-2 py-8 text-sm text-amber-700">
              <AlertTriangle className="w-4 h-4" />
              Could not load the duty log.
            </p>
          ) : !partnerId ? (
            <p className="py-8 text-center text-sm text-slate-500">
              Choose a delivery partner to see their shifts.
            </p>
          ) : sessions.length === 0 ? (
            <p className="py-8 text-center text-sm text-slate-500">
              No shifts in this range. Shift tracking records from the day a rider first
              goes online; there is no history from before it was switched on.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-slate-200">
              <table className="w-full">
                <thead className="bg-slate-50">
                  <tr>
                    <Th>Went online</Th>
                    <Th>Went offline</Th>
                    <Th align="right">Duration</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {sessions.map((session) => (
                    <tr key={session.id} className="text-sm hover:bg-slate-50">
                      <td className="px-4 py-3 text-slate-900 whitespace-nowrap">
                        {fmt(session.wentOnlineAt)}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        {session.isOpen ? (
                          <span className="inline-flex items-center gap-1.5 text-emerald-700 font-medium">
                            <Radio className="w-3.5 h-3.5" />
                            Still online
                          </span>
                        ) : (
                          <span className="text-slate-700">{fmt(session.wentOfflineAt)}</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right whitespace-nowrap">
                        <span className="text-slate-900">
                          {fmtDuration(session.durationMinutes)}
                        </span>
                        {session.closedBySystem && (
                          // The rider never went offline -- app killed, phone died.
                          // Flagged so these are not read as real worked hours.
                          <span
                            title="The app stopped without going offline; this shift was closed automatically."
                            className="ml-2 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-50 text-amber-700 border border-amber-200"
                          >
                            auto
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

const ALIGN = { left: "text-left", right: "text-right", center: "text-center" }

const Th = ({ children, align = "left" }) => (
  <th
    className={`px-4 py-3 ${ALIGN[align]} text-[10px] font-bold uppercase tracking-wider text-slate-600`}
  >
    {children}
  </th>
)

const Stat = ({ label, value, emphasis = false, highlight = false }) => (
  <div
    className={`rounded-xl border p-4 ${
      highlight
        ? "border-emerald-200 bg-emerald-50"
        : emphasis
          ? "border-teal-200 bg-teal-50"
          : "border-slate-200 bg-white"
    }`}
  >
    <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</p>
    <p
      className={`mt-1 text-lg font-bold ${
        highlight ? "text-emerald-700" : emphasis ? "text-teal-800" : "text-slate-900"
      }`}
    >
      {value}
    </p>
  </div>
)
