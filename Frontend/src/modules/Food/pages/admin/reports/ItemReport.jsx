import { useState } from "react"
import { UtensilsCrossed } from "lucide-react"
import { adminAPI } from "@food/api"
import ReportShell, { rupees } from "./ReportShell"

/** What sold: each dish, how many and for how much. */
export default function ItemReport() {
  const [search, setSearch] = useState("")
  const [applied, setApplied] = useState("")
  const [sort, setSort] = useState("sales")
  return (
    <ReportShell
      title="Item Report"
      icon={UtensilsCrossed}
      description="Every dish sold on delivered orders in the period, with the quantity and what it took in."
      load={(params) => adminAPI.getItemReport(params)}
      rowsKey="items"
      csvName="item-report"
      filterState={{ search: applied || undefined, sort }}
      extraFilters={
        <>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              setApplied(search.trim())
            }}
            className="space-y-1"
          >
            <span className="block text-[11px] font-semibold uppercase tracking-wide text-slate-500">Dish</span>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onBlur={() => setApplied(search.trim())}
              placeholder="Search dish"
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm bg-white"
            />
          </form>
          <label className="space-y-1">
            <span className="block text-[11px] font-semibold uppercase tracking-wide text-slate-500">Sort by</span>
            <select value={sort} onChange={(e) => setSort(e.target.value)} className="rounded-lg border border-slate-300 px-3 py-2 text-sm bg-white">
              <option value="sales">Takings</option>
              <option value="quantity">Quantity</option>
            </select>
          </label>
        </>
      }
      tiles={(d) => [
        ["Dishes sold", d.totals.items.toLocaleString("en-IN")],
        ["Quantity", d.totals.quantity.toLocaleString("en-IN")],
        ["Takings", rupees(d.totals.sales), true],
      ]}
      columns={[
        { key: "name", label: "Dish" },
        { key: "restaurant", label: "Restaurant" },
        { key: "quantity", label: "Quantity", align: "right" },
        { key: "orders", label: "Orders", align: "right" },
        { key: "averagePrice", label: "Avg price", align: "right", render: (r) => rupees(r.averagePrice) },
        { key: "sales", label: "Takings", align: "right", render: (r) => <strong>{rupees(r.sales)}</strong> },
      ]}
    />
  )
}
