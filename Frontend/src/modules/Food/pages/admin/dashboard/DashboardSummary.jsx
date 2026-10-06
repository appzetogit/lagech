import { useEffect, useState } from "react"
import { useNavigate } from "react-router-dom"
import { adminAPI } from "@food/api"

const ICONS = "/admin-theme/dashboard"

const PERIODS = [
  ["overall", "Overall"],
  ["year", "This Year"],
  ["month", "This Month"],
  ["week", "This Week"],
  ["today", "Today"],
]

const TOTALS = [
  ["foods", "Foods", "items.svg", "/admin/food/foods"],
  ["orders", "Orders", "orders.svg", "/admin/food/orders/all"],
  ["restaurants", "Restaurants", "stores.svg", "/admin/food/restaurants"],
  ["customers", "Customers", "customers.svg", "/admin/food/customers"],
]

// Tile, label, icon, count colour, where it leads — as on the old dashboard.
const TILES = [
  ["unassigned", "Unassigned Orders", "unassigned.svg", "text-[#334257]", "/admin/food/dispatch"],
  ["acceptedByRider", "Accepted By Delivery Man", "accepted.svg", "text-[#00aa6d]", "/admin/food/orders/processing"],
  ["cooking", "Cooking", "packaging.svg", "text-[#334257]", "/admin/food/orders/processing"],
  ["outForDelivery", "Out For Delivery", "out-for.svg", "text-[#00aa6d]", "/admin/food/orders/food-on-the-way"],
  ["delivered", "Delivered", "delivered.svg", "text-[#00aa6d]", "/admin/food/orders/delivered"],
  ["canceled", "Canceled", "canceled.svg", "text-[#ff6d6d]", "/admin/food/orders/canceled"],
  ["refunded", "Refunded", "refunded.svg", "text-[#ff6d6d]", "/admin/food/orders/refunded"],
  ["paymentFailed", "Payment Failed", "payment-failed.svg", "text-[#ff6d6d]", "/admin/food/orders/payment-failed"],
]

const fmt = (n) => Number(n || 0).toLocaleString("en-IN")

/**
 * The top of the old panel's food dashboard: period tabs, four totals with how
 * many are new, and eight order-state tiles. Data from /dashboard-insights.
 */
export default function DashboardSummary({ zoneId, period, onPeriodChange }) {
  const navigate = useNavigate()
  const [summary, setSummary] = useState(null)

  useEffect(() => {
    let cancelled = false
    adminAPI
      .getDashboardInsights({ period: period === "overall" ? "all" : period, ...(zoneId && zoneId !== "all" ? { zoneId } : {}) })
      .then((res) => {
        if (!cancelled) setSummary(res?.data?.data?.summary || null)
      })
      .catch(() => {
        if (!cancelled) setSummary(null)
      })
    return () => {
      cancelled = true
    }
  }, [zoneId, period])

  const newLabel = period === "overall" ? "in the last 30 days" : "newly added"

  return (
    <div className="rounded-xl border border-[#E7EAF3] bg-white p-5 shadow-[0_6px_12px_rgba(140,152,164,0.075)]">
      <div className="mb-5 flex justify-end">
        <div className="inline-flex flex-wrap rounded-[5px] border border-[#107980]/40">
          {PERIODS.map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => onPeriodChange(key)}
              className={`px-4 py-2 text-[13px] font-medium transition-colors ${
                period === key ? "bg-[#107980] text-white" : "text-[#107980] hover:bg-[#107980]/5"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {TOTALS.map(([key, label, icon, path]) => {
          const item = summary?.totals?.[key]
          return (
            <button
              key={key}
              type="button"
              onClick={() => navigate(path)}
              className="flex flex-col items-center rounded-xl border border-[#E7EAF3] bg-white px-4 py-6 text-center shadow-[0_6px_12px_rgba(140,152,164,0.075)] transition-shadow hover:shadow-md"
            >
              <img src={`${ICONS}/${icon}`} alt="" className="h-10 w-10" />
              <span className="mt-3 text-sm font-medium text-[#334257]">{label}</span>
              <span className="mt-1 text-[28px] font-bold leading-tight text-[#334257]">{item ? fmt(item.total) : "–"}</span>
              <span className="mt-1 text-[13px] text-[#677788]">
                {item ? `${fmt(item.new)} ${newLabel}` : " "}
              </span>
            </button>
          )
        })}
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {TILES.map(([key, label, icon, colour, path]) => (
          <button
            key={key}
            type="button"
            onClick={() => navigate(path)}
            className="flex items-center justify-between gap-3 rounded-xl bg-[#F9FAFC] px-5 py-4 text-left transition-colors hover:bg-[#F3F4F8]"
          >
            <span className="flex items-center gap-3">
              <img src={`${ICONS}/${icon}`} alt="" className="h-7 w-7" />
              <span className="text-[15px] font-semibold text-[#334257]">{label}</span>
            </span>
            <span className={`text-xl font-bold ${colour}`}>{summary ? fmt(summary.tiles?.[key]) : "–"}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
