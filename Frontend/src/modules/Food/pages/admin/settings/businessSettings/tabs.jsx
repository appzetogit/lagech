import { useEffect, useState } from "react"
import { toast } from "sonner"
import apiClient from "@food/api/axios"
import { Card, Field, inputClass, setIn, useSettingsArea, errorMessage, SaveButton, Loading } from "../../system/SettingsUi"
import { SwitchRow, NumberField, RelatedLinks, SaveBar, AreaGate, ReasonListEditor, NotApplied } from "./ui"

/**
 * One component per Business Settings tab. Shapes, defaults and validation
 * live in Backend businessSettings.defaults.js; what each switch does is
 * described next to it, and anything the server does not enforce yet says so.
 */

const useArea = (key) => {
  const area = useSettingsArea(key)
  const set = (path, next) => area.setValue((v) => setIn(v, Array.isArray(path) ? path : [path], next))
  return { ...area, set }
}

const L = (to, label, hint) => ({ to: `/admin/food/${to}`, label, hint })

// ─── Business Info ───────────────────────────────────────────────────────────

export function BusinessInfoTab({ companyInfo }) {
  const area = useArea("business_info")
  const website = useArea("website")
  const v = area.value
  return (
    <>
      {companyInfo}
      <AreaGate area={area}>
        {v && (
          <Card title="Business model and commission" description="Used when orders are priced and settled.">
            <SwitchRow
              label="Commission business model"
              hint="Restaurants pay a commission on each order."
              checked={v.commissionModel}
              onChange={(x) => area.set("commissionModel", x)}
            />
            <SwitchRow
              label="Subscription business model"
              hint="Each restaurant's billing mode (commission or subscription) is set on the restaurant; plans are under Subscription settings."
              checked={v.subscriptionModel}
              onChange={(x) => area.set("subscriptionModel", x)}
              notApplied
            />
            <div className="grid gap-4 sm:grid-cols-2 mt-4">
              <NumberField
                label="Default commission on order (%)"
                hint="Charged to restaurants with no commission of their own (Restaurant commission page). Needs the commission model on."
                value={v.defaultCommissionPercent}
                onChange={(x) => area.set("defaultCommissionPercent", x)}
                max={100}
                step="0.01"
                suffix="%"
              />
              <NumberField
                label="Commission on delivery charge (%)"
                hint="The platform's share of the delivery fee when riders are paid a percentage (below)."
                value={v.deliveryChargeCommissionPercent}
                onChange={(x) => area.set("deliveryChargeCommissionPercent", x)}
                max={100}
                step="0.01"
                suffix="%"
              />
              <Field label="How riders are paid" hint="Distance bands: the rider pay set on each delivery fee band (default). Percentage: the delivery fee less the commission above. Applies to new orders.">
                <select className={inputClass} value={v.riderPayMode} onChange={(e) => area.set("riderPayMode", e.target.value)}>
                  <option value="bands">Distance bands (Fee settings)</option>
                  <option value="percentage">Percentage of the delivery fee</option>
                </select>
              </Field>
              <Field label="Currency" hint="Fixed to Indian rupees.">
                <input className={`${inputClass} bg-slate-50`} value="INR (₹)" disabled />
              </Field>
              <NumberField
                label="Decimals in prices"
                hint="Published to the apps for showing prices."
                value={v.currencyDecimals}
                onChange={(x) => area.set("currencyDecimals", x)}
                max={2}
              />
            </div>
            <div className="mt-4">
              <SwitchRow
                label="Additional charge"
                hint="An extra charge per order, such as a service charge."
                checked={v.additionalCharge?.enabled}
                onChange={(x) => area.set(["additionalCharge", "enabled"], x)}
                notApplied
              />
              {v.additionalCharge?.enabled && (
                <div className="grid gap-4 sm:grid-cols-2 mt-2">
                  <Field label="Charge name">
                    <input className={inputClass} maxLength={60} value={v.additionalCharge.name} onChange={(e) => area.set(["additionalCharge", "name"], e.target.value)} />
                  </Field>
                  <NumberField label="Amount (₹)" value={v.additionalCharge.amount} onChange={(x) => area.set(["additionalCharge", "amount"], x)} step="0.01" />
                </div>
              )}
            </div>
            <div className="mt-4">
              <SaveBar saving={area.saving} onSave={() => area.save()} updatedAt={area.updatedAt} />
            </div>
          </Card>
        )}
      </AreaGate>
      <AreaGate area={website}>
        {website.value && (
          <Card title="Maintenance mode" description="Pauses ordering in the customer app and on the website; the admin and restaurant panels keep working. The same switch as on the Website page.">
            <SwitchRow
              label="Maintenance mode"
              hint="New orders are refused with the message below. Published to the apps as business.maintenance."
              checked={website.value.maintenanceMode}
              onChange={(x) => website.set("maintenanceMode", x)}
            />
            <Field label="Message shown to customers" className="mt-3">
              <textarea className={inputClass} rows={2} maxLength={500} value={website.value.maintenanceMessage} onChange={(e) => website.set("maintenanceMessage", e.target.value)} />
            </Field>
            <div className="mt-4">
              <SaveBar saving={website.saving} onSave={() => website.save()} updatedAt={website.updatedAt} />
            </div>
          </Card>
        )}
      </AreaGate>
      <RelatedLinks
        links={[
          L("restaurants/commission", "Restaurant commission", "Per-restaurant rates"),
          L("fee-settings", "Fee settings", "Delivery fee bands, rider pay per band, GST, platform fee"),
          L("restaurants/subscription-settings", "Subscription settings"),
        ]}
      />
    </>
  )
}

