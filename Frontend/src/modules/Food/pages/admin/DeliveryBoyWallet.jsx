import { useState, useEffect } from "react"
import { Search, PiggyBank, Loader2, Package, X } from "lucide-react"
import { adminAPI } from "@food/api"
import { toast } from "sonner"
const debugLog = (...args) => {}
const debugWarn = (...args) => {}
const debugError = (...args) => {}


const formatCurrency = (amount) => {
  if (amount == null) return "\u20B90.00"
  return `\u20B9${Number(amount).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

const COLLECTION_METHODS = [
  ["cash", "Cash"],
  ["upi", "UPI"],
  ["bank_transfer", "Bank transfer"],
  ["razorpay", "Online"],
]

/**
 * Record money a rider handed over. It lowers their cash in hand, and lifts a
 * cash suspension as soon as they are back under the limit.
 */
function CollectCashModal({ wallet, onClose, onSaved }) {
  const [amount, setAmount] = useState(String(wallet.cashCollected || ""))
  const [method, setMethod] = useState("cash")
  const [note, setNote] = useState("")
  const [saving, setSaving] = useState(false)
  const held = Number(wallet.cashCollected) || 0

  const submit = async (e) => {
    e.preventDefault()
    const value = Number(amount)
    if (!Number.isFinite(value) || value < 1) return toast.error("Enter an amount of at least ₹1")
    if (value > held) return toast.error(`Cannot collect more than the ${formatCurrency(held)} this rider holds`)
    try {
      setSaving(true)
      const res = await adminAPI.collectDeliveryCash({
        deliveryPartnerId: wallet.deliveryId,
        amount: value,
        method,
        note: note.trim() || undefined,
      })
      toast.success(
        `Collected ${formatCurrency(value)} from ${wallet.name}. Cash in hand now ${formatCurrency(res?.data?.data?.cashInHand)}`,
      )
      onSaved()
    } catch (err) {
      toast.error(err?.response?.data?.message || "Failed to record the collection")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
      <form onSubmit={submit} className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl space-y-4">
        <div className="flex items-start justify-between">
          <div>
            <h3 className="text-lg font-bold text-slate-900">Collect cash</h3>
            <p className="text-sm text-slate-600">
              {wallet.name} · holding {formatCurrency(held)}
            </p>
          </div>
          <button type="button" onClick={onClose} className="p-1 text-slate-500 hover:text-slate-800" aria-label="Close">
            <X className="w-5 h-5" />
          </button>
        </div>
        <label className="block space-y-1">
          <span className="text-sm font-semibold text-slate-700">Amount (₹)</span>
          <input
            type="number"
            min="1"
            max={held}
            step="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
            required
          />
        </label>
        <div className="space-y-1">
          <span className="text-sm font-semibold text-slate-700">Received by</span>
          <div className="flex flex-wrap gap-2">
            {COLLECTION_METHODS.map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setMethod(key)}
                className={`rounded-lg border px-3 py-1.5 text-sm font-medium ${
                  method === key
                    ? "border-emerald-600 bg-emerald-600 text-white"
                    : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <label className="block space-y-1">
          <span className="text-sm font-semibold text-slate-700">Note (optional)</span>
          <input
            type="text"
            value={note}
            maxLength={200}
            onChange={(e) => setNote(e.target.value)}
            placeholder="UTR / reference, who received it"
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
          />
        </label>
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving}
            className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-60"
          >
            {saving && <Loader2 className="w-4 h-4 animate-spin" />}
            Record collection
          </button>
        </div>
      </form>
    </div>
  )
}

