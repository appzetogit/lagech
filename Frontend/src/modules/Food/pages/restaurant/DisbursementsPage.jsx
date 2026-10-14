import { useEffect, useState } from "react"
import { useNavigate } from "react-router-dom"
import { ArrowLeft, Banknote, CheckCircle2, Clock3, Download, Loader2, Receipt, XCircle } from "lucide-react"
import { toast } from "sonner"
import BottomNavOrders from "@food/components/restaurant/BottomNavOrders"
import { restaurantAPI } from "@food/api"
import { exportDate, exportMoney, exportRows, fetchAllPages } from "@food/utils/listExport"

/**
 * The old store panel's "Disbursement" page: every daily payout line made for
 * this restaurant, which run made it, where it is paid, and whether the admin
 * has completed or canceled it. A pending line is already held back from the
 * withdrawable balance; a canceled one is back in it.
 */

const LIMIT = 20
const TABS = [
  { id: "all", label: "All" },
  { id: "pending", label: "Pending" },
  { id: "completed", label: "Completed" },
  { id: "canceled", label: "Canceled" },
]

const STATUS = {
  pending: { label: "Pending", className: "bg-amber-100 text-amber-800", icon: Clock3 },
  completed: { label: "Completed", className: "bg-[#dce8f5] text-[#2f5280]", icon: CheckCircle2 },
  canceled: { label: "Canceled", className: "bg-rose-100 text-rose-700", icon: XCircle },
}