// ─── Deliveryman ─────────────────────────────────────────────────────────────

export function DeliverymanTab() {
  const area = useArea("business_deliveryman")
  const v = area.value
  return (
    <>
      <AreaGate area={area}>
        {v && (
          <Card title="Deliveryman">
            <div className="grid gap-4 sm:grid-cols-2 mb-2">
              <NumberField
                label="Maximum assigned order limit"
                hint="Deliveries a rider may hold at once. Dispatch stops offering orders to a rider at the limit, and accepting another is refused. 1 = one order at a time."
                value={v.maxAssignedOrders}
                onChange={(x) => area.set("maxAssignedOrders", x)}
                min={1}
                max={10}
              />
            </div>
            <SwitchRow
              label="Deliveryman can cancel order"
              hint="Published to the rider app to show a cancel button. Releasing an order before pickup works as before either way."
              checked={v.riderCanCancelOrder}
              onChange={(x) => area.set("riderCanCancelOrder", x)}
              notApplied="Rider app only"
            />
            <SwitchRow label="Tips for deliveryman" hint="Let customers add a tip." checked={v.tipsEnabled} onChange={(x) => area.set("tipsEnabled", x)} notApplied />
            <SwitchRow label="Show earning to deliveryman" hint="The rider app shows the earning on each offer." checked={v.showEarningToRider} onChange={(x) => area.set("showEarningToRider", x)} notApplied="Rider app only" />
            <SwitchRow label="Deliveryman picture upload" hint="Riders upload a delivery photo." checked={v.riderPictureUpload} onChange={(x) => area.set("riderPictureUpload", x)} notApplied="Rider app only" />
            <SwitchRow label="Deliveryman self registration" hint="Riders can sign up from the app." checked={v.riderSelfRegistration} onChange={(x) => area.set("riderSelfRegistration", x)} notApplied />
            <div className="mt-4">
              <SaveBar saving={area.saving} onSave={() => area.save()} updatedAt={area.updatedAt} />
            </div>
          </Card>
        )}
      </AreaGate>
      <RelatedLinks
        links={[
          L("delivery-cash-limit", "Cash in hand limit", "Maximum cash a rider may carry, and the minimum they deposit"),
          L("delivery-boy-commission", "Delivery boy commission"),
        ]}
      />
    </>
  )
}

// ─── Order ───────────────────────────────────────────────────────────────────

