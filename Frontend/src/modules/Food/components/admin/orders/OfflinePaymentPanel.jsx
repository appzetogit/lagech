import { useState } from "react"
import { toast } from "sonner"
import { CreditCard, CheckCircle2, XCircle, Loader2 } from "@food/components/admin/theme/icons"
import { adminAPI } from "@/services/api"

const STATUS = {
  pending: { label: "Waiting for verification", className: "bg-amber-100 text-amber-700" },
  verified: { label: "Verified", className: "bg-emerald-100 text-emerald-700" },
  rejected: { label: "Rejected", className: "bg-red-100 text-red-700" },
}

/**
 * An offline payment on an order: where the customer was told to pay, what
 * they entered, and -- while it waits -- Verify (the order goes to the
 * restaurant as paid) or Reject (payment failed, order cancelled, the customer
 * is told the reason).
 */
export default function OfflinePaymentPanel({ orderId, offlinePayment, awaiting, onChanged }) {
  const [busy, setBusy] = useState(null)
  const [note, setNote] = useState("")
  const [rejecting, setRejecting] = useState(false)
  if (!offlinePayment) return null
  const status = STATUS[offlinePayment.status] || STATUS.pending
  const canDecide = awaiting && offlinePayment.status === "pending"

  const decide = async (action) => {
    if (action === "reject" && !note.trim()) {
      toast.error("Write the reason; the customer is told")
      return
    }
    if (action === "verify" && !window.confirm("Mark this payment as received? The order goes to the restaurant.")) return
    try {
      setBusy(action)
      if (action === "verify") await adminAPI.verifyOfflinePayment(orderId, note.trim())
      else await adminAPI.rejectOfflinePayment(orderId, note.trim())
      toast.success(action === "verify" ? "Payment verified" : "Payment rejected")
      setNote("")
      setRejecting(false)
      onChanged?.()
    } catch {
      // The API client already shows the server's message.
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="border border-slate-200 rounded-lg p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold text-slate-900 flex items-center gap-2">
          <CreditCard className="w-4 h-4" /> Offline payment: {offlinePayment.methodName}
        </p>
        <span className={`inline-flex px-3 py-1 rounded-full text-xs font-medium ${status.className}`}>{status.label}</span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
        <div>
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Customer entered</p>
          {(offlinePayment.fields || []).map((field) => (
            <p key={field.key} className="text-slate-900">
              <span className="text-slate-500">{field.label}:</span> <span className="font-medium break-all">{field.value}</span>
            </p>
          ))}
          {offlinePayment.customerNote && (
            <p className="text-slate-700 mt-1"><span className="text-slate-500">Note:</span> {offlinePayment.customerNote}</p>
          )}
        </div>
        <div>
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Paid to</p>
          {(offlinePayment.paymentInfo || []).map((row) => (
            <p key={row.label} className="text-slate-700">
              <span className="text-slate-500">{row.label}:</span> {row.value}
            </p>
          ))}
        </div>
      </div>

      {offlinePayment.status !== "pending" && offlinePayment.adminNote && (
        <p className="text-xs text-slate-600">Admin note: {offlinePayment.adminNote}</p>
      )}

      {canDecide && (
        <div className="space-y-2 pt-2 border-t border-slate-100">
          <textarea
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            rows={2}
            maxLength={300}
            placeholder={rejecting ? "Why is the payment rejected? The customer sees this." : "Note (optional)"}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="flex flex-wrap gap-2 justify-end">
            {rejecting ? (
              <>
                <button type="button" onClick={() => setRejecting(false)} className="rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-700">Back</button>
                <button type="button" disabled={Boolean(busy)} onClick={() => decide("reject")} className="inline-flex items-center gap-1 rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60">
                  {busy === "reject" ? <Loader2 className="w-4 h-4 animate-spin" /> : <XCircle className="w-4 h-4" />} Reject payment
                </button>
              </>
            ) : (
              <>
                <button type="button" onClick={() => setRejecting(true)} className="inline-flex items-center gap-1 rounded-lg border border-red-200 px-4 py-2 text-sm font-medium text-red-600">
                  <XCircle className="w-4 h-4" /> Reject
                </button>
                <button type="button" disabled={Boolean(busy)} onClick={() => decide("verify")} className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60">
                  {busy === "verify" ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />} Verify payment
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