const rupees = (amount) =>
  `₹${Number(amount || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const dateTime = (value) => {
  if (!value) return "—"
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return "—"
  return d.toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: true })
}

/** "UPI · a@upi" / "Bank transfer · A/c 1234". */
const paidTo = (line) => {
  const d = line?.bankDetails || {}
  if (line?.paymentMethod === "upi") return ["UPI", d.upiId].filter(Boolean).join(" · ")
  if (line?.paymentMethod === "bank_transfer") {
    const account = d.accountNumber ? `A/c ••••${String(d.accountNumber).slice(-4)}` : ""
    return ["Bank transfer", account].filter(Boolean).join(" · ")
  }
  return d.payoutMethod?.methodName || String(line?.paymentMethod || "—").replace(/_/g, " ")
}

const EXPORT_COLUMNS = [
  { label: "Disbursement", value: (l) => l.title },
  { label: "Created at", value: (l) => exportDate(l.createdAt) },
  { label: "Amount", value: (l) => exportMoney(l.amount) },
  { label: "Payment method", value: (l) => paidTo(l) },
  { label: "Status", value: (l) => STATUS[l.disbursementStatus]?.label || l.disbursementStatus },
  { label: "Completed / canceled at", value: (l) => exportDate(l.processedAt) },
  { label: "Reference", value: (l) => l.transactionId || "" },
]

function StatusPill({ status }) {
  const s = STATUS[status] || STATUS.pending
  return <span className={`shrink-0 px-2.5 py-1 rounded-full text-[11px] font-bold ${s.className}`}>{s.label}</span>
}

export default function DisbursementsPage() {
  const navigate = useNavigate()
  const [tab, setTab] = useState("all")
  const [rows, setRows] = useState([])
  const [summary, setSummary] = useState(null)
  const [page, setPage] = useState(1)
  const [pages, setPages] = useState(1)
  const [loading, setLoading] = useState(true)
  const [exporting, setExporting] = useState(false)

  useEffect(() => {
    let alive = true
    setLoading(true)
    restaurantAPI
      .getDisbursements({ status: tab, page, limit: LIMIT })
      .then((res) => {
        if (!alive) return
        const data = res?.data?.data || {}
        // Phones: "Load more" adds the next page under the last.
        setRows((prev) => (page === 1 ? data.disbursements || [] : [...prev, ...(data.disbursements || [])]))
        setSummary(data.summary || null)
        setPages(data.pagination?.pages || 1)
      })
      .catch((err) => {
        if (alive && err?.response?.status !== 401) toast.error(err?.response?.data?.message || "Could not load disbursements")
      })
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [tab, page])

  const openTab = (id) => {
    if (id === tab) return
    setRows([])
    setPage(1)
    setTab(id)
  }

  const exportAll = async () => {
    try {
      setExporting(true)
      const all = await fetchAllPages(
        ({ page: p, limit }) => restaurantAPI.getDisbursements({ status: tab, page: p, limit }),
        (res) => ({ rows: res?.data?.data?.disbursements || [], pages: res?.data?.data?.pagination?.pages }),
        { pageSize: 100 },
      )
      if (!all.length) toast.info("Nothing to export")
      else exportRows("csv", { filename: "disbursements", columns: EXPORT_COLUMNS, rows: all })
    } catch (err) {
      toast.error(err?.response?.data?.message || "Export failed")
    } finally {
      setExporting(false)
    }
  }

  const cards = [
    ["pending", "Pending", Clock3],
    ["completed", "Completed", Banknote],
    ["canceled", "Canceled", XCircle],
  ]

  return (
    <div className="min-h-screen bg-[#e9edf2] flex flex-col md:h-full md:overflow-hidden">
      <div className="sticky top-0 z-40 px-4 py-3 border-b border-[#d5dbe3] bg-[#f2f4f7]/95 backdrop-blur md:static md:px-8 md:pt-7 md:pb-5">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => navigate("/food/restaurant/hub-finance")}
            className="p-1.5 hover:bg-white/80 rounded-xl transition-colors"
            aria-label="Go back"
          >
            <ArrowLeft className="w-6 h-6 text-[#141820]" />
          </button>
          <div className="flex-1 min-w-0">
            <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#5c6775]">Finance</p>
            <h1 className="text-lg md:text-3xl font-black tracking-tight text-[#141820]">Disbursements</h1>
            <p className="hidden md:block mt-1 text-sm text-[#5c6775]">Daily payouts the platform made for you, and whether each was paid</p>
          </div>
          <button
            type="button"
            onClick={exportAll}
            disabled={exporting}
            className="inline-flex items-center gap-1.5 rounded-full border border-[#c8d0da] bg-white px-3 py-2 text-sm font-semibold text-[#141820] hover:bg-[#eef1f5] disabled:opacity-60"
          >
            {exporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
            <span className="hidden sm:inline">Export</span>
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 pt-4 pb-28 md:px-8 md:pb-8 md:min-h-0">
        <div className="grid grid-cols-3 gap-2 md:gap-4">
          {cards.map(([key, label, Icon]) => (
            <div key={key} className={`rounded-2xl border border-[#d6dce4] p-3 md:p-5 ${key === "pending" ? "bg-[#141820] text-white" : "bg-white"}`}>
              <div className="flex items-center justify-between gap-2">
                <p className={`text-[10px] font-bold uppercase tracking-wider md:text-[11px] ${key === "pending" ? "text-[#8b98a8]" : "text-[#5c6775]"}`}>{label}</p>
                <Icon className={`w-3.5 h-3.5 md:w-4 md:h-4 ${key === "pending" ? "text-[#a8bdda]" : "text-[#4f6f9a]"}`} />
              </div>
              <p className={`mt-2 text-sm font-black tabular-nums truncate md:text-2xl ${key === "pending" ? "" : "text-[#141820]"}`}>{rupees(summary?.[key]?.amount)}</p>
              <p className={`mt-0.5 text-[11px] md:text-sm ${key === "pending" ? "text-[#9aa7b6]" : "text-[#5c6775]"}`}>{summary?.[key]?.count || 0} line(s)</p>
            </div>
          ))}
        </div>
        {summary?.pending?.amount > 0 && (
          <p className="mt-3 text-xs text-[#5c6775]">Pending lines are held back from your withdrawable balance until the admin pays or cancels them.</p>
        )}

        <div className="mt-4 inline-flex w-full md:w-auto rounded-full bg-[#141820] p-1 shadow-sm">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => openTab(t.id)}
              className={`flex-1 md:flex-none px-3 py-2.5 md:px-5 rounded-full text-sm font-semibold transition-colors ${
                tab === t.id ? "bg-[#4f6f9a] text-white" : "text-[#b8c2cf] hover:text-white"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="mt-4 rounded-2xl border border-[#d6dce4] bg-white/80 p-3 md:p-5">
          {loading && rows.length === 0 ? (
            <div className="py-16 text-center text-sm text-[#5c6775]">Loading disbursements...</div>
          ) : rows.length === 0 ? (
            <div className="flex flex-col items-center justify-center text-center px-6 py-16">
              <div className="w-16 h-16 rounded-2xl bg-[#edf1f5] border border-[#d6dce4] flex items-center justify-center mb-4">
                <Receipt className="w-7 h-7 text-[#5c6775]" />
              </div>
              <p className="text-base font-bold text-[#141820]">No disbursements</p>
              <p className="mt-1.5 text-sm text-[#5c6775] max-w-sm">Each daily payout made for you will show up here.</p>
            </div>
          ) : (
            <>
              <div className="space-y-3 md:hidden">
                {rows.map((line) => (
                  <div key={line.id} className="rounded-2xl border border-[#d6dce4] bg-white p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-[#5c6775]">{line.title}</p>
                        <p className="mt-1 text-2xl font-black tracking-tight tabular-nums text-[#141820]">{rupees(line.amount)}</p>
                      </div>
                      <StatusPill status={line.disbursementStatus} />
                    </div>
                    <div className="mt-2 space-y-1 text-xs text-[#5c6775]">
                      <p>Created · {dateTime(line.createdAt)}</p>
                      <p className="break-words">Paid to · {paidTo(line)}</p>
                      {line.processedAt && (
                        <p>{line.disbursementStatus === "canceled" ? "Canceled" : "Completed"} · {dateTime(line.processedAt)}</p>
                      )}
                      {line.transactionId && <p className="break-words">Reference · {line.transactionId}</p>}
                    </div>
                  </div>
                ))}
              </div>
              <div className="hidden md:block overflow-hidden rounded-2xl border border-[#e2e7ed]">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-[#f5f7fa] text-left text-[11px] uppercase tracking-wider text-[#5c6775]">
                      <th className="px-4 py-3 font-bold">Disbursement</th>
                      <th className="px-4 py-3 font-bold">Created</th>
                      <th className="px-4 py-3 font-bold">Amount</th>
                      <th className="px-4 py-3 font-bold">Payment method</th>
                      <th className="px-4 py-3 font-bold">Completed / canceled</th>
                      <th className="px-4 py-3 font-bold text-right">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((line) => (
                      <tr key={line.id} className="border-t border-[#eef1f5] hover:bg-[#f5f7fa]/80">
                        <td className="px-4 py-4 font-semibold text-[#141820]">{line.title}</td>
                        <td className="px-4 py-4 text-[#5c6775] whitespace-nowrap">{dateTime(line.createdAt)}</td>
                        <td className="px-4 py-4 font-bold tabular-nums text-[#141820]">{rupees(line.amount)}</td>
                        <td className="px-4 py-4 text-[#5c6775]">{paidTo(line)}</td>
                        <td className="px-4 py-4 text-[#5c6775] whitespace-nowrap">
                          {line.processedAt ? dateTime(line.processedAt) : "—"}
                          {line.transactionId && <p className="text-[11px]">Ref {line.transactionId}</p>}
                        </td>
                        <td className="px-4 py-4 text-right"><StatusPill status={line.disbursementStatus} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {page < pages && (
                <button
                  type="button"
                  onClick={() => setPage((p) => p + 1)}
                  disabled={loading}
                  className="mt-4 w-full rounded-2xl border border-[#c8d0da] bg-white py-3 text-sm font-semibold text-[#141820] hover:bg-[#eef1f5] disabled:opacity-60"
                >
                  {loading ? "Loading..." : "Load more"}
                </button>
              )}
            </>
          )}
        </div>
      </div>

      <BottomNavOrders />
    </div>
  )
}