export function OrderTab() {
  const area = useArea("business_order")
  const v = area.value
  return (
    <>
      <AreaGate area={area}>
        {v && (
          <Card title="Order">
            <SwitchRow label="Home delivery" checked={v.homeDelivery} onChange={(x) => area.set("homeDelivery", x)} hint="Every order is a home delivery today." notApplied />
            <SwitchRow label="Takeaway" hint="There is no takeaway order flow yet; saved for when there is." checked={v.takeaway} onChange={(x) => area.set("takeaway", x)} notApplied />
            <SwitchRow
              label="Scheduled orders"
              hint="Customers may order for a later time. When off, an order for a time more than a few minutes ahead is refused."
              checked={v.scheduledOrder}
              onChange={(x) => area.set("scheduledOrder", x)}
            />
            {v.scheduledOrder && (
              <div className="grid gap-4 sm:grid-cols-2 my-2">
                <NumberField label="Time slot interval" hint="Published to the apps for the time picker." value={v.scheduleSlotMinutes} onChange={(x) => area.set("scheduleSlotMinutes", x)} min={5} max={240} suffix="minutes" />
              </div>
            )}
            <SwitchRow
              label="Free delivery over an amount"
              hint="No delivery fee (or its GST) when the item total reaches the amount. The platform bears it; the rider is paid as usual. Does not add to a free-delivery coupon."
              checked={v.freeDelivery?.enabled}
              onChange={(x) => area.set(["freeDelivery", "enabled"], x)}
            />
            {v.freeDelivery?.enabled && (
              <div className="grid gap-4 sm:grid-cols-2 my-2">
                <NumberField label="Free delivery over (₹)" value={v.freeDelivery.minSubtotal} onChange={(x) => area.set(["freeDelivery", "minSubtotal"], x)} step="0.01" />
              </div>
            )}
            <SwitchRow label="Extra packaging charge" hint="Restaurants may add a packaging charge." checked={v.extraPackagingCharge} onChange={(x) => area.set("extraPackagingCharge", x)} notApplied />
            <div className="grid gap-4 sm:grid-cols-2 mt-3">
              <Field label={<>Who confirms the order<NotApplied /></>} hint="Orders are confirmed by the restaurant today.">
                <select className={inputClass} value={v.orderConfirmedBy} onChange={(e) => area.set("orderConfirmedBy", e.target.value)}>
                  <option value="restaurant">Restaurant</option>
                  <option value="deliveryman">Deliveryman</option>
                </select>
              </Field>
            </div>
            <div className="mt-4">
              <SaveBar saving={area.saving} onSave={() => area.save()} updatedAt={area.updatedAt} />
            </div>
          </Card>
        )}
      </AreaGate>
      <RelatedLinks links={[L("order-cancel-reasons", "Order cancellation reasons")]} />
    </>
  )
}

// ─── Vendor ──────────────────────────────────────────────────────────────────

export function VendorTab() {
  const area = useArea("business_vendor")
  const v = area.value
  return (
    <AreaGate area={area}>
      {v && (
        <Card title="Vendor (restaurant)">
          <SwitchRow
            label="Restaurant can cancel order"
            hint="When off, a restaurant can still reject a new order, but not cancel one it has accepted (the admin can)."
            checked={v.restaurantCanCancelOrder}
            onChange={(x) => area.set("restaurantCanCancelOrder", x)}
          />
          <SwitchRow label="Restaurant self registration" hint="Restaurants can sign up themselves." checked={v.restaurantSelfRegistration} onChange={(x) => area.set("restaurantSelfRegistration", x)} notApplied />
          <SwitchRow
            label="Dish approval"
            hint="New dishes, and edits to a dish's name, picture, price, type, category or sizes, wait for admin approval. When off they are live at once."
            checked={v.dishApprovalRequired}
            onChange={(x) => area.set("dishApprovalRequired", x)}
          />
          <SwitchRow label="Restaurant can reply to reviews" hint="There are no review replies yet." checked={v.canReplyToReviews} onChange={(x) => area.set("canReplyToReviews", x)} notApplied />
          <SwitchRow label="Restaurant cash in hand limit" checked={v.cashInHandLimit} onChange={(x) => area.set("cashInHandLimit", x)} notApplied />
          <div className="mt-4">
            <SaveBar saving={area.saving} onSave={() => area.save()} updatedAt={area.updatedAt} />
          </div>
        </Card>
      )}
    </AreaGate>
  )
}

// ─── Customer ────────────────────────────────────────────────────────────────

