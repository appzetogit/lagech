import { TrendingUp } from "lucide-react"
import { adminAPI } from "@food/api"
import ReportShell, { rupees } from "./ReportShell"

/** The platform's own earnings, day by day. */
export default function AdminEarningReport() {
  return (
    <ReportShell
      title="Admin Earning Report"
      icon={TrendingUp}
      description="What the platform earned each day on delivered orders: commission on food, its cut of the delivery fee and any platform fee, less the expenses it paid. GST collected is shown separately: it is owed to the government, not earned."
      load={(params) => adminAPI.getAdminEarningReport(params)}
      rowsKey="days"
      csvName="admin-earnings"
      tiles={(d) => [
        ["Orders", d.totals.orders.toLocaleString("en-IN")],
        ["Earned", rupees(d.totals.earned)],
        ["Expenses", rupees(d.totals.expenses)],
        ["Net earnings", rupees(d.totals.net), true],
      ]}
      columns={[
        { key: "day", label: "Day" },
        { key: "orders", label: "Orders", align: "right" },
        { key: "sales", label: "Sales", align: "right", render: (r) => rupees(r.sales) },
        { key: "commission", label: "Commission", align: "right", render: (r) => rupees(r.commission) },
        { key: "deliveryCut", label: "Delivery cut", align: "right", render: (r) => rupees(r.deliveryCut) },
        { key: "platformFee", label: "Platform fee", align: "right", render: (r) => rupees(r.platformFee) },
        { key: "expenses", label: "Expenses", align: "right", render: (r) => rupees(r.expenses) },
        { key: "net", label: "Net", align: "right", render: (r) => <strong>{rupees(r.net)}</strong> },
        { key: "gst", label: "GST collected", align: "right", render: (r) => rupees(r.gst) },
      ]}
    />
  )
}
