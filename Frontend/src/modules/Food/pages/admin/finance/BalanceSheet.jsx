import { useState, useEffect, useCallback, useMemo } from "react"
import {
  Loader2, Search, IndianRupee, AlertTriangle, CheckCircle2, Info, History, Landmark,
} from "lucide-react"
import { toast } from "sonner"
import { adminAPI } from "@food/api"

/**
 * What the platform owes each restaurant and rider for a period, and paying it.
 *
 * Distinct from the Withdrawals screens, which are requests coming in. This is
 * the other direction: pick a week, see what is outstanding, pay it, and have
 * the ledger record that it was paid so the same money is never paid twice.
 */

const money = (value) => {
  const n = Number(value) || 0
  return `${n < 0 ? "-" : ""}₹${Math.abs(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

const iso = (date) => date.toISOString().slice(0, 10)

/** Monday-to-Sunday containing `ref`, since payouts are described as weekly. */
const weekOf = (ref = new Date()) => {
  const start = new Date(ref)
  const weekday = (start.getDay() + 6) % 7 // Monday = 0
  start.setDate(start.getDate() - weekday)
  start.setHours(0, 0, 0, 0)
  const end = new Date(start)
  end.setDate(end.getDate() + 6)
  end.setHours(23, 59, 59, 999)
  return { from: iso(start), to: iso(end) }
}

const shiftWeeks = (period, weeks) => {
  const ref = new Date(`${period.from}T00:00:00`)
  ref.setDate(ref.getDate() + weeks * 7)
  return weekOf(ref)
}

export default function BalanceSheet() {
  const [tab, setTab] = useState("restaurants")
  const [period, setPeriod] = useState(() => weekOf())
  const [data, setData] = useState({ rows: [], totals: {} })
  const [loading, setLoading] = useState(true)
  const [payingId, setPayingId] = useState(null)
  const [search, setSearch] = useState("")
  const [history, setHistory] = useState([])
  const [showHistory, setShowHistory] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      // The API takes a datetime range; the pickers are dates, so the end is
      // pushed to the last moment of that day or the final day pays nothing.
      const params = { from: `${period.from}T00:00:00.000Z`, to: `${period.to}T23:59:59.999Z` }
      const res =
        tab === "restaurants"
          ? await adminAPI.getBalanceSheetRestaurants(params)
          : await adminAPI.getBalanceSheetRiders(params)
      const payload = res?.data?.data ?? {}
      setData({ rows: payload.rows || [], totals: payload.totals || {} })
    } catch (error) {
      setData({ rows: [], totals: {} })
    } finally {
      setLoading(false)
    }
  }, [tab, period])

  useEffect(() => {
    load()
  }, [load])

  const loadHistory = async () => {
    try {
      const res = await adminAPI.getBalanceSheetHistory({
        entityType: tab === "restaurants" ? "restaurant" : "rider",
        limit: 25,
      })
      setHistory(res?.data?.data?.settlements || [])
      setShowHistory(true)
    } catch (error) {
      // The interceptor reports it; the panel just stays closed.
    }
  }

  const rows = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) return data.rows
    return data.rows.filter(
      (r) =>
        String(r.name || "").toLowerCase().includes(query) ||
        String(r.contact || "").toLowerCase().includes(query),
    )
  }, [data.rows, search])

  const payout = async (row) => {
    const label = `${row.name} — ${money(row.payable)}`
    if (!window.confirm(`Mark ${label} as paid for ${period.from} to ${period.to}?\n\nThis closes those orders so the same money cannot be paid again.`)) {
      return
    }
    setPayingId(row.entityId)
    try {
      const reference = window.prompt("Bank/UPI reference for this payout (optional):", "") || ""
      await adminAPI.payoutBalance(row.entityType, row.entityId, {
        from: `${period.from}T00:00:00.000Z`,
        to: `${period.to}T23:59:59.999Z`,
        reference,
      })
      toast.success(`Paid ${label}`)
      await load()
    } catch (error) {
      // Interceptor surfaces the reason; the row stays as it was.
    } finally {
      setPayingId(null)
    }
  }

  const isRestaurants = tab === "restaurants"
  const totals = data.totals || {}

  return (
    <div className="p-4 lg:p-6 bg-slate-50 min-h-screen">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
          <div className="flex items-center gap-3 mb-2">
            <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-teal-500 to-teal-700 flex items-center justify-center">
              <Landmark className="w-5 h-5 text-white" />
            </div>
            <h1 className="text-2xl font-bold text-slate-900">Balance Sheet</h1>
          </div>
          <p className="text-sm text-slate-600">
            What is still owed for a period, and paying it out. Separate from Withdrawals,
            which are requests coming the other way.
          </p>

          <div className="mt-5 pt-5 border-t border-slate-200 flex flex-wrap items-end gap-3">
            <div className="flex rounded-lg border border-slate-300 overflow-hidden">
              {[
                { id: "restaurants", label: "Restaurants" },
                { id: "riders", label: "Delivery Partners" },
              ].map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setTab(t.id)}
                  className={`px-4 py-2 text-sm font-medium transition-colors ${tab === t.id ? "bg-teal-700 text-white" : "bg-white text-slate-700 hover:bg-slate-100"}`}
                >
                  {t.label}
                </button>
              ))}
            </div>

            <div>
              <label className="block text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1">
                From
              </label>
              <input
                type="date"
                value={period.from}
                onChange={(e) => setPeriod({ ...period, from: e.target.value })}
                className="text-sm rounded-lg border border-slate-300 px-3 py-2 bg-white"
              />
            </div>
            <div>
              <label className="block text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1">
                To
              </label>
              <input
                type="date"
                value={period.to}
                onChange={(e) => setPeriod({ ...period, to: e.target.value })}
                className="text-sm rounded-lg border border-slate-300 px-3 py-2 bg-white"
              />
            </div>

            <div className="flex gap-1.5">
              <button type="button" onClick={() => setPeriod(shiftWeeks(period, -1))} className="px-3 py-2 text-sm rounded-lg border border-slate-300 bg-white hover:bg-slate-100">
                ← Prev week
              </button>
              <button type="button" onClick={() => setPeriod(weekOf())} className="px-3 py-2 text-sm rounded-lg border border-slate-300 bg-white hover:bg-slate-100">
                This week
              </button>
              <button type="button" onClick={() => setPeriod(shiftWeeks(period, 1))} className="px-3 py-2 text-sm rounded-lg border border-slate-300 bg-white hover:bg-slate-100">
                Next week →
              </button>
            </div>

            <button type="button" onClick={loadHistory} className="ml-auto px-3 py-2 text-sm rounded-lg border border-slate-300 bg-white hover:bg-slate-100 flex items-center gap-1.5">
              <History className="w-4 h-4" /> Past payouts
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <Stat label={isRestaurants ? "Restaurants owed" : "Riders"} value={totals.entities ?? 0} />
          <Stat label={isRestaurants ? "Orders" : "Deliveries"} value={(isRestaurants ? totals.orders : totals.deliveries) ?? 0} />
          <Stat
            label={isRestaurants ? "Commission kept" : "Cash held by riders"}
            value={money(isRestaurants ? totals.commission : totals.cashInHand)}
          />
          <Stat label="Total payable" value={money(totals.payable)} emphasis />
        </div>

        {!isRestaurants && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
            <Info className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
            <p className="text-sm text-amber-900">
              A rider's balance is their earnings and bonuses <strong>minus the cash they are
              still holding</strong> from COD orders. A negative figure means the rider owes the
              platform, not the other way round.
            </p>
          </div>
        )}

        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
          <div className="mb-4 relative max-w-sm">
            <input
              type="text"
              placeholder="Search by name or phone"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-10 pr-4 py-2.5 w-full text-sm rounded-lg border border-slate-300 bg-white focus:outline-none focus:ring-2 focus:ring-slate-400"
            />
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-8 h-8 animate-spin text-teal-600" />
            </div>
          ) : rows.length === 0 ? (
            <div className="py-12 text-center">
              <CheckCircle2 className="w-8 h-8 text-emerald-500 mx-auto mb-2" />
              <p className="text-sm text-slate-600">Nothing outstanding for this period.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-slate-50 border-b border-slate-200">
                  <tr>
                    <Th>{isRestaurants ? "Restaurant" : "Delivery Partner"}</Th>
                    <Th align="right">{isRestaurants ? "Orders" : "Deliveries"}</Th>
                    {isRestaurants ? (
                      <>
                        <Th align="right">Gross Sales</Th>
                        <Th align="right">Commission</Th>
                      </>
                    ) : (
                      <>
                        <Th align="right">Earnings</Th>
                        <Th align="right">Bonus</Th>
                        <Th align="right">Cash In Hand</Th>
                      </>
                    )}
                    <Th align="right">Payable</Th>
                    <Th align="center">Action</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {rows.map((row) => (
                    <tr key={row.entityId} className="hover:bg-slate-50">
                      <td className="px-4 py-3">
                        <p className="text-sm font-medium text-slate-900">{row.name}</p>
                        <p className="text-xs text-slate-500">{row.contact}</p>
                        {!row.hasBankDetails && (
                          <span className="inline-flex items-center gap-1 mt-1 text-[11px] font-semibold text-amber-700">
                            <AlertTriangle className="w-3 h-3" /> No payout details on file
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right text-sm text-slate-700">
                        {isRestaurants ? row.orders : row.deliveries}
                      </td>
                      {isRestaurants ? (
                        <>
                          <td className="px-4 py-3 text-right text-sm text-slate-700">{money(row.grossSales)}</td>
                          <td className="px-4 py-3 text-right text-sm text-slate-700">{money(row.commission)}</td>
                        </>
                      ) : (
                        <>
                          <td className="px-4 py-3 text-right text-sm text-slate-700">{money(row.earnings)}</td>
                          <td className="px-4 py-3 text-right text-sm text-slate-700">{money(row.bonus)}</td>
                          <td className="px-4 py-3 text-right text-sm text-slate-700">{money(row.cashInHand)}</td>
                        </>
                      )}
                      <td className={`px-4 py-3 text-right text-sm font-bold ${row.payable < 0 ? "text-red-600" : "text-slate-900"}`}>
                        {money(row.payable)}
                      </td>
                      <td className="px-4 py-3 text-center">
                        <button
                          type="button"
                          disabled={payingId === row.entityId}
                          onClick={() => payout(row)}
                          className="px-3 py-1.5 text-xs font-medium rounded-lg bg-teal-700 text-white hover:bg-teal-800 disabled:opacity-60 inline-flex items-center gap-1"
                        >
                          {payingId === row.entityId ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <IndianRupee className="w-3.5 h-3.5" />
                          )}
                          {row.payable < 0 ? "Settle" : "Mark paid"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {showHistory && (
          <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-bold text-slate-900">Past payouts</h2>
              <button type="button" onClick={() => setShowHistory(false)} className="text-sm text-slate-500 hover:text-slate-700">
                Hide
              </button>
            </div>
            {history.length === 0 ? (
              <p className="text-sm text-slate-500 py-4">No payouts recorded yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-slate-50 border-b border-slate-200">
                    <tr>
                      <Th>Period</Th>
                      <Th align="right">Amount</Th>
                      <Th align="right">Orders closed</Th>
                      <Th>Reference</Th>
                      <Th>Paid at</Th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {history.map((h) => (
                      <tr key={h.id}>
                        <td className="px-4 py-3 text-sm text-slate-700">
                          {h.periodStart ? new Date(h.periodStart).toLocaleDateString() : "—"} –{" "}
                          {h.periodEnd ? new Date(h.periodEnd).toLocaleDateString() : "—"}
                        </td>
                        <td className="px-4 py-3 text-right text-sm font-semibold text-slate-900">{money(h.amount)}</td>
                        <td className="px-4 py-3 text-right text-sm text-slate-700">{h.transactionsSettled ?? "—"}</td>
                        <td className="px-4 py-3 text-sm text-slate-600">{h.payoutRef || "—"}</td>
                        <td className="px-4 py-3 text-sm text-slate-600">
                          {h.processedAt ? new Date(h.processedAt).toLocaleString() : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// Tailwind extracts class names statically, so `text-${align}` compiles to
// nothing. The three alignments are spelled out instead.
const ALIGN = { left: "text-left", right: "text-right", center: "text-center" }

const Th = ({ children, align = "left" }) => (
  <th className={`px-4 py-3 ${ALIGN[align] || ALIGN.left} text-[10px] font-bold text-slate-700 uppercase tracking-wider`}>
    {children}
  </th>
)

const Stat = ({ label, value, emphasis = false }) => (
  <div className={`rounded-xl border p-4 ${emphasis ? "border-teal-200 bg-teal-50" : "border-slate-200 bg-white"}`}>
    <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</p>
    <p className={`mt-1 text-xl font-bold ${emphasis ? "text-teal-800" : "text-slate-900"}`}>{value}</p>
  </div>
)