export function CustomerTab() {
  const area = useArea("business_customer")
  const v = area.value
  const nc = v?.newCustomerDiscount
  return (
    <>
      <AreaGate area={area}>
        {v && (
          <Card title="Customer">
            <SwitchRow label="Customer wallet" hint="When off, customers cannot pay with or add money to the wallet." checked={v.walletEnabled} onChange={(x) => area.set("walletEnabled", x)} />
            <SwitchRow label="Add fund to wallet" hint="Customers can add money to their wallet online. Payments already made are still credited." checked={v.addFundEnabled} onChange={(x) => area.set("addFundEnabled", x)} />
            <SwitchRow
              label="New customer discount"
              hint="Off the items on a customer's first order. The platform bears it; it does not add to a coupon discount."
              checked={nc?.enabled}
              onChange={(x) => area.set(["newCustomerDiscount", "enabled"], x)}
            />
            {nc?.enabled && (
              <div className="grid gap-4 sm:grid-cols-2 my-3">
                <Field label="Discount type">
                  <select className={inputClass} value={nc.type} onChange={(e) => area.set(["newCustomerDiscount", "type"], e.target.value)}>
                    <option value="amount">Amount (₹)</option>
                    <option value="percent">Percent (%)</option>
                  </select>
                </Field>
                <NumberField label={nc.type === "percent" ? "Discount (%)" : "Discount (₹)"} value={nc.value} onChange={(x) => area.set(["newCustomerDiscount", "value"], x)} step="0.01" />
                {nc.type === "percent" && (
                  <NumberField label="Maximum discount (₹)" hint="0 = no cap" value={nc.maxDiscount} onChange={(x) => area.set(["newCustomerDiscount", "maxDiscount"], x)} step="0.01" />
                )}
                <NumberField label="Minimum item total (₹)" value={nc.minOrderAmount} onChange={(x) => area.set(["newCustomerDiscount", "minOrderAmount"], x)} step="0.01" />
                <NumberField label="Validity" hint="Days from sign-up the discount can be used. 0 = no limit." value={nc.validityDays} onChange={(x) => area.set(["newCustomerDiscount", "validityDays"], x)} suffix="days" />
              </div>
            )}
            <SwitchRow label="Veg / non-veg toggle" hint="The customer app shows the veg-only switch." checked={v.vegNonVegToggle} onChange={(x) => area.set("vegNonVegToggle", x)} notApplied="App only" />
            <SwitchRow label="Guest checkout" hint="Ordering without signing in is not supported yet." checked={v.guestCheckout} onChange={(x) => area.set("guestCheckout", x)} notApplied />
            <div className="mt-4">
              <SaveBar saving={area.saving} onSave={() => area.save()} updatedAt={area.updatedAt} />
            </div>
          </Card>
        )}
      </AreaGate>
      <RelatedLinks
        links={[
          L("referral-settings", "Referral", "Referral reward and switch"),
          L("loyalty-point/report", "Loyalty points"),
          L("wallet/bonus", "Wallet bonus", "Bonus on adding money to the wallet"),
          L("cashback", "Cashback"),
        ]}
      />
    </>
  )
}

// ─── Payment ─────────────────────────────────────────────────────────────────

export function PaymentTab() {
  const area = useArea("business_payment")
  const v = area.value
  return (
    <>
      <AreaGate area={area}>
        {v && (
          <Card title="Payment methods" description="Checked when an order is placed and published to the apps. Keep at least one of cash or digital on.">
            <SwitchRow label="Cash on delivery" checked={v.cod} onChange={(x) => area.set("cod", x)} />
            <SwitchRow label="Digital payment" hint="Razorpay: card, UPI, net banking, and pay-by-QR at the door." checked={v.digital} onChange={(x) => area.set("digital", x)} />
            <SwitchRow
              label="Partial payment"
              hint="Pay part with the wallet and the rest online or in cash. Wallet orders still have to cover the whole total."
              checked={v.partialPayment}
              onChange={(x) => area.set("partialPayment", x)}
              notApplied
            />
            <div className="mt-4">
              <SaveBar saving={area.saving} onSave={() => area.save()} updatedAt={area.updatedAt} />
            </div>
          </Card>
        )}
      </AreaGate>
      <RelatedLinks links={[L("3rd-party-configurations/offline-payment", "Offline payment", "Bank transfer and UPI methods, with their own switch")]} />
    </>
  )
}

