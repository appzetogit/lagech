import { Link } from "react-router-dom"

/** Bits both tabs of the Disbursement Report share. */

export const isoDay = (date) => {
  const d = new Date(date)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

export const daysAgo = (n) => {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return isoDay(d)
}

export const DISBURSEMENT_TABS = [
  { key: "restaurant", label: "Restaurants", path: "/admin/food/disbursement-report/restaurants" },
  { key: "rider", label: "Delivery men", path: "/admin/food/disbursement-report/deliverymen" },
]

export function DisbursementTabs({ active }) {
  return (
    <div className="mt-4 flex gap-1 border-b border-slate-200">
      {DISBURSEMENT_TABS.map((tab) => (
        <Link
          key={tab.key}
          to={tab.path}
          className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${tab.key === active ? "border-blue-600 text-blue-700" : "border-transparent text-slate-500 hover:text-slate-800"}`}
        >
          {tab.label}
        </Link>
      ))}
    </div>
  )
}
