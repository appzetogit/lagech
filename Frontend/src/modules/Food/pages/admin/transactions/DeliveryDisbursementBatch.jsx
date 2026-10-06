import { useEffect, useMemo, useState } from "react"
import { Link, useParams } from "react-router-dom"
import { ArrowLeft, CheckCircle2, Copy, Loader2, Search, XCircle } from "@food/components/admin/theme/icons"
import { toast } from "sonner"
import { adminRiderExtrasAPI } from "@food/api/adminRiderExtras"
import { DISBURSEMENT_STATUS, formatCurrency, formatDate } from "./DeliveryDisbursements"

const LINE_STATUS = {
  pending: { label: "Pending", className: "bg-amber-100 text-amber-700" },
  paid: { label: "Paid", className: "bg-green-100 text-green-700" },
  failed: { label: "Failed", className: "bg-red-100 text-red-700" },
}

const TABS = [
  ["all", "All"],
  ["pending", "Pending"],
  ["paid", "Paid"],
  ["failed", "Failed"],
]

const copy = (text) => {
  if (!text) return
  navigator.clipboard?.writeText(String(text)).then(
    () => toast.success("Copied"),
    () => toast.error("Could not copy"),
  )
}

function CopyRow({ label, value }) {
  if (!value) return null
  return (
    <div className="flex items-center gap-1 text-xs text-slate-600">
      <span className="text-slate-400">{label}</span>
      <span className="font-mono text-slate-800">{value}</span>
      <button type="button" onClick={() => copy(value)} className="text-slate-400 hover:text-slate-700" aria-label={`Copy ${label}`}>
        <Copy className="w-3 h-3" />
      </button>
    </div>
  )
}

/** The account a line is paid to, as it was on file when the disbursement was made. */
function PayTo({ line }) {
  const d = line.bankDetails || {}
  if (line.paymentMethod === "upi") {
    return (
      <div>
        <span className="text-xs font-semibold text-slate-700">UPI</span>
        <CopyRow label="ID" value={d.upiId} />
      </div>
    )
  }
  return (
    <div>
      <span className="text-xs font-semibold text-slate-700">Bank transfer</span>
      <CopyRow label="Name" value={d.accountHolderName} />
      <CopyRow label="A/c" value={d.accountNumber} />
      <CopyRow label="IFSC" value={d.ifscCode} />
      <CopyRow label="Bank" value={d.bankName} />
    </div>
  )
}