// ─── Refund ──────────────────────────────────────────────────────────────────

export function RefundTab() {
  const area = useArea("business_refund")
  const v = area.value
  return (
    <AreaGate area={area}>
      {v && (
        <Card title="Refund" description="Reasons a customer can pick when asking for a refund (GET /food/public/refund-reasons).">
          <SwitchRow
            label="Refund request"
            hint="Customers can ask for a refund from the app. The customer refund request itself is not built yet; admins refund from the order."
            checked={v.refundRequestEnabled}
            onChange={(x) => area.set("refundRequestEnabled", x)}
            notApplied
          />
          <div className="mt-4">
            <p className="text-xs font-semibold text-slate-600 mb-2">Refund reasons</p>
            <ReasonListEditor reasons={v.reasons} onChange={(next) => area.set("reasons", next)} placeholder="e.g. Food was cold" />
          </div>
          <div className="mt-4">
            <SaveBar saving={area.saving} onSave={() => area.save()} updatedAt={area.updatedAt} />
          </div>
        </Card>
      )}
    </AreaGate>
  )
}

// ─── Priority setup ──────────────────────────────────────────────────────────

const SORT_LABELS = {
  nearest: "Nearest first",
  rating: "Highest rated",
  newest: "Newest first",
  popular: "Most ordered",
  deliveryTime: "Fastest delivery",
  price_low: "Price: low to high",
  price_high: "Price: high to low",
}

export function PriorityTab() {
  const area = useArea("business_priority")
  const sections = area.catalog?.sections || []
  const v = area.value
  return (
    <AreaGate area={area}>
      {v && (
        <Card title="Priority setup" description="How each section of the customer app is ordered when the app does not ask for a sort. Lists are cached for a few minutes, so a change can take that long to show.">
          <div className="divide-y divide-slate-100">
            {sections.map((section) => {
              const entry = v.sections?.[section.key] || { mode: "default", sort: section.sorts[0] }
              return (
                <div key={section.key} className="py-3 flex flex-wrap items-center gap-3 justify-between">
                  <p className="text-sm font-medium text-slate-800">
                    {section.label}
                    {!section.applied && <NotApplied />}
                  </p>
                  <div className="flex items-center gap-2">
                    <select className={`${inputClass} w-40`} value={entry.mode} onChange={(e) => area.set(["sections", section.key, "mode"], e.target.value)}>
                      <option value="default">Default order</option>
                      <option value="custom">Custom</option>
                    </select>
                    <select
                      className={`${inputClass} w-48`}
                      value={entry.sort}
                      disabled={entry.mode !== "custom"}
                      onChange={(e) => area.set(["sections", section.key, "sort"], e.target.value)}
                    >
                      {section.sorts.map((sort) => (
                        <option key={sort} value={sort}>{SORT_LABELS[sort] || sort}</option>
                      ))}
                    </select>
                  </div>
                </div>
              )
            })}
          </div>
          <div className="mt-4">
            <SaveBar saving={area.saving} onSave={() => area.save()} updatedAt={area.updatedAt} />
          </div>
        </Card>
      )}
    </AreaGate>
  )
}

// ─── Disbursement ────────────────────────────────────────────────────────────

const admin = { contextModule: "admin" }
const PAYOUT_SETTINGS = "/food/admin/withdrawals/restaurant-payouts/settings"

