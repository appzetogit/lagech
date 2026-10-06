import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { Loader2, Package, Play, Wallet, X } from "@food/components/admin/theme/icons"
import { toast } from "sonner"
import { adminRiderExtrasAPI } from "@food/api/adminRiderExtras"

export const formatCurrency = (amount) =>
  `₹${Number(amount || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export const formatDate = (d) => {
  if (!d) return "—"
  try {
    return new Date(d).toLocaleString("en-IN", {
      day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: true,
    })
  } catch {
    return String(d)
  }
}

export const DISBURSEMENT_STATUS = {
  pending: { label: "Pending", className: "bg-amber-100 text-amber-700" },
  partially_completed: { label: "Partially completed", className: "bg-blue-100 text-blue-700" },
  completed: { label: "Completed", className: "bg-green-100 text-green-700" },
  canceled: { label: "Canceled", className: "bg-slate-200 text-slate-700" },
}

function GenerateDialog({ onClose, onCreated }) {
  const [minAmount, setMinAmount] = useState(1)
  const [saving, setSaving] = useState(false)

  const generate = async (event) => {
    event.preventDefault()
    try {
      setSaving(true)
      const res = await adminRiderExtrasAPI.generateDisbursement({ minAmount: Number(minAmount) })
      const data = res?.data?.data || {}
      if (data.created) {
        toast.success(res?.data?.message || "Disbursement created")
        onCreated(data.batch)
      } else {
        toast.message(data.reason || "Nobody to pay right now")
        onClose()
      }
    } catch (err) {
      toast.error(err?.response?.data?.message || "Failed to create the disbursement")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
      <form onSubmit={generate} className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl space-y-4">
        <div className="flex items-start justify-between">
          <h3 className="text-lg font-bold text-slate-900">Generate disbursement</h3>
          <button type="button" onClick={onClose} aria-label="Close"><X className="w-5 h-5 text-slate-500" /></button>
        </div>
        <p className="text-sm text-slate-600">
          Creates one payout for every approved delivery man whose withdrawable balance is at least the minimum, for
          their whole balance. Delivery men without a bank account or UPI id are listed as skipped.
        </p>
        <label className="block space-y-1">
          <span className="text-sm font-semibold text-slate-700">Minimum balance to pay (₹)</span>
          <input
            type="number"
            min="1"
            step="0.01"
            value={minAmount}
            onChange={(e) => setMinAmount(e.target.value)}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            required
          />
        </label>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">Cancel</button>
          <button type="submit" disabled={saving} className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60">
            {saving && <Loader2 className="w-4 h-4 animate-spin" />} Generate
          </button>
        </div>
      </form>
    </div>
  )
}

/** Delivery man disbursements: batches that pay each rider their withdrawable balance. */
export default function DeliveryDisbursements() {
  const [batches, setBatches] = useState([])
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const [pages, setPages] = useState(1)
  const [total, setTotal] = useState(0)
  const [generating, setGenerating] = useState(false)

  const fetchBatches = async (p = page) => {
    try {
      setLoading(true)
      const res = await adminRiderExtrasAPI.getDisbursements({ page: p, limit: 20 })
      const data = res?.data?.data
      setBatches(data?.batches || [])
      setPages(data?.pagination?.pages || 1)
      setTotal(data?.pagination?.total || 0)
    } catch (err) {
      toast.error(err?.response?.data?.message || "Failed to load disbursements")
      setBatches([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchBatches(page)
  }, [page])

  return (
    <div className="p-4 lg:p-6 bg-slate-50 min-h-screen">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
          <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
            <div>
              <div className="flex items-center gap-3">
                <Wallet className="w-5 h-5 text-teal-700" />
                <h1 className="text-2xl font-bold text-slate-900">Delivery Man Disbursement</h1>
              </div>
              <p className="text-sm text-slate-600 mt-1 max-w-3xl">
                A disbursement lists what each delivery man can be paid. Pay each one by bank transfer or UPI to the
                details shown, then mark it paid. Money in a pending payout cannot also be withdrawn by the delivery
                man; a failed payout goes back to their balance.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setGenerating(true)}
              className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-700 shrink-0"
            >
              <Play className="w-4 h-4" /> Generate disbursement
            </button>
          </div>
        </div>

        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
          <div className="flex items-center gap-2 mb-4">
            <h2 className="text-xl font-bold text-slate-900">Disbursements</h2>
            <span className="px-3 py-1 rounded-full text-sm font-semibold bg-slate-100 text-slate-700">{total}</span>
          </div>

          {loading ? (
            <div className="py-20 text-center"><Loader2 className="w-8 h-8 animate-spin text-teal-600 mx-auto" /></div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-slate-50 border-b border-slate-200">
                  <tr>
                    {["Disbursement", "Created", "Delivery men", "Total", "Paid", "Status", ""].map((h) => (
                      <th key={h} className="px-6 py-4 text-left text-[10px] font-bold text-slate-700 uppercase tracking-wider">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {batches.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-6 py-16 text-center">
                        <Package className="w-12 h-12 text-slate-400 mx-auto mb-3" />
                        <p className="font-semibold text-slate-700">No disbursements yet</p>
                        <p className="text-sm text-slate-500">Generate one to pay delivery men their balances.</p>
                      </td>
                    </tr>
                  ) : (
                    batches.map((b) => {
                      const badge = DISBURSEMENT_STATUS[b.status] || DISBURSEMENT_STATUS.pending
                      return (
                        <tr key={b.id} className="hover:bg-slate-50">
                          <td className="px-6 py-4 text-sm font-semibold text-slate-800">{b.title}</td>
                          <td className="px-6 py-4 text-sm text-slate-700 whitespace-nowrap">{formatDate(b.createdAt)}</td>
                          <td className="px-6 py-4 text-sm text-slate-700">
                            {b.riderCount}
                            {b.skipped?.length > 0 && <span className="block text-[11px] text-red-600">{b.skipped.length} skipped</span>}
                          </td>
                          <td className="px-6 py-4 text-sm font-medium text-slate-800">{formatCurrency(b.totalAmount)}</td>
                          <td className="px-6 py-4 text-sm text-slate-700">{formatCurrency(b.paidAmount)}</td>
                          <td className="px-6 py-4">
                            <span className={`px-2 py-0.5 rounded text-xs font-semibold ${badge.className}`}>{badge.label}</span>
                          </td>
                          <td className="px-6 py-4 text-right">
                            <Link
                              to={`/admin/food/deliveryman-disbursements/${b.id}`}
                              className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                            >
                              View
                            </Link>
                          </td>
                        </tr>
                      )
                    })
                  )}
                </tbody>
              </table>
            </div>
          )}

          {pages > 1 && (
            <div className="flex items-center justify-between mt-4 pt-4 border-t border-slate-200">
              <p className="text-sm text-slate-600">Page {page} of {pages}</p>
              <div className="flex gap-2">
                <button type="button" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1} className="px-4 py-2 text-sm rounded-lg border border-slate-300 disabled:opacity-50">Previous</button>
                <button type="button" onClick={() => setPage((p) => Math.min(pages, p + 1))} disabled={page >= pages} className="px-4 py-2 text-sm rounded-lg border border-slate-300 disabled:opacity-50">Next</button>
              </div>
            </div>
          )}
        </div>
      </div>
      {generating && (
        <GenerateDialog
          onClose={() => setGenerating(false)}
          onCreated={() => {
            setGenerating(false)
            setPage(1)
            fetchBatches(1)
          }}
        />
      )}
    </div>
  )
}
