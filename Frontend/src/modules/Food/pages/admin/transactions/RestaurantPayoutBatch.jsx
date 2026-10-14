import { useEffect, useMemo, useState } from "react"
import { Link, useParams } from "react-router-dom"
import { ArrowLeft, CheckCircle2, Loader2, Search, XCircle } from "@food/components/admin/theme/icons"
import { toast } from "sonner"
import { adminAPI } from "@food/api"
import ExportMenu from "@food/components/admin/ExportMenu"
import { exportDate, exportMoney } from "@food/utils/listExport"
import {
  BATCH_STATUS, LINE_STATUS, PayTo, StatusBadge, TotalsStrip, formatCurrency, formatDateTime, methodLabel, payToText,
} from "./restaurantDisbursementShared"

const TABS = [
  ["all", "All"],
  ["pending", "Pending"],
  ["approved", "Completed"],
  ["rejected", "Canceled"],
]

const EXPORT_COLUMNS = [
  { label: "SL", value: (_, i) => i + 1 },
  { label: "Restaurant", value: (l) => l.restaurantName },
  { label: "Owner", value: (l) => l.ownerName },
  { label: "Phone", value: (l) => l.ownerPhone },
  { label: "Amount", value: (l) => exportMoney(l.amount) },
  { label: "Payment method", value: (l) => methodLabel(l) },
  { label: "Pay to", value: (l) => payToText(l) },
  { label: "Status", value: (l) => LINE_STATUS[l.status]?.label || l.status },
  { label: "Reference / note", value: (l) => l.transactionId || l.adminNote || l.rejectionReason || "" },
  { label: "Decided at", value: (l) => exportDate(l.processedAt) },
]

