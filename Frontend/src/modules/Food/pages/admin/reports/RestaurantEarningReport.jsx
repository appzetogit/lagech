import { useState } from "react"
import { Store } from "@food/components/admin/theme/icons"
import { adminSystemExtrasAPI } from "@food/api/adminSystemExtras"
import ReportShell, { rupees } from "./ReportShell"

function SearchFilter({ onApply }) {
  const [value, setValue] = useState("")
  return (
    <form onSubmit={(e) => { e.preventDefault(); onApply(value.trim()) }} className="space-y-1">
      <span className="block text-[11px] font-semibold uppercase tracking-wide text-slate-500">Name</span>
      <input value={value} onChange={(e) => setValue(e.target.value)} onBlur={() => onApply(value.trim())} placeholder="Search restaurant" className="rounded-lg border border-slate-300 px-3 py-2 text-sm bg-white" />
    </form>
  )
}

/** What each restaurant earned in the period, what it was paid and what it is still owed. */
export default function RestaurantEarningReport() {
  const [search, setSearch] = useState("")
  return (
    <ReportShell
      title="Restaurant Earning Report"
      icon={Store}
      description="Per restaurant, on delivered orders in the period: food sales, the platform's commission and what the restaurant keeps. Paid out counts payments made in the period; pending payouts and balance are as of now."
      load={(params) => adminSystemExtrasAPI.getRestaurantEarningReport(params)}
      rowsKey="restaurants"
      csvName="restaurant-earning-report"
      filterState={{ search: search || undefined }}
      extraFilters={<SearchFilter onApply={setSearch} />}
      tiles={(d) => [
        ["Orders", d.totals.orders.toLocaleString("en-IN")],
        ["Food sales", rupees(d.totals.grossSales)],
        ["Commission", rupees(d.totals.commission)],
        ["Restaurants' share", rupees(d.totals.net), true],
      ]}
      columns={[
        { key: "restaurant", label: "Restaurant" },
        { key: "orders", label: "Orders", align: "right" },
        { key: "grossSales", label: "Food sales", align: "right", render: (r) => rupees(r.grossSales) },
        { key: "commission", label: "Commission", align: "right", render: (r) => rupees(r.commission) },
        { key: "net", label: "Restaurant share", align: "right", render: (r) => <strong>{rupees(r.net)}</strong> },
        { key: "paidOut", label: "Paid out", align: "right", render: (r) => rupees(r.paidOut) },
        { key: "pendingPayout", label: "Pending payouts", align: "right", render: (r) => rupees(r.pendingPayout) },
        { key: "balance", label: "Balance now", align: "right", render: (r) => rupees(r.balance) },
      ]}
    />
  )
}
