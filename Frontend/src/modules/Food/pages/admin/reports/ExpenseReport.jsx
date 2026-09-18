import { Receipt } from "lucide-react"
import { adminAPI } from "@food/api"
import ReportShell, { rupees } from "./ReportShell"

const when = (d) =>
  new Date(d).toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })

/** What the platform paid out of its own pocket on delivered orders. */
export default function ExpenseReport() {
  return (
    <ReportShell
      title="Expense Report"
      icon={Receipt}
      description="What the platform paid from its own earnings: its share of discounts (a restaurant discount also lowers the commission earned), delivery it paid the rider for when the customer paid less, cashback credited to customers, and rider bonuses."
      load={(params) => adminAPI.getExpenseReport(params)}
      rowsKey="expenses"
      csvName="expense-report"
      tiles={(d) => [
        ["Discounts borne", rupees(d.totals.discount)],
        ["Free delivery paid", rupees(d.totals.freeDelivery)],
        ["Cashback + rider bonuses", rupees(d.totals.cashback + d.totals.riderBonuses)],
        ["Total expenses", rupees(d.totals.total), true],
      ]}
      columns={[
        { key: "orderId", label: "Order" },
        { key: "restaurant", label: "Restaurant" },
        { key: "createdAt", label: "Date", render: (r) => when(r.createdAt), csv: (r) => when(r.createdAt) },
        { key: "discount", label: "Discount share", align: "right", render: (r) => rupees(r.discount) },
        { key: "freeDelivery", label: "Free delivery", align: "right", render: (r) => rupees(r.freeDelivery) },
        { key: "cashback", label: "Cashback", align: "right", render: (r) => rupees(r.cashback) },
        { key: "total", label: "Total", align: "right", render: (r) => <strong>{rupees(r.total)}</strong> },
      ]}
    />
  )
}
