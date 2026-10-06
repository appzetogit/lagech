import { useSearchParams } from "react-router-dom"
import { Settings } from "@food/components/admin/theme/icons"
import { PageFrame } from "../../system/SettingsUi"
import {
  BusinessInfoTab,
  DeliverymanTab,
  OrderTab,
  VendorTab,
  CustomerTab,
  PaymentTab,
  RefundTab,
  PriorityTab,
  DisbursementTab,
  AutomatedMessageTab,
} from "./tabs"

/**
 * The old panel's Business Settings, one tab per area. Each tab loads and
 * saves its own settings document (GET/PUT /food/admin/system-settings/business_*),
 * so saving one tab never overwrites another. The open tab is in the URL
 * (?tab=order), so a link can open it directly.
 */
const TABS = [
  { key: "business", label: "Business Info" },
  { key: "deliveryman", label: "Deliveryman" },
  { key: "order", label: "Order" },
  { key: "vendor", label: "Vendor" },
  { key: "customer", label: "Customer" },
  { key: "payment", label: "Payment" },
  { key: "refund", label: "Refund" },
  { key: "priority", label: "Priority Setup" },
  { key: "disbursement", label: "Disbursement" },
  { key: "automated-message", label: "Automated Message" },
]

export default function BusinessSettingsTabs({ companyInfo }) {
  const [params, setParams] = useSearchParams()
  const active = TABS.some((t) => t.key === params.get("tab")) ? params.get("tab") : "business"
  const open = (key) => {
    const next = new URLSearchParams(params)
    next.set("tab", key)
    setParams(next, { replace: true })
  }

  return (
    <PageFrame
      icon={Settings}
      title="Business Settings"
      description="Company information and the rules the apps and the server follow. Settings marked “Saved, not yet applied” are kept and published to the apps, but the server does not enforce them yet."
    >
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 px-2 overflow-x-auto">
        <nav className="flex gap-1 min-w-max" role="tablist">
          {TABS.map((tab) => (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={active === tab.key}
              onClick={() => open(tab.key)}
              className={`px-3 py-3 text-sm font-medium border-b-2 transition-colors ${
                active === tab.key ? "border-blue-600 text-blue-700" : "border-transparent text-slate-600 hover:text-slate-900"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </div>

      {active === "business" && <BusinessInfoTab companyInfo={companyInfo} />}
      {active === "deliveryman" && <DeliverymanTab />}
      {active === "order" && <OrderTab />}
      {active === "vendor" && <VendorTab />}
      {active === "customer" && <CustomerTab />}
      {active === "payment" && <PaymentTab />}
      {active === "refund" && <RefundTab />}
      {active === "priority" && <PriorityTab />}
      {active === "disbursement" && <DisbursementTab />}
      {active === "automated-message" && <AutomatedMessageTab />}
    </PageFrame>
  )
}
