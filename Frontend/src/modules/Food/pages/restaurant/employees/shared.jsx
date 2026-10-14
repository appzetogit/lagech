import { useNavigate } from "react-router-dom"
import { ArrowLeft, Check } from "lucide-react"
import BottomNavOrders from "@food/components/restaurant/BottomNavOrders"
import { RESTAURANT_PERMISSIONS, getRestaurantStaffSession } from "@food/utils/restaurantPermissions"

/** Header + scrolling body, as the other restaurant panel pages. */
export function StaffPage({ eyebrow = "Employees", title, subtitle, back, action, children }) {
  const navigate = useNavigate()
  return (
    <div className="min-h-screen bg-[#e9edf2] flex flex-col md:h-full md:overflow-hidden">
      <div className="sticky top-0 z-40 px-4 py-3 border-b border-[#d5dbe3] bg-[#f2f4f7]/95 backdrop-blur md:static md:px-8 md:pt-7 md:pb-5">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => (back ? navigate(back) : navigate(-1))}
            className="p-1.5 hover:bg-white/80 rounded-xl transition-colors"
            aria-label="Go back"
          >
            <ArrowLeft className="w-6 h-6 text-[#141820]" />
          </button>
          <div className="flex-1 min-w-0">
            <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#5c6775]">{eyebrow}</p>
            <h1 className="text-lg md:text-3xl font-black tracking-tight text-[#141820] truncate">{title}</h1>
            {subtitle ? <p className="hidden md:block mt-1 text-sm text-[#5c6775]">{subtitle}</p> : null}
          </div>
          {action}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-4 pt-4 pb-28 md:px-8 md:pb-8 md:min-h-0">{children}</div>
      <BottomNavOrders />
    </div>
  )
}

export const primaryButton =
  "inline-flex items-center justify-center gap-1.5 rounded-full bg-[#141820] px-4 py-2 text-sm font-semibold text-white hover:bg-black disabled:opacity-60"
export const secondaryButton =
  "inline-flex items-center justify-center gap-1.5 rounded-full border border-[#c8d0da] bg-white px-3 py-2 text-sm font-semibold text-[#141820] hover:bg-[#eef1f5] disabled:opacity-60"
export const inputClass =
  "h-11 w-full rounded-xl border border-[#c8d0da] bg-white px-3 text-sm text-[#141820] outline-none focus:ring-2 focus:ring-[#4f6f9a]/30"

export const permissionLabel = (key) => RESTAURANT_PERMISSIONS.find((p) => p.key === key)?.label || key

/**
 * Tick the sections a role may use. Staff managing staff can only tick what
 * their own role has (the server refuses the rest anyway).
 */
export function PermissionPicker({ value, onChange }) {
  const session = getRestaurantStaffSession()
  const selected = new Set(value)
  const grantable = (key) => !session.isEmployee || session.permissions.includes(key)
  const toggle = (key) => {
    const next = new Set(selected)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    onChange(RESTAURANT_PERMISSIONS.map((p) => p.key).filter((k) => next.has(k)))
  }
  const allKeys = RESTAURANT_PERMISSIONS.map((p) => p.key).filter(grantable)
  const allOn = allKeys.every((k) => selected.has(k))

  return (
    <div>
      <div className="flex items-center justify-between gap-2 mb-3">
        <p className="text-sm font-bold text-[#141820]">Module permissions</p>
        <button
          type="button"
          onClick={() => onChange(allOn ? [] : allKeys)}
          className="text-xs font-semibold text-[#4f6f9a] hover:underline"
        >
          {allOn ? "Clear all" : "Select all"}
        </button>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {RESTAURANT_PERMISSIONS.map((p) => {
          const on = selected.has(p.key)
          const allowed = grantable(p.key)
          return (
            <button
              key={p.key}
              type="button"
              disabled={!allowed}
              onClick={() => toggle(p.key)}
              className={`flex items-start gap-3 rounded-xl border p-3 text-left transition-colors ${
                on ? "border-[#4f6f9a] bg-[#eef3f9]" : "border-[#d6dce4] bg-white hover:bg-[#f6f8fa]"
              } ${allowed ? "" : "opacity-50 cursor-not-allowed"}`}
            >
              <span
                className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border ${
                  on ? "border-[#4f6f9a] bg-[#4f6f9a] text-white" : "border-[#c8d0da] bg-white"
                }`}
              >
                {on ? <Check className="h-3.5 w-3.5" /> : null}
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-[#141820]">{p.label}</span>
                <span className="block text-xs text-[#5c6775]">{p.hint}</span>
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
