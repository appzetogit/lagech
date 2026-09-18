import { useEffect, useState } from "react"
import { Loader2, X } from "lucide-react"
import { adminAPI } from "@food/api"

const OTHER = "__other__"

/**
 * Cancelling or rejecting an order from the admin panel: pick one of the admin
 * cancel reasons, or type one. Replaces the browser prompt, which offered an
 * empty box and so collected a different sentence for the same cause each time.
 */
export default function CancelOrderDialog({ order, mode = "cancel", onClose, onConfirm }) {
  const [reasons, setReasons] = useState([])
  const [choice, setChoice] = useState("")
  const [other, setOther] = useState("")
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    adminAPI
      .getCancelReasons({ userType: "admin" })
      .then((res) => {
        const active = (res?.data?.data?.reasons || []).filter((r) => r.isActive)
        setReasons(active)
        setChoice(active[0]?.reason || OTHER)
      })
      .catch(() => setChoice(OTHER))
      .finally(() => setLoading(false))
  }, [])

  const reason = choice === OTHER ? other.trim() : choice
  const verb = mode === "reject" ? "Reject" : "Cancel"

  const submit = async (e) => {
    e.preventDefault()
    if (!reason) return
    setSaving(true)
    try {
      await onConfirm(reason)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
      <form onSubmit={submit} className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl space-y-4">
        <div className="flex items-start justify-between">
          <div>
            <h3 className="text-lg font-bold text-slate-900">{verb} order {order?.orderId}</h3>
            <p className="text-sm text-slate-600">The customer is told the reason you choose.</p>
          </div>
          <button type="button" onClick={onClose} className="p-1 text-slate-500 hover:text-slate-800" aria-label="Close">
            <X className="w-5 h-5" />
          </button>
        </div>
        {loading ? (
          <Loader2 className="w-5 h-5 animate-spin text-slate-400" />
        ) : (
          <div className="space-y-2">
            {reasons.map((r) => (
              <label key={r.id} className="flex items-center gap-2 text-sm text-slate-800 cursor-pointer">
                <input type="radio" name="reason" checked={choice === r.reason} onChange={() => setChoice(r.reason)} />
                {r.reason}
              </label>
            ))}
            <label className="flex items-center gap-2 text-sm text-slate-800 cursor-pointer">
              <input type="radio" name="reason" checked={choice === OTHER} onChange={() => setChoice(OTHER)} />
              Other
            </label>
            {choice === OTHER && (
              <input
                autoFocus
                value={other}
                maxLength={200}
                onChange={(e) => setOther(e.target.value)}
                placeholder="Type the reason"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
              />
            )}
          </div>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">
            Back
          </button>
          <button
            type="submit"
            disabled={!reason || saving}
            className="inline-flex items-center gap-2 rounded-lg bg-rose-600 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-700 disabled:opacity-60"
          >
            {saving && <Loader2 className="w-4 h-4 animate-spin" />}
            {verb} order
          </button>
        </div>
      </form>
    </div>
  )
}
