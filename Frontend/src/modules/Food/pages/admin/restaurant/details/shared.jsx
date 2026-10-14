import { ChevronLeft, ChevronRight, Loader2 } from "@food/components/admin/theme/icons"
import { resolveMediaUrl } from "../../../../../../shared/utils/mediaUrl.js"

/**
 * Building blocks for the restaurant details page tabs: cards, an empty
 * state, a table box that scrolls sideways inside its card on phones, and a
 * pager.
 */

export const errorMessage = (err, fallback) => err?.response?.data?.message || err?.message || fallback

export const rupees = (value) =>
  `₹${Number(value || 0).toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`

export const formatDate = (value) =>
  value ? new Date(value).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "-"

export const formatDateTime = (value) =>
  value ? new Date(value).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "-"

export const mediaUrl = (value) => resolveMediaUrl(value) || ""

export const newRequestKey = () =>
  typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`

export const titleCase = (value) =>
  String(value || "")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim()

export function Panel({ title, icon: Icon, actions, children, className = "", bodyClassName = "p-4 sm:p-5" }) {
  return (
    <section className={`min-w-0 bg-white rounded-xl border border-slate-200 shadow-sm ${className}`}>
      {(title || actions) && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3 sm:px-5">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-800">
            {Icon && <Icon className="w-4 h-4 text-slate-500" />}
            {title}
          </h2>
          {actions}
        </div>
      )}
      <div className={bodyClassName}>{children}</div>
    </section>
  )
}

export function Spinner({ className = "py-12" }) {
  return (
    <div className={`flex justify-center ${className}`}>
      <Loader2 className="w-6 h-6 animate-spin text-teal-600" />
    </div>
  )
}

export function EmptyState({ title = "No data found", children }) {
  return (
    <div className="py-12 px-4 text-center">
      <p className="text-sm font-semibold text-slate-700">{title}</p>
      {children && <div className="mt-1 text-xs text-slate-500 max-w-md mx-auto">{children}</div>}
    </div>
  )
}

export function ErrorState({ message, onRetry }) {
  return (
    <div className="py-10 px-4 text-center">
      <p className="text-sm text-rose-600">{message}</p>
      {onRetry && (
        <button type="button" onClick={onRetry} className="mt-3 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50">
          Try again
        </button>
      )}
    </div>
  )
}

/**
 * A table that scrolls sideways inside its card. The overflow is set inline,
 * not with `overflow-x-auto`: AdminLayout sizes every `.overflow-x-auto > table`
 * box to the bottom of the screen, which is right for a list page and wrong
 * for a table under a tab strip.
 */
export function TableBox({ children }) {
  return (
    <div className="w-full max-w-full" style={{ overflowX: "auto" }}>
      <table className="w-full min-w-[640px] text-sm">{children}</table>
    </div>
  )
}

export const th = "px-4 py-3 text-left text-[11px] font-bold uppercase tracking-wider text-slate-600 bg-slate-50 whitespace-nowrap"
export const td = "px-4 py-3 align-middle text-slate-700"

export function Pager({ page, pages, onPage }) {
  if (!pages || pages <= 1) return null
  return (
    <div className="flex items-center justify-between gap-3 border-t border-slate-100 px-4 py-3 text-xs text-slate-600">
      <span>
        Page {page} of {pages}
      </span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
          className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1.5 disabled:opacity-50 hover:bg-slate-50"
        >
          <ChevronLeft className="w-3.5 h-3.5" /> Prev
        </button>
        <button
          type="button"
          disabled={page >= pages}
          onClick={() => onPage(page + 1)}
          className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1.5 disabled:opacity-50 hover:bg-slate-50"
        >
          Next <ChevronRight className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  )
}

const PILL = {
  green: "bg-emerald-50 text-emerald-700",
  amber: "bg-amber-50 text-amber-700",
  red: "bg-rose-50 text-rose-700",
  blue: "bg-sky-50 text-sky-700",
  slate: "bg-slate-100 text-slate-600",
}

export function Pill({ tone = "slate", children }) {
  return (
    <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${PILL[tone] || PILL.slate}`}>
      {children}
    </span>
  )
}

export function Toggle({ checked, onChange, disabled = false, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={Boolean(checked)}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${checked ? "bg-teal-600" : "bg-slate-300"} ${disabled ? "opacity-50 cursor-not-allowed" : ""}`}
    >
      <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${checked ? "translate-x-5" : "translate-x-0.5"}`} />
    </button>
  )
}

/** The `{ data: { data } }` envelope every admin endpoint answers with. */
export const payload = (res) => res?.data?.data ?? {}