export default function DeliveryBoyWallet() {
  const [wallets, setWallets] = useState([])
  const [loading, setLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState("")
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [pages, setPages] = useState(1)
  const [collecting, setCollecting] = useState(null)
  const limit = 20

  const fetchWallets = async (overrides = {}) => {
    const p = overrides.page || page
    try {
      setLoading(true)
      const res = await adminAPI.getDeliveryWallets({
        search: searchQuery.trim() || undefined,
        page: p,
        limit,
      })
      if (res?.data?.success) {
        const data = res.data.data
        setWallets(data?.wallets || [])
        setTotal(data?.pagination?.total || 0)
        setPages(data?.pagination?.pages || 1)
      } else {
        toast.error(res?.data?.message || "Failed to fetch delivery boy wallets")
        setWallets([])
      }
    } catch (err) {
      debugError("Error fetching delivery boy wallets:", err)
      toast.error(err?.response?.data?.message || "Failed to fetch delivery boy wallets")
      setWallets([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchWallets()
  }, [page])

  useEffect(() => {
    const t = setTimeout(() => {
      setPage(1)
      fetchWallets({ page: 1 })
    }, 500)
    return () => clearTimeout(t)
  }, [searchQuery])

  return (
    <div className="p-4 lg:p-6 bg-slate-50 min-h-screen">
      <div className="max-w-7xl mx-auto">
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 mb-6">
          <div className="flex items-center gap-3">
            <PiggyBank className="w-5 h-5 text-emerald-600" />
            <h1 className="text-2xl font-bold text-slate-900">Delivery boy Wallet</h1>
          </div>
          <p className="text-sm text-slate-600 mt-1">
            View each delivery boy&apos;s wallet details: name, ID, remaining cash limit, pocket balance, cash collected, total earning, bonus, total withdrawal, cash in hand.
          </p>
        </div>

        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-4">
            <div className="flex items-center gap-2">
              <h2 className="text-xl font-bold text-slate-900">Wallets</h2>
              <span className="px-3 py-1 rounded-full text-sm font-semibold bg-slate-100 text-slate-700">
                {total}
              </span>
            </div>
            <div className="relative flex-1 sm:flex-initial min-w-[200px] max-w-xs">
              <input
                type="text"
                placeholder="Search by name, ID, phone"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-10 pr-4 py-2.5 w-full text-sm rounded-lg border border-slate-300 bg-white focus:outline-none focus:ring-2 focus:ring-slate-400 focus:border-slate-400"
              />
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            </div>
          </div>

          {loading ? (
            <div className="py-20 text-center">
              <Loader2 className="w-8 h-8 animate-spin text-emerald-600 mx-auto mb-4" />
              <p className="text-slate-600">Loading wallets…</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-slate-50 border-b border-slate-200">
                  <tr>
                    <th className="px-6 py-4 text-left text-[10px] font-bold text-slate-700 uppercase tracking-wider">#</th>
                    <th className="px-6 py-4 text-left text-[10px] font-bold text-slate-700 uppercase tracking-wider">Name</th>
                    <th className="px-6 py-4 text-left text-[10px] font-bold text-slate-700 uppercase tracking-wider">ID</th>
                    <th className="px-6 py-4 text-left text-[10px] font-bold text-slate-700 uppercase tracking-wider">Remaining cash limit</th>
                    <th className="px-6 py-4 text-left text-[10px] font-bold text-slate-700 uppercase tracking-wider">Pocket balance</th>
                    <th className="px-6 py-4 text-left text-[10px] font-bold text-slate-700 uppercase tracking-wider">Cash collected</th>
                    <th className="px-6 py-4 text-left text-[10px] font-bold text-slate-700 uppercase tracking-wider">Total earning</th>
                    <th className="px-6 py-4 text-left text-[10px] font-bold text-slate-700 uppercase tracking-wider">Bonus</th>
                    <th className="px-6 py-4 text-left text-[10px] font-bold text-slate-700 uppercase tracking-wider">Total withdrawal</th>
                    <th className="px-6 py-4 text-left text-[10px] font-bold text-slate-700 uppercase tracking-wider">Cash in hand</th>
                    <th className="px-6 py-4 text-left text-[10px] font-bold text-slate-700 uppercase tracking-wider">Action</th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-slate-100">
                  {wallets.length === 0 ? (
                    <tr>
                      <td colSpan={11} className="px-6 py-20 text-center">
                        <div className="flex flex-col items-center justify-center">
                          <Package className="w-16 h-16 text-slate-400 mb-4" />
                          <p className="text-lg font-semibold text-slate-700">No wallets</p>
                          <p className="text-sm text-slate-500">No delivery boys found.</p>
                        </div>
                      </td>
                    </tr>
                  ) : (
                    wallets.map((w, i) => (
                      <tr key={w.walletId || w.deliveryId} className="hover:bg-slate-50 transition-colors">
                        <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-slate-700">{(page - 1) * limit + i + 1}</td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-slate-700">
                          {w.name || "—"}
                          {w.cashSuspended ? (
                            <span
                              className="ml-2 rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-bold uppercase text-red-700"
                              title="At or over the cash limit: cannot go online or take orders until the cash is settled"
                            >
                              Suspended
                            </span>
                          ) : w.cashLimitWarning ? (
                            <span
                              className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold uppercase text-amber-700"
                              title="Past 90% of the cash limit"
                            >
                              Near limit
                            </span>
                          ) : null}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-slate-700">{w.deliveryIdString || "—"}</td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-slate-700">{formatCurrency(w.remainingCashLimit)}</td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-slate-700">{formatCurrency(w.pocketBalance)}</td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-slate-700">{formatCurrency(w.cashCollected)}</td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-slate-700">{formatCurrency(w.totalEarning)}</td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-slate-700">{formatCurrency(w.bonus)}</td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-slate-700">{formatCurrency(w.totalWithdrawn)}</td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-slate-700">{formatCurrency(w.cashCollected)}</td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm">
                          <button
                            type="button"
                            onClick={() => setCollecting(w)}
                            disabled={!(Number(w.cashCollected) > 0)}
                            className="rounded-lg border border-emerald-600 px-3 py-1.5 text-xs font-semibold text-emerald-700 hover:bg-emerald-50 disabled:cursor-not-allowed disabled:border-slate-200 disabled:text-slate-400"
                          >
                            Collect cash
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          )}

          {pages > 1 && (
            <div className="flex items-center justify-between mt-4 pt-4 border-t border-slate-200">
              <p className="text-sm text-slate-600">
                Page {page} of {pages} · {total} total
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page <= 1}
                  className="px-4 py-2 text-sm font-medium rounded-lg border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Previous
                </button>
                <button
                  onClick={() => setPage((p) => Math.min(pages, p + 1))}
                  disabled={page >= pages}
                  className="px-4 py-2 text-sm font-medium rounded-lg border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
      {collecting && (
        <CollectCashModal
          wallet={collecting}
          onClose={() => setCollecting(null)}
          onSaved={() => {
            setCollecting(null)
            fetchWallets()
          }}
        />
      )}
    </div>
  )
}

