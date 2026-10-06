import { useEffect, useState } from "react"
import { Bike } from "@food/components/admin/theme/icons"
import { adminRiderExtrasAPI } from "@food/api/adminRiderExtras"
import ReportShell, { rupees } from "./ReportShell"

/** What each delivery man earned in a period. */
export default function DeliverymanEarningReport() {
  const [search, setSearch] = useState("")
  const [applied, setApplied] = useState("")

  useEffect(() => {
    const timer = setTimeout(() => setApplied(search.trim()), 400)
    return () => clearTimeout(timer)
  }, [search])

  return (
    <ReportShell
      title="Deliveryman Earning Report"
      icon={Bike}
      description="Each delivery man's delivered orders in the period, by the day they were delivered: their pay for those orders, bonuses given to them in the period, and the cash they collected from customers. Bonuses are not tied to a restaurant, so choosing a restaurant narrows the deliveries but not the bonuses."
      load={(params) => adminRiderExtrasAPI.getEarningReport(params)}
      rowsKey="riders"
      csvName="deliveryman-earnings"
      filterState={{ search: applied || undefined }}
      extraFilters={
        <label className="space-y-1">
          <span className="block text-[11px] font-semibold uppercase tracking-wide text-slate-500">Delivery man</span>
          <input
            type="search"
            placeholder="Name or phone"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm bg-white"
          />
        </label>
      }
      tiles={(d) => [
        ["Deliveries", d.totals.deliveries.toLocaleString("en-IN")],
        ["Delivery earnings", rupees(d.totals.earning)],
        ["Bonuses", rupees(d.totals.bonus)],
        ["Total earned", rupees(d.totals.total), true],
      ]}
      columns={[
        { key: "name", label: "Delivery man" },
        { key: "phone", label: "Phone" },
        { key: "deliveries", label: "Deliveries", align: "right" },
        { key: "earning", label: "Delivery earnings", align: "right", render: (r) => rupees(r.earning) },
        { key: "averagePerDelivery", label: "Per delivery", align: "right", render: (r) => rupees(r.averagePerDelivery) },
        { key: "bonus", label: "Bonuses", align: "right", render: (r) => rupees(r.bonus) },
        { key: "total", label: "Total earned", align: "right", render: (r) => <strong>{rupees(r.total)}</strong> },
        { key: "codCollected", label: "Cash collected", align: "right", render: (r) => rupees(r.codCollected) },
      ]}
    />
  )
}
