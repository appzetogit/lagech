import { useEffect, useMemo, useState } from "react"
import { Link, useParams } from "react-router-dom"
import { ArrowLeft, CheckCircle2, Copy, Loader2, Search, XCircle } from "lucide-react"
import { toast } from "sonner"
import { adminAPI } from "@food/api"
import { BATCH_STATUS } from "./RestaurantPayouts"

const formatCurrency = (amount) =>
  `₹${Number(amount || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const LINE_STATUS = {
  pending: { label: "Pending", className: "bg-amber-100 text-amber-700" },
  approved: { label: "Paid", className: "bg-green-100 text-green-700" },
  rejected: { label: "Canceled", className: "bg-slate-200 text-slate-700" },
}

const copy = (text) => {
  if (!text) return
  navigator.clipboard?.writeText(String(text)).then(
    () => toast.success("Copied"),
    () => toast.error("Could not copy"),
  )
}

/** The account a line is paid to, snapshotted when the batch was made. */
function PayTo({ line }) {
  const d = line.bankDetails || {}
  const Row = ({ label, value }) =>
    value ? (
      <div className="flex items-center gap-1 text-xs text-slate-600">
        <span className="text-slate-400">{label}</span>
        <span className="font-mono text-slate-800">{value}</span>
        <button type="button" onClick={() => copy(value)} className="text-slate-400 hover:text-slate-700" aria-label={`Copy ${label}`}>
          <Copy className="w-3 h-3" />
        </button>
      </div>
    ) : null
  if (line.paymentMethod === "upi") {
    return (
      <div>
        <span className="text-xs font-semibold text-slate-700">UPI</span>
        <Row label="ID" value={d.upiId} />
      </div>
    )
  }
  return (
    <div>
      <span className="text-xs font-semibold text-slate-700">Bank transfer</span>
      <Row label="Name" value={d.accountHolderName} />
      <Row label="A/c" value={d.accountNumber} />
      <Row label="IFSC" value={d.ifscCode} />
    </div>
  )
}

export default function RestaurantPayoutBatch() {
  const { batchId } = useParams()
  const [batch, setBatch] = useState(null)
  const [payouts, setPayouts] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState("")
  const [selected, setSelected] = useState(new Set())
  const [deciding, setDeciding] = useState(null)
  const [reference, setReference] = useState("")
  const [saving, setSaving] = useState(false)

  const load = async () => {
    try {
      setLoading(true)
      const res = await adminAPI.getRestaurantPayoutBatch(batchId)
      setBatch(res?.data?.data?.batch || null)
      setPayouts(res?.data?.data?.payouts || [])
      setSelected(new Set())
    } catch (err) {
      toast.error(err?.response?.data?.message || "Failed to load the payout")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [batchId])

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    return q ? payouts.filter((p) => p.restaurantName.toLowerCase().includes(q)) : payouts
  }, [payouts, search])

  const pendingVisible = visible.filter((p) => p.status === "pending")
  const allPendingSelected = pendingVisible.length > 0 && pendingVisible.every((p) => selected.has(p.id))

  const toggle = (id) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const selectedTotal = payouts.filter((p) => selected.has(p.id)).reduce((sum, p) => sum + p.amount, 0)

  const decide = async () => {
    try {
      setSaving(true)
      const res = await adminAPI.decideRestaurantPayouts(batchId, {
        ids: [...deciding.ids],
        status: deciding.status,
        transactionId: deciding.status === "approved" ? reference.trim() || undefined : undefined,
        adminNote: deciding.status === "rejected" ? reference.trim() || undefined : undefined,
      })
      const { updated, notPending } = res?.data?.data || {}
      toast.success(
        `${updated} payout(s) marked ${deciding.status === "approved" ? "paid" : "canceled"}` +
          (notPending ? `; ${notPending} were already decided` : ""),
      )
      setDeciding(null)
      setReference("")
      load()
    } catch (err) {
      toast.error(err?.response?.data?.message || "Failed to update payouts")
    } finally {
      setSaving(false)
    }
  }

  if (loading && !batch) {
    return (
      <div className="p-6 text-center">
        <Loader2 className="w-8 h-8 animate-spin text-emerald-600 mx-auto" />
      </div>
    )
  }
  if (!batch) return <div className="p-6 text-slate-600">Payout not found.</div>

  const badge = BATCH_STATUS[batch.status] || BATCH_STATUS.pending
  const paid = payouts.filter((p) => p.status === "approved").reduce((sum, p) => sum + p.amount, 0)

  return (
    <div className="p-4 lg:p-6 bg-slate-50 min-h-screen">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
          <Link to="/admin/food/restaurant-disbursements" className="inline-flex items-center gap-1 text-sm text-slate-600 hover:text-slate-900 mb-3">
            <ArrowLeft className="w-4 h-4" /> All payouts
          </Link>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-bold text-slate-900">{batch.title}</h1>
            <span className={`px-2 py-0.5 rounded text-xs font-semibold ${badge.className}`}>{badge.label}</span>
          </div>
          <p className="text-sm text-slate-600 mt-1">
            Earnings from orders placed before{" "}
            {new Date(batch.cutoffAt).toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}
          </p>
          <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-4">
            {[
              ["Restaurants", batch.restaurantCount],
              ["Total", formatCurrency(batch.totalAmount)],
              ["Paid", formatCurrency(paid)],
              ["Left to pay", formatCurrency(payouts.filter((p) => p.status === "pending").reduce((s, p) => s + p.amount, 0))],
            ].map(([label, value]) => (
              <div key={label} className="rounded-lg bg-slate-50 border border-slate-200 p-3">
                <p className="text-xs text-slate-500">{label}</p>
                <p className="text-lg font-bold text-slate-900">{value}</p>
              </div>
            ))}
          </div>
          {batch.skipped?.length > 0 && (
            <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3">
              <p className="text-sm font-semibold text-red-700">Not included — fix and they will be picked up by the next run</p>
              <ul className="mt-1 text-sm text-red-700 list-disc pl-5">
                {batch.skipped.map((s) => (
                  <li key={s.restaurantId}>
                    {s.name}: {formatCurrency(s.amount)} — {s.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
          <div className="flex flex-col sm:flex-row sm:items-center gap-3 mb-4">
            <div className="relative flex-1 max-w-xs">
              <input
                type="text"
                placeholder="Search restaurant"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-9 pr-3 py-2 w-full text-sm rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-slate-400"
              />
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            </div>
            {selected.size > 0 && (
              <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
                <span className="text-sm text-slate-600">
                  {selected.size} selected · {formatCurrency(selectedTotal)}
                </span>
                <button
                  type="button"
                  onClick={() => setDeciding({ ids: selected, status: "approved" })}
                  className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-700"
                >
                  <CheckCircle2 className="w-4 h-4" /> Mark paid
                </button>
                <button
                  type="button"
                  onClick={() => setDeciding({ ids: selected, status: "rejected" })}
                  className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
                >
                  <XCircle className="w-4 h-4" /> Cancel
                </button>
              </div>
            )}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr>
                  <th className="px-4 py-3 text-left">
                    <input
                      type="checkbox"
                      aria-label="Select all pending"
                      checked={allPendingSelected}
                      disabled={!pendingVisible.length}
                      onChange={() =>
                        setSelected(allPendingSelected ? new Set() : new Set(pendingVisible.map((p) => p.id)))
                      }
                    />
                  </th>
                  {["Restaurant", "Amount", "Pay to", "Status", "Reference"].map((h) => (
                    <th key={h} className="px-4 py-3 text-left text-[10px] font-bold text-slate-700 uppercase tracking-wider">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {visible.map((line) => {
                  const status = LINE_STATUS[line.status] || LINE_STATUS.pending
                  return (
                    <tr key={line.id} className="hover:bg-slate-50 align-top">
                      <td className="px-4 py-4">
                        <input
                          type="checkbox"
                          aria-label={`Select ${line.restaurantName}`}
                          checked={selected.has(line.id)}
                          disabled={line.status !== "pending"}
                          onChange={() => toggle(line.id)}
                        />
                      </td>
                      <td className="px-4 py-4 text-sm">
                        <p className="font-semibold text-slate-800">{line.restaurantName}</p>
                        <p className="text-xs text-slate-500">{[line.ownerName, line.ownerPhone].filter(Boolean).join(" · ")}</p>
                      </td>
                      <td className="px-4 py-4 text-sm font-semibold text-slate-900 whitespace-nowrap">{formatCurrency(line.amount)}</td>
                      <td className="px-4 py-4"><PayTo line={line} /></td>
                      <td className="px-4 py-4">
                        <span className={`px-2 py-0.5 rounded text-xs font-semibold ${status.className}`}>{status.label}</span>
                      </td>
                      <td className="px-4 py-4 text-xs text-slate-600 break-words max-w-[200px]">
                        {line.transactionId || line.adminNote || "—"}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {deciding && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
          <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl space-y-4">
            <h3 className="text-lg font-bold text-slate-900">
              {deciding.status === "approved" ? "Mark as paid" : "Cancel payouts"}
            </h3>
            <p className="text-sm text-slate-600">
              {deciding.ids.size} payout(s), {formatCurrency(payouts.filter((p) => deciding.ids.has(p.id)).reduce((s, p) => s + p.amount, 0))}.{" "}
              {deciding.status === "approved"
                ? "Only do this after the money has been sent."
                : "The amount goes back to each restaurant's balance and is included in the next run."}
            </p>
            <label className="block space-y-1">
              <span className="text-sm font-semibold text-slate-700">
                {deciding.status === "approved" ? "Transaction reference / UTR (optional)" : "Reason (optional)"}
              </span>
              <input
                type="text"
                value={reference}
                maxLength={deciding.status === "approved" ? 120 : 500}
                onChange={(e) => setReference(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
              />
            </label>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setDeciding(null)} className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">
                Back
              </button>
              <button
                type="button"
                onClick={decide}
                disabled={saving}
                className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-60 ${
                  deciding.status === "approved" ? "bg-emerald-600 hover:bg-emerald-700" : "bg-slate-800 hover:bg-slate-900"
                }`}
              >
                {saving && <Loader2 className="w-4 h-4 animate-spin" />}
                {deciding.status === "approved" ? "Mark paid" : "Cancel payouts"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