/** One disbursement: a line per restaurant, completed or canceled one by one or in bulk. */
export default function RestaurantPayoutBatch() {
  const { batchId } = useParams()
  const [batch, setBatch] = useState(null)
  const [summary, setSummary] = useState(null)
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
      const res = await adminAPI.getRestaurantPayoutBatch(batchId)
      setBatch(res?.data?.data?.batch || null)
      setSummary(res?.data?.data?.summary || null)
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
      (p) => (tab === "all" || p.status === tab) && (!q || p.restaurantName.toLowerCase().includes(q)),
    )
  }, [payouts, search, tab])

  const pendingVisible = visible.filter((p) => p.status === "pending")
  const allPendingSelected = pendingVisible.length > 0 && pendingVisible.every((p) => selected.has(p.id))
  const countOf = (status) => (status === "all" ? payouts.length : payouts.filter((p) => p.status === status).length)

  const toggle = (id) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const sumOf = (ids) => payouts.filter((p) => ids.has(p.id)).reduce((sum, p) => sum + p.amount, 0)

  const decide = async () => {
    try {
      setSaving(true)
      const completing = deciding.status === "approved"
      const res = await adminAPI.decideRestaurantPayouts(batchId, {
        ids: [...deciding.ids],
        status: deciding.status,
        transactionId: completing ? reference.trim() || undefined : undefined,
        adminNote: !completing ? reference.trim() || undefined : undefined,
      })
      const { updated, notPending } = res?.data?.data || {}
      toast.success(
        `${updated} line(s) marked ${completing ? "completed" : "canceled"}` +
          (notPending ? `; ${notPending} were already decided` : ""),
      )
      setDeciding(null)
      setReference("")
      load()
    } catch (err) {
      toast.error(err?.response?.data?.message || "Failed to update the disbursement")
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
  if (!batch) return <div className="p-6 text-slate-600">Disbursement not found.</div>

  const RowActions = ({ line }) =>
    line.status === "pending" ? (
      <div className="flex gap-1.5">
        <button
          type="button"
          onClick={() => setDeciding({ ids: new Set([line.id]), status: "approved" })}
          className="rounded-md bg-emerald-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-emerald-700"
        >
          Complete
        </button>
        <button
          type="button"
          onClick={() => setDeciding({ ids: new Set([line.id]), status: "rejected" })}
          className="rounded-md border border-slate-300 px-2.5 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50"
        >
          Cancel
        </button>
      </div>
    ) : (
      <span className="text-xs text-slate-500">{formatDateTime(line.processedAt)}</span>
    )

  return (
    <div className="p-4 lg:p-6 bg-slate-50 min-h-screen">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-4 sm:p-6">
          <Link to="/admin/food/restaurant-disbursements" className="inline-flex items-center gap-1 text-sm text-slate-600 hover:text-slate-900 mb-3">
            <ArrowLeft className="w-4 h-4" /> All disbursements
          </Link>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-xl sm:text-2xl font-bold text-slate-900">{batch.title}</h1>
            <StatusBadge map={BATCH_STATUS} status={batch.status} />
            {batch.isLegacy && <span className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-600">Previous system</span>}
          </div>
          <p className="text-sm text-slate-600 mt-1">
            Created {formatDateTime(batch.createdAt)}
            {!batch.isLegacy && <> · earnings from orders placed before {formatDateTime(batch.cutoffAt)}</>}
          </p>
          <div className="mt-4">
            <TotalsStrip total={{ amount: batch.totalAmount, count: batch.restaurantCount }} totals={summary} totalLabel="Restaurants" />
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

        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-4 sm:p-6">
          <div className="flex gap-2 mb-4 overflow-x-auto pb-1 -mx-1 px-1">
            {TABS.map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => {
                  setTab(key)
                  setSelected(new Set())
                }}
                className={`shrink-0 rounded-full px-3 py-1 text-xs font-semibold ${
                  tab === key ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                }`}
              >
                {label} ({countOf(key)})
              </button>
            ))}
          </div>

          <div className="flex flex-col sm:flex-row sm:items-center gap-3 mb-4">
            <div className="relative flex-1 sm:max-w-xs">
              <input
                type="text"
                placeholder="Search restaurant"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-9 pr-3 py-2 w-full text-sm rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-slate-400"
              />
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            </div>
            <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
              {selected.size > 0 && (
                <>
                  <span className="text-sm text-slate-600">
                    {selected.size} selected · {formatCurrency(sumOf(selected))}
                  </span>
                  <button
                    type="button"
                    onClick={() => setDeciding({ ids: selected, status: "approved" })}
                    className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-700"
                  >
                    <CheckCircle2 className="w-4 h-4" /> Complete
                  </button>
                  <button
                    type="button"
                    onClick={() => setDeciding({ ids: selected, status: "rejected" })}
                    className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
                  >
                    <XCircle className="w-4 h-4" /> Cancel
                  </button>
                </>
              )}
              <ExportMenu
                filename={batch.title.replace(/\W+/g, "_")}
                sheetName="Disbursement"
                columns={EXPORT_COLUMNS}
                getRows={() => visible}
              />
            </div>
          </div>

          {visible.length === 0 ? (
            <p className="py-12 text-center text-sm text-slate-500">No lines here.</p>
          ) : (
            <>
              {/* Phones: a card per line. */}
              <div className="md:hidden">
                {pendingVisible.length > 0 && (
                  <label className="flex items-center gap-2 mb-2 text-sm text-slate-600">
                    <input
                      type="checkbox"
                      checked={allPendingSelected}
                      onChange={() => setSelected(allPendingSelected ? new Set() : new Set(pendingVisible.map((p) => p.id)))}
                    />
                    Select all pending
                  </label>
                )}
                <div className="space-y-3">
                  {visible.map((line) => (
                    <div key={line.id} className="rounded-lg border border-slate-200 p-3">
                      <div className="flex items-start gap-2">
                        <input
                          type="checkbox"
                          className="mt-1"
                          aria-label={`Select ${line.restaurantName}`}
                          checked={selected.has(line.id)}
                          disabled={line.status !== "pending"}
                          onChange={() => toggle(line.id)}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-start justify-between gap-2">
                            <p className="text-sm font-semibold text-slate-800 break-words">{line.restaurantName}</p>
                            <StatusBadge map={LINE_STATUS} status={line.status} />
                          </div>
                          <p className="text-xs text-slate-500">{[line.ownerName, line.ownerPhone].filter(Boolean).join(" · ")}</p>
                          <p className="mt-1 text-lg font-bold text-slate-900">{formatCurrency(line.amount)}</p>
                          <div className="mt-1"><PayTo line={line} /></div>
                          {(line.transactionId || line.adminNote) && (
                            <p className="mt-1 text-xs text-slate-500 break-words">{line.transactionId || line.adminNote}</p>
                          )}
                          <div className="mt-2"><RowActions line={line} /></div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="hidden md:block overflow-x-auto">
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
                      {["Restaurant", "Amount", "Payment method", "Status", "Reference", "Action"].map((h) => (
                        <th key={h} className="px-4 py-3 text-left text-[10px] font-bold text-slate-700 uppercase tracking-wider">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {visible.map((line) => (
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
                          <Link to={`/admin/food/restaurants/view/${line.restaurantId}/disbursements`} className="font-semibold text-slate-800 hover:underline">
                            {line.restaurantName}
                          </Link>
                          <p className="text-xs text-slate-500">{[line.ownerName, line.ownerPhone].filter(Boolean).join(" · ")}</p>
                        </td>
                        <td className="px-4 py-4 text-sm font-semibold text-slate-900 whitespace-nowrap">{formatCurrency(line.amount)}</td>
                        <td className="px-4 py-4"><PayTo line={line} /></td>
                        <td className="px-4 py-4"><StatusBadge map={LINE_STATUS} status={line.status} /></td>
                        <td className="px-4 py-4 text-xs text-slate-600 break-words max-w-[200px]">
                          {line.transactionId || line.adminNote || line.rejectionReason || "—"}
                        </td>
                        <td className="px-4 py-4"><RowActions line={line} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      </div>

      {deciding && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
          <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl space-y-4">
            <h3 className="text-lg font-bold text-slate-900">
              {deciding.status === "approved" ? "Mark as completed" : "Cancel disbursement lines"}
            </h3>
            <p className="text-sm text-slate-600">
              {deciding.ids.size} line(s), {formatCurrency(sumOf(deciding.ids))}.{" "}
              {deciding.status === "approved"
                ? "Only do this after the money has been sent. It is taken from each restaurant's balance for good."
                : "The amount goes back to each restaurant's withdrawable balance and is included in the next run."}
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
                {deciding.status === "approved" ? "Complete" : "Cancel lines"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
