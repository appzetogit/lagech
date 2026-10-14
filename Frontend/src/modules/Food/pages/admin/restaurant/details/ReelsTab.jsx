import { useCallback, useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { toast } from "sonner"
import { Plus } from "@food/components/admin/theme/icons"
import { adminAPI } from "@food/api"
import { EmptyState, ErrorState, Panel, Pill, Spinner, TableBox, Toggle, errorMessage, formatDate, mediaUrl, payload, td, th } from "./shared"

/** This restaurant's reels, from the admin reels list, with the on/off switch. */

const STATE_TONE = { showing: "green", scheduled: "blue", expired: "red", off: "slate" }

function ActiveToggle({ reel, onChanged }) {
  const [saving, setSaving] = useState(false)
  const toggle = async (next) => {
    setSaving(true)
    try {
      await adminAPI.updateReel(reel.id, { isActive: next })
      onChanged()
    } catch (err) {
      toast.error(errorMessage(err, "Could not update the reel"))
    } finally {
      setSaving(false)
    }
  }
  return <Toggle checked={reel.isActive} disabled={saving} onChange={toggle} label="Active" />
}

export default function ReelsTab({ restaurantId }) {
  const [state, setState] = useState({ loading: true, error: "", reels: [] })

  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: "" }))
    try {
      const all = payload(await adminAPI.getReels()).reels || []
      setState({ loading: false, error: "", reels: all.filter((r) => String(r.restaurantId) === String(restaurantId)) })
    } catch (err) {
      setState((s) => ({ ...s, loading: false, error: errorMessage(err, "Could not load reels") }))
    }
  }, [restaurantId])

  useEffect(() => {
    load()
  }, [load])

  return (
    <Panel
      title={`Reels${state.loading ? "" : ` (${state.reels.length})`}`}
      bodyClassName=""
      actions={
        <Link to="/admin/food/reels/new" className="inline-flex items-center gap-1 rounded-lg bg-teal-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-teal-800">
          <Plus className="w-4 h-4" /> Add reel
        </Link>
      }
    >
      {state.loading ? (
        <Spinner />
      ) : state.error ? (
        <ErrorState message={state.error} onRetry={load} />
      ) : state.reels.length === 0 ? (
        <EmptyState title="No reels">This restaurant has no reels yet.</EmptyState>
      ) : (
        <TableBox>
          <thead>
            <tr>
              <th className={th}>SL</th>
              <th className={th}>Reel</th>
              <th className={th}>Shown</th>
              <th className={th}>Views</th>
              <th className={th}>Likes</th>
              <th className={th}>Store visits</th>
              <th className={th}>Status</th>
              <th className={th}>Active</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {state.reels.map((reel, index) => {
              const thumb = mediaUrl(reel.thumbnail)
              return (
                <tr key={reel.id} className="hover:bg-slate-50">
                  <td className={td}>{index + 1}</td>
                  <td className={td}>
                    <div className="flex items-center gap-3">
                      <a href={mediaUrl(reel.videoUrl)} target="_blank" rel="noreferrer" className="h-14 w-10 shrink-0 overflow-hidden rounded-lg bg-slate-900">
                        {thumb && <img src={thumb} alt="" className="h-full w-full object-cover" />}
                      </a>
                      <p className="max-w-xs break-words text-xs text-slate-700">{reel.description || "No description"}</p>
                    </div>
                  </td>
                  <td className={`${td} whitespace-nowrap text-xs`}>
                    {reel.alwaysVisible ? "Always" : `${formatDate(reel.startDate)} – ${formatDate(reel.endDate)}`}
                  </td>
                  <td className={td}>{reel.views || 0}</td>
                  <td className={td}>{reel.likes || 0}</td>
                  <td className={td}>{reel.restaurantVisits || 0}</td>
                  <td className={td}><Pill tone={STATE_TONE[reel.state] || "slate"}>{reel.state}</Pill></td>
                  <td className={td}><ActiveToggle reel={reel} onChanged={load} /></td>
                </tr>
              )
            })}
          </tbody>
        </TableBox>
      )}
    </Panel>
  )
}
