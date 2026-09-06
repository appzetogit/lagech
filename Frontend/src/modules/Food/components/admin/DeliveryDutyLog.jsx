import { useEffect, useState } from "react"
import { Clock, Loader2, Radio, AlertTriangle } from "lucide-react"
import { adminAPI } from "@food/api"

/**
 * A rider's shift history: when they went online, when they went offline, and
 * how long each stretch lasted.
 *
 * The partner row only carries availabilityStatus, which is the current state
 * and is overwritten in place -- so until the duty log existed there was no way
 * to answer "when was this rider actually working".
 */

const fmtTime = (value) =>
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
    if (!hours) return `${mins}m`
    return `${hours}h ${mins}m`
}

export default function DeliveryDutyLog({ partnerId }) {
    const [sessions, setSessions] = useState([])
    const [summary, setSummary] = useState(null)
    const [loading, setLoading] = useState(true)
    const [failed, setFailed] = useState(false)

    useEffect(() => {
        if (!partnerId) return
        let cancelled = false

        const load = async () => {
            setLoading(true)
            setFailed(false)
            try {
                const res = await adminAPI.getDeliveryPartnerSessions(partnerId, { limit: 25 })
                const data = res?.data?.data ?? res?.data ?? {}
                if (cancelled) return
                setSessions(Array.isArray(data.sessions) ? data.sessions : [])
                setSummary(data.summary || null)
            } catch (error) {
                // Say so rather than showing an empty log, which would read as
                // "this rider has never been online".
                if (!cancelled) setFailed(true)
            } finally {
                if (!cancelled) setLoading(false)
            }
        }

        load()
        return () => {
            cancelled = true
        }
    }, [partnerId])

    return (
        <div className="pt-6 border-t border-slate-200">
            <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                    <Clock className="w-4 h-4 text-slate-500" />
                    Duty Log
                </h3>
                {summary && (
                    <span className="text-xs text-slate-600">
                        {summary.totalSessions} shift{summary.totalSessions === 1 ? "" : "s"} ·{" "}
                        {summary.totalHours}h {summary.remainderMinutes}m online
                    </span>
                )}
            </div>

            {loading ? (
                <div className="flex items-center justify-center py-6">
                    <Loader2 className="w-5 h-5 animate-spin text-slate-400" />
                </div>
            ) : failed ? (
                <p className="flex items-center gap-2 py-4 text-sm text-amber-700">
                    <AlertTriangle className="w-4 h-4" />
                    Could not load the duty log.
                </p>
            ) : sessions.length === 0 ? (
                <p className="py-4 text-sm text-slate-500">
                    This rider has not been online since shift tracking was switched on.
                </p>
            ) : (
                <div className="overflow-x-auto rounded-lg border border-slate-200">
                    <table className="w-full">
                        <thead className="bg-slate-50">
                            <tr>
                                <th className="px-4 py-2.5 text-left text-[10px] font-bold uppercase tracking-wider text-slate-600">
                                    Went online
                                </th>
                                <th className="px-4 py-2.5 text-left text-[10px] font-bold uppercase tracking-wider text-slate-600">
                                    Went offline
                                </th>
                                <th className="px-4 py-2.5 text-right text-[10px] font-bold uppercase tracking-wider text-slate-600">
                                    Duration
                                </th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                            {sessions.map((session) => (
                                <tr key={session.id} className="text-sm">
                                    <td className="px-4 py-2.5 text-slate-900 whitespace-nowrap">
                                        {fmtTime(session.wentOnlineAt)}
                                    </td>
                                    <td className="px-4 py-2.5 whitespace-nowrap">
                                        {session.isOpen ? (
                                            <span className="inline-flex items-center gap-1.5 text-emerald-700 font-medium">
                                                <Radio className="w-3.5 h-3.5" />
                                                Still online
                                            </span>
                                        ) : (
                                            <span className="text-slate-700">{fmtTime(session.wentOfflineAt)}</span>
                                        )}
                                    </td>
                                    <td className="px-4 py-2.5 text-right whitespace-nowrap">
                                        <span className="text-slate-900">{fmtDuration(session.durationMinutes)}</span>
                                        {session.closedBySystem && (
                                            // The rider never went offline -- app killed, phone died.
                                            // Marked so these are not read as real worked hours.
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
    )
}