/** Restaurant payouts keep their own settings (the daily payout run). */
function RestaurantPayoutCard() {
  const [value, setValue] = useState(null)
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    let alive = true
    apiClient
      .get(PAYOUT_SETTINGS, admin)
      .then((res) => alive && setValue(res?.data?.data?.settings || {}))
      .catch((err) => alive && toast.error(errorMessage(err, "Failed to load restaurant payout settings")))
    return () => {
      alive = false
    }
  }, [])
  const set = (key, next) => setValue((v) => ({ ...v, [key]: next }))
  const save = async () => {
    try {
      setSaving(true)
      const { isEnabled, frequency, weekday, runTime, waitingDays, minAmount } = value
      const res = await apiClient.put(PAYOUT_SETTINGS, { isEnabled, frequency, weekday, runTime, waitingDays, minAmount }, admin)
      setValue(res?.data?.data?.settings || value)
      toast.success("Saved")
    } catch (err) {
      toast.error(errorMessage(err, "Failed to save"))
    } finally {
      setSaving(false)
    }
  }
  if (!value) return <Card title="Restaurants"><Loading /></Card>
  return (
    <Card title="Restaurants" description="Each run writes one payout line per restaurant owed at least the minimum; the admin pays each line and marks it paid. Once per day; Generate now on the restaurant payouts page still works.">
      <SwitchRow label="Automated restaurant disbursement" checked={value.isEnabled} onChange={(x) => set("isEnabled", x)} />
      <div className="grid gap-4 sm:grid-cols-2 mt-3">
        <Field label="Frequency">
          <select className={inputClass} value={value.frequency} onChange={(e) => set("frequency", e.target.value)}>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
          </select>
        </Field>
        {value.frequency === "weekly" && (
          <Field label="Day">
            <select className={inputClass} value={value.weekday} onChange={(e) => set("weekday", Number(e.target.value))}>
              {["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map((d, i) => (
                <option key={d} value={i}>{d}</option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Time (India)">
          <input type="time" className={inputClass} value={value.runTime} onChange={(e) => set("runTime", e.target.value)} />
        </Field>
        <NumberField label="Minimum amount (₹)" value={value.minAmount} onChange={(x) => set("minAmount", x)} min={1} step="0.01" />
        <NumberField label="Waiting time" hint="Orders from the last days are held back until the next run." value={value.waitingDays} onChange={(x) => set("waitingDays", x)} max={30} suffix="days" />
      </div>
      <div className="mt-4 flex justify-end">
        <SaveButton saving={saving} onClick={save} />
      </div>
    </Card>
  )
}

export function DisbursementTab() {
  const area = useArea("business_disbursement")
  const rider = area.value?.rider
  return (
    <>
      <RestaurantPayoutCard />
      <AreaGate area={area}>
        {rider && (
          <Card title="Deliverymen" description="Runs the same disbursement as “Generate disbursement” on the deliveryman payouts page, once a day after the time below; riders without a bank account or UPI id are listed as skipped. The manual button still works and pays the whole balance.">
            <SwitchRow label="Automated deliveryman disbursement" checked={rider.enabled} onChange={(x) => area.set(["rider", "enabled"], x)} />
            <div className="grid gap-4 sm:grid-cols-2 mt-3">
              <Field label="Frequency" hint="Daily.">
                <input className={`${inputClass} bg-slate-50`} value="Daily" disabled />
              </Field>
              <Field label="Time (India)">
                <input type="time" className={inputClass} value={rider.runTime} onChange={(e) => area.set(["rider", "runTime"], e.target.value)} />
              </Field>
              <NumberField label="Minimum amount (₹)" value={rider.minAmount} onChange={(x) => area.set(["rider", "minAmount"], x)} min={1} step="0.01" />
              <NumberField label="Waiting time" hint="Earnings on orders placed in the last days are held back." value={rider.waitingDays} onChange={(x) => area.set(["rider", "waitingDays"], x)} max={30} suffix="days" />
            </div>
            <div className="mt-4">
              <SaveBar saving={area.saving} onSave={() => area.save()} updatedAt={area.updatedAt} />
            </div>
          </Card>
        )}
      </AreaGate>
    </>
  )
}

// ─── Automated message ───────────────────────────────────────────────────────

export function AutomatedMessageTab() {
  const area = useArea("business_order_issue_reasons")
  const v = area.value
  return (
    <AreaGate area={area}>
      {v && (
        <Card title="Automated message" description="Messages a customer can pick when reporting a problem with an order (GET /food/public/order-issue-reasons). Switch one off to hide it without deleting it.">
          <ReasonListEditor reasons={v.reasons} onChange={(next) => area.set("reasons", next)} placeholder="e.g. Item missing from my order" />
          <div className="mt-4">
            <SaveBar saving={area.saving} onSave={() => area.save()} updatedAt={area.updatedAt} />
          </div>
        </Card>
      )}
    </AreaGate>
  )
}
