import { useEffect, useRef, useState } from "react"
import { ChevronLeft, ChevronRight, Loader2, Search, X } from "@food/components/admin/theme/icons"
import { customerExtrasAPI, dataOf, formatMoney } from "@food/api/adminCustomerExtras"

export const inputClass =
  "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500"

const customerText = (c) => [c.name || "Unnamed customer", c.phone].filter(Boolean).join(" · ")

/**
 * Search a customer by name, phone or email and pick one. `value` is the
 * picked customer object (or null); `onChange` receives the customer or null.
 */
export function CustomerPicker({ value, onChange, placeholder = "Search by name, phone or email", showBalance = false }) {
  const [query, setQuery] = useState("")
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [results, setResults] = useState([])
  const box = useRef(null)

  useEffect(() => {
    if (!open) return undefined
    const timer = setTimeout(async () => {
      try {
        setLoading(true)
        const res = await customerExtrasAPI.searchCustomers(query.trim())
        setResults(dataOf(res).customers || [])
      } catch {
        setResults([])
      } finally {
        setLoading(false)
      }
    }, 250)
    return () => clearTimeout(timer)
  }, [query, open])

  useEffect(() => {
    const close = (e) => {
      if (box.current && !box.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener("mousedown", close)
    return () => document.removeEventListener("mousedown", close)
  }, [])

  if (value) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm">
        <span className="truncate text-slate-800">
          {customerText(value)}
          {showBalance && <span className="ml-2 text-xs text-slate-500">Wallet {formatMoney(value.walletBalance)}</span>}
        </span>
        <button type="button" onClick={() => onChange(null)} className="text-slate-500 hover:text-slate-800" aria-label="Clear customer">
          <X className="h-4 w-4" />
        </button>
      </div>
    )
  }

  return (
    <div className="relative" ref={box}>
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <input
          className={`${inputClass} pl-9`}
          value={query}
          placeholder={placeholder}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setQuery(e.target.value)
            setOpen(true)
          }}
        />
      </div>
      {open && (
        <div className="absolute z-20 mt-1 max-h-72 w-full overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-lg">
          {loading ? (
            <div className="flex justify-center py-4"><Loader2 className="h-4 w-4 animate-spin text-slate-400" /></div>
          ) : !results.length ? (
            <p className="px-3 py-3 text-sm text-slate-500">{query.trim() ? "No customer matches that search." : "No customers yet."}</p>
          ) : (
            results.map((c) => (
              <button
                type="button"
                key={c.id}
                onClick={() => {
                  onChange(c)
                  setOpen(false)
                  setQuery("")
                }}
                className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-slate-50"
              >
                <span className="min-w-0">
                  <span className="block truncate font-medium text-slate-800">{c.name || "Unnamed customer"}</span>
                  <span className="block truncate text-xs text-slate-500">{[c.phone, c.email].filter(Boolean).join(" · ")}</span>
                </span>
                {showBalance && <span className="shrink-0 text-xs text-slate-500">{formatMoney(c.walletBalance)}</span>}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}

export function Pager({ pagination, onPage }) {
  if (!pagination || pagination.pages <= 1) return null
  const { page, pages, total } = pagination
  return (
    <div className="flex items-center justify-between gap-3 border-t border-slate-200 px-4 py-3 text-sm text-slate-600">
      <span>{total} in total · page {page} of {pages}</span>
      <div className="flex gap-2">
        <button type="button" disabled={page <= 1} onClick={() => onPage(page - 1)} className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-3 py-1.5 disabled:opacity-40">
          <ChevronLeft className="h-4 w-4" /> Previous
        </button>
        <button type="button" disabled={page >= pages} onClick={() => onPage(page + 1)} className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-3 py-1.5 disabled:opacity-40">
          Next <ChevronRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}

export function StatCard({ label, value, hint, tone = "slate" }) {
  const tones = {
    slate: "text-slate-900",
    green: "text-emerald-700",
    red: "text-rose-700",
    blue: "text-blue-700",
  }
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <p className="text-xs font-semibold text-slate-500">{label}</p>
      <p className={`mt-1 text-2xl font-bold ${tones[tone] || tones.slate}`}>{value}</p>
      {hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
    </div>
  )
}

export function PageHeader({ icon: Icon, title, description, children }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <div>
        <div className="flex items-center gap-3">
          {Icon && <Icon className="h-5 w-5 text-blue-600" />}
          <h1 className="text-2xl font-bold text-slate-900">{title}</h1>
        </div>
        {description && <p className="mt-1 text-sm text-slate-600">{description}</p>}
      </div>
      {children}
    </div>
  )
}
