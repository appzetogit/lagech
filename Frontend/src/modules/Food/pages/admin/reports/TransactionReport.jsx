import { Receipt } from "@food/components/admin/theme/icons"
import OrderMoneyReport from "./OrderMoneyReport"

/** The old panel's Transaction report: money per delivered order, from the ledger. */
export default function TransactionReport() {
  return <OrderMoneyReport variant="transaction" title="Transaction Report" icon={Receipt} />
}
