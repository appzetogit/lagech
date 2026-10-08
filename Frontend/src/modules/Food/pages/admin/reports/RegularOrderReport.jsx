import { ClipboardList } from "@food/components/admin/theme/icons"
import OrderMoneyReport from "./OrderMoneyReport"

/** The old panel's Order report: every order with its money, payment method and who received the money. */
export default function RegularOrderReport() {
  return <OrderMoneyReport variant="order" title="Order Report" icon={ClipboardList} />
}