export default function DeliveryDisbursementBatch() {
  const { batchId } = useParams()
  const [batch, setBatch] = useState(null)
  const [payouts, setPayouts] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState("")
  const [tab, setTab] = useState("all")
  const [selected, setSelected] = useState(new Set())
  const [deciding, setDeciding] = useState(null)
  const [reference, setReference] = useState("")
  const [saving, setSaving] = useState(false)

  const load = async () => {
    try {
      setLoading(true)
      const res = await adminRiderExtrasAPI.getDisbursement(batchId)
      setBatch(res?.data?.data?.batch || null)
      setPayouts(res?.data?.data?.payouts || [])
      setSelected(new Set())
    } catch (err) {
      toast.error(err?.response?.data?.message || "Failed to load the disbursement")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [batchId])

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    return payouts.filter(
      (p) =>
        (tab === "all" || p.status === tab) &&
        (!q || p.deliveryName.toLowerCase().includes(q) || p.deliveryPhone.includes(q)),
    )
  }, [payouts, search, tab])

  const pendingVisible = visible.filter((p) => p.status === "pending")
  const allPendingSelected = pendingVisible.length > 0 && pendingVisible.every((p) => selected.has(p.id))
  const sumOf = (list) => list.reduce((sum, p) => sum + p.amount, 0)

  const toggle = (id) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const decide = async () => {
    try {
      setSaving(true)
      const res = await adminRiderExtrasAPI.decideDisbursementPayouts(batchId, {
        ids: [...deciding.ids],
        status: deciding.status,
        reference: deciding.status === "paid" ? reference.trim() || undefined : undefined,
        note: deciding.status === "failed" ? reference.trim() || undefined : undefined,
      })
      const { updated = 0, notPending = 0, failed = [] } = res?.data?.data || {}
      const parts = [`${updated} payout(s) marked ${deciding.status}`]
      if (notPending) parts.push(`${notPending} were already decided`)
      if (failed.length) parts.push(`${failed.length} could not be updated: ${failed[0].reason}`)
      ;(failed.length ? toast.error : toast.success)(parts.join("; "))
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
        <Loader2 className="w-8 h-8 animate-spin text-teal-600 mx-auto" />
      </div>
    )
  }
  if (!batch) return <div className="p-6 text-slate-600">This disbursement was not found.</div>

  const badge = DISBURSEMENT_STATUS[batch.status] || DISBURSEMENT_STATUS.pending

  return (
    <div className="p-4 lg:p-6 bg-slate-50 min-h-screen">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
          <Link to="/admin/food/deliveryman-disbursements" className="inline-flex items-center gap-1 text-sm text-slate-600 hover:text-slate-900 mb-3">
            <ArrowLeft className="w-4 h-4" /> All disbursements
          </Link>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-bold text-slate-900">{batch.title}</h1>
            <span className={`px-2 py-0.5 rounded text-xs font-semibold ${badge.className}`}>{badge.label}</span>
          </div>
          <p className="text-sm text-slate-600 mt-1">
            Created {formatDate(batch.createdAt)} for balances of {formatCurrency(batch.minAmount)} or more
          </p>
          <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-4">
            {[
              ["Delivery men", batch.riderCount],
              ["Total", formatCurrency(batch.totalAmount)],
              ["Paid", formatCurrency(batch.paidAmount)],
              ["Left to pay", formatCurrency(batch.pendingAmount)],
            ].map(([label, value]) => (
              <div key={label} className="rounded-lg bg-slate-50 border border-slate-200 p-3">
                <p className="text-xs text-slate-500">{label}</p>
                <p className="text-lg font-bold text-slate-900">{value}</p>
              </div>
            ))}
          </div>
          {batch.skipped?.length > 0 && (
            <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3">
              <p className="text-sm font-semibold text-red-700">Not included. Fix these and generate a new disbursement to pay them.</p>
              <ul className="mt-1 text-sm text-red-700 list-disc pl-5">
                {batch.skipped.map((s) => (
                  <li key={s.deliveryPartnerId}>
                    {s.name}: {formatCurrency(s.amount)} ({s.reason})
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
          <div className="flex flex-col lg:flex-row lg:items-center gap-3 mb-4">
            <div className="flex flex-wrap gap-1.5">
              {TABS.map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setTab(key)}
                  className={`rounded-full px-3 py-1 text-xs font-semibold ${tab === key ? "bg-blue-600 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="relative flex-1 max-w-xs">
              <input
                type="text"
                placeholder="Search name or phone"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-9 pr-3 py-2 w-full text-sm rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            </div>
            {selected.size > 0 && (
              <div className="flex flex-wrap items-center gap-2 lg:ml-auto">
                <span className="text-sm text-slate-600">
                  {selected.size} selected · {formatCurrency(sumOf(payouts.filter((p) => selected.has(p.id))))}
                </span>
                <button
                  type="button"
                  onClick={() => setDeciding({ ids: selected, status: "paid" })}
                  className="inline-flex items-center gap-1 rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-700"
                >
                  <CheckCircle2 className="w-4 h-4" /> Mark paid
                </button>
                <button
                  type="button"
                  onClick={() => setDeciding({ ids: selected, status: "failed" })}
                  className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
                >
                  <XCircle className="w-4 h-4" /> Mark failed
                </button>
              </div>
            )}
          </div>

          {!visible.length ? (
            <p className="py-12 text-center text-sm text-slate-500">
              {payouts.length ? "No payout matches these filters." : "This disbursement has no payouts."}
            </p>
          ) : (
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
                        onChange={() => setSelected(allPendingSelected ? new Set() : new Set(pendingVisible.map((p) => p.id)))}
                      />
                    </th>
                    {["Delivery man", "Amount", "Pay to", "Status", "Reference / note"].map((h) => (
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
                            aria-label={`Select ${line.deliveryName}`}
                            checked={selected.has(line.id)}
                            disabled={line.status !== "pending"}
                            onChange={() => toggle(line.id)}
                          />
                        </td>
                        <td className="px-4 py-4 text-sm">
                          <p className="font-semibold text-slate-800">{line.deliveryName}</p>
                          <p className="text-xs text-slate-500">{line.deliveryPhone}</p>
                        </td>
                        <td className="px-4 py-4 text-sm font-semibold text-slate-900 whitespace-nowrap">{formatCurrency(line.amount)}</td>
                        <td className="px-4 py-4"><PayTo line={line} /></td>
                        <td className="px-4 py-4">
                          <span className={`px-2 py-0.5 rounded text-xs font-semibold ${status.className}`}>{status.label}</span>
                          {line.processedAt && <span className="block mt-1 text-[11px] text-slate-500">{formatDate(line.processedAt)}</span>}
                        </td>
                        <td className="px-4 py-4 text-xs text-slate-600 break-words max-w-[220px]">
                          {[line.reference, line.note].filter(Boolean).join(" · ") || "—"}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {deciding && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
          <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl space-y-4">
            <h3 className="text-lg font-bold text-slate-900">{deciding.status === "paid" ? "Mark as paid" : "Mark as failed"}</h3>
            <p className="text-sm text-slate-600">
              {deciding.ids.size} payout(s), {formatCurrency(sumOf(payouts.filter((p) => deciding.ids.has(p.id))))}.{" "}
              {deciding.status === "paid"
                ? "Only do this after the money has been sent. It is taken off each delivery man's balance."
                : "The amount goes back to each delivery man's balance."}
            </p>
            <label className="block space-y-1">
              <span className="text-sm font-semibold text-slate-700">
                {deciding.status === "paid" ? "Transaction reference / UTR (optional)" : "Reason (optional)"}
              </span>
              <input
                type="text"
                value={reference}
                maxLength={deciding.status === "paid" ? 120 : 500}
                onChange={(e) => setReference(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
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
                  deciding.status === "paid" ? "bg-blue-600 hover:bg-blue-700" : "bg-slate-800 hover:bg-slate-900"
                }`}
              >
                {saving && <Loader2 className="w-4 h-4 animate-spin" />}
                {deciding.status === "paid" ? "Mark paid" : "Mark failed"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
