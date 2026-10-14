import { useState } from "react"
import { Link } from "react-router-dom"
import { toast } from "sonner"
import { Loader2 } from "@food/components/admin/theme/icons"
import { adminAPI } from "@food/api"
import { Panel, Pill, TableBox, errorMessage, formatDateTime, rupees, td, th, titleCase } from "./shared"

/**
 * Business plan: how this store is billed -- commission on the whole order,
 * commission per dish, or a monthly subscription -- and, for subscriptions,
 * the plan and its invoices.
 */

const MODES = [
  ["commission_overall", "Commission", "One commission rate on every order's subtotal."],
  ["commission_dish", "Commission per dish", "Each dish's own rate; dishes without one use the store rate."],
  ["subscription", "Subscription", "A monthly plan instead of a commission on each order."],
]

export default function BusinessPlanTab({ restaurantId, restaurant, analytics, onRestaurantChange }) {
  const [mode, setMode] = useState(restaurant?.billingMode || analytics?.restaurant?.billingMode || "commission_overall")
  const [saving, setSaving] = useState("")
  const sub = analytics?.subscriptionSummary
  const commission = analytics?.analytics?.commissionPercentage

  const choose = async (next) => {
    if (next === mode) return
    setSaving(next)
    try {
      await adminAPI.setRestaurantBillingMode(restaurantId, next)
      setMode(next)
      onRestaurantChange({ billingMode: next })
      toast.success("Business plan changed")
    } catch (err) {
      toast.error(errorMessage(err, "Could not change the business plan"))
    } finally {
      setSaving("")
    }
  }

  return (
    <div className="space-y-4">
      <Panel title="Business plan">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          {MODES.map(([key, label, description]) => {
            const active = key === mode
            return (
              <button
                key={key}
                type="button"
                onClick={() => choose(key)}
                disabled={Boolean(saving)}
                className={`rounded-xl border p-4 text-left transition-colors ${active ? "border-teal-600 bg-teal-50" : "border-slate-200 bg-white hover:border-slate-300"}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-slate-900">{label}</p>
                  {saving === key ? <Loader2 className="w-4 h-4 animate-spin text-teal-600" /> : active && <Pill tone="green">Current</Pill>}
                </div>
                <p className="mt-1 text-xs text-slate-500">{description}</p>
              </button>
            )
          })}
        </div>
        {mode !== "subscription" && (
          <p className="mt-4 text-sm text-slate-700">
            Effective commission: <span className="font-semibold">{commission !== undefined ? `${Number(commission).toFixed(2)}%` : "-"}</span>
            {" · "}
            <Link to="/admin/food/restaurants/commission" className="text-teal-700 hover:underline">Commission setup</Link>
          </p>
        )}
      </Panel>

      <Panel
        title="Subscription"
        actions={
          <Link to="/admin/food/restaurants/subscription-history" className="text-sm font-semibold text-teal-700 hover:underline">
            Subscription history
          </Link>
        }
      >
        {!sub ? (
          <p className="text-xs text-slate-500">Subscription figures could not be loaded.</p>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                ["Plan", sub.planLabel || "-"],
                ["Last cycle fee", rupees(sub.cycleFee)],
                ["Outstanding", rupees(sub.dueAmount)],
                ["Paid so far", rupees(sub.paidAmount)],
              ].map(([label, value]) => (
                <div key={label} className="rounded-lg bg-slate-50 px-3 py-2">
                  <p className="text-[11px] text-slate-500">{label}</p>
                  <p className="text-sm font-semibold text-slate-900">{value}</p>
                </div>
              ))}
            </div>
            <p className="text-xs text-slate-500">
              {sub.statusLabel}
              {sub.lastPayment ? ` · Last payment ${rupees(sub.lastPayment.amount)} on ${formatDateTime(sub.lastPayment.date)}` : ""}
            </p>
            {sub.invoices?.length > 0 ? (
              <div className="-mx-4 sm:-mx-5">
                <TableBox>
                  <thead>
                    <tr>
                      <th className={th}>Month</th>
                      <th className={th}>Plan</th>
                      <th className={th}>Sales</th>
                      <th className={th}>Amount</th>
                      <th className={th}>Paid</th>
                      <th className={th}>Outstanding</th>
                      <th className={th}>Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {sub.invoices.map((inv) => (
                      <tr key={inv.billingMonth}>
                        <td className={`${td} whitespace-nowrap`}>{inv.billingMonthLabel || inv.billingMonth}</td>
                        <td className={td}>{titleCase(inv.planName)}</td>
                        <td className={`${td} whitespace-nowrap`}>{rupees(inv.gmv)}</td>
                        <td className={`${td} whitespace-nowrap`}>{rupees(inv.totalAmount)}</td>
                        <td className={`${td} whitespace-nowrap`}>{rupees(inv.paidAmount)}</td>
                        <td className={`${td} whitespace-nowrap`}>{rupees(inv.outstandingAmount)}</td>
                        <td className={td}>
                          <Pill tone={inv.outstandingAmount > 0 ? "amber" : "green"}>{titleCase(inv.status)}</Pill>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </TableBox>
              </div>
            ) : (
              <p className="text-xs text-slate-500">No subscription invoices for this store.</p>
            )}
          </div>
        )}
      </Panel>
    </div>
  )
}
