import { useState } from "react"
import { Receipt } from "lucide-react"
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

/** GST collected on each restaurant's delivered orders, for filing. */
export default function RestaurantVATReport() {
  const [search, setSearch] = useState("")
  return (
    <ReportShell
      title="Restaurant VAT Report"
      icon={Receipt}
      description="GST collected on each restaurant's delivered orders in the period: on the food (taxable value is food less discount) and on the delivery fee, with the restaurant's GSTIN."
      load={(params) => adminSystemExtrasAPI.getRestaurantVatReport(params)}
      rowsKey="restaurants"
      csvName="restaurant-vat-report"
      filterState={{ search: search || undefined }}
      extraFilters={<SearchFilter onApply={setSearch} />}
      tiles={(d) => [
        ["Orders", d.totals.orders.toLocaleString("en-IN")],
        ["Taxable value", rupees(d.totals.taxable)],
        ["GST on food", rupees(d.totals.foodTax)],
        ["Total GST", rupees(d.totals.totalTax), true],
      ]}
      columns={[
        { key: "restaurant", label: "Restaurant" },
        { key: "gstNumber", label: "GSTIN", render: (r) => r.gstNumber || "—" },
        { key: "orders", label: "Orders", align: "right" },
        { key: "taxable", label: "Taxable value", align: "right", render: (r) => rupees(r.taxable) },
        { key: "foodTax", label: "GST on food", align: "right", render: (r) => rupees(r.foodTax) },
        { key: "deliveryTax", label: "GST on delivery", align: "right", render: (r) => rupees(r.deliveryTax) },
        { key: "totalTax", label: "Total GST", align: "right", render: (r) => <strong>{rupees(r.totalTax)}</strong> },
      ]}
    />
  )
}
