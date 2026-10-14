import { Copy } from "@food/components/admin/theme/icons"
import { toast } from "sonner"
import { formatDateTime as formatDateTimeIST } from "@food/utils/dateTime"

/**
 * Pieces shared by the Restaurant Disbursement list and details pages (the old
 * panel's "Store Disbursement").
 */

export const formatCurrency = (amount) =>
  `₹${Number(amount || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/** "14 Oct 2026, 03:05 AM", India time -- the panel's shared formatter. */
export const formatDateTime = (d) => formatDateTimeIST(d, "—")

export const BATCH_STATUS = {
  pending: { label: "Pending", className: "bg-amber-100 text-amber-700" },
  partially_completed: { label: "Partially completed", className: "bg-blue-100 text-blue-700" },
  completed: { label: "Completed", className: "bg-green-100 text-green-700" },
  canceled: { label: "Canceled", className: "bg-slate-200 text-slate-700" },
}

/** A line's status, in the old panel's words. */
export const LINE_STATUS = {
  pending: { label: "Pending", className: "bg-amber-100 text-amber-700" },
  approved: { label: "Completed", className: "bg-green-100 text-green-700" },
  rejected: { label: "Canceled", className: "bg-slate-200 text-slate-700" },
}

export function StatusBadge({ map, status }) {
  const badge = map[status] || map.pending
  return <span className={`inline-block px-2 py-0.5 rounded text-xs font-semibold whitespace-nowrap ${badge.className}`}>{badge.label}</span>
}

const copy = (text) => {
  if (!text) return
  navigator.clipboard?.writeText(String(text)).then(
    () => toast.success("Copied"),
    () => toast.error("Could not copy"),
  )
}

/** Where a line is paid, as label/value pairs: the snapshot taken when the run made it. */
export function payToRows(line) {
  const d = line?.bankDetails || {}
  const method = d.payoutMethod
  const rows = []
  if (line?.paymentMethod === "upi") {
    if (d.upiId) rows.push(["UPI ID", d.upiId])
    if (d.name) rows.push(["Name", d.name])
  } else if (line?.paymentMethod === "bank_transfer") {
    if (d.accountHolderName) rows.push(["Name", d.accountHolderName])
    if (d.accountNumber) rows.push(["A/c", d.accountNumber])
    if (d.ifscCode) rows.push(["IFSC", d.ifscCode])
  }
  // The payout method the restaurant chose (or the old system's), field by field.
  for (const field of method?.fields || []) {
    if (field?.value && !rows.some(([, value]) => value === field.value)) rows.push([field.label || field.key, field.value])
  }
  return rows
}

export const methodLabel = (line) => {
  const name = line?.bankDetails?.payoutMethod?.methodName
  if (line?.paymentMethod === "upi") return name ? `UPI (${name})` : "UPI"
  if (line?.paymentMethod === "bank_transfer") return name ? `Bank transfer (${name})` : "Bank transfer"
  return name || String(line?.paymentMethod || "—").replace(/_/g, " ")
}

/** One line of text for exports: "UPI · UPI ID: a@upi". */
export const payToText = (line) =>
  [methodLabel(line), ...payToRows(line).map(([label, value]) => `${label}: ${value}`)].join(" · ")

export function PayTo({ line }) {
  return (
    <div className="min-w-0">
      <span className="text-xs font-semibold text-slate-700">{methodLabel(line)}</span>
      {payToRows(line).map(([label, value]) => (
        <div key={`${label}-${value}`} className="flex items-center gap-1 text-xs text-slate-600 min-w-0">
          <span className="text-slate-400 shrink-0">{label}</span>
          <span className="font-mono text-slate-800 break-all">{value}</span>
          <button type="button" onClick={() => copy(value)} className="text-slate-400 hover:text-slate-700 shrink-0" aria-label={`Copy ${label}`}>
            <Copy className="w-3 h-3" />
          </button>
        </div>
      ))}
    </div>
  )
}

/** The cards above a list: total and each status, count and amount. */
export function TotalsStrip({ total, totals, totalLabel = "Total" }) {
  const cards = [
    [totalLabel, total?.amount, total?.count, "text-slate-900"],
    ["Pending", totals?.pending?.amount, totals?.pending?.count, "text-amber-700"],
    ["Completed", totals?.completed?.amount, totals?.completed?.count, "text-green-700"],
    ["Canceled", totals?.canceled?.amount, totals?.canceled?.count, "text-slate-600"],
  ]
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      {cards.map(([label, amount, count, tone]) => (
        <div key={label} className="rounded-lg bg-slate-50 border border-slate-200 p-3 min-w-0">
          <p className="text-xs text-slate-500">{label}{Number.isFinite(Number(count)) ? ` · ${count}` : ""}</p>
          <p className={`text-base sm:text-lg font-bold truncate ${tone}`}>{formatCurrency(amount)}</p>
        </div>
      ))}
    </div>
  )
}
