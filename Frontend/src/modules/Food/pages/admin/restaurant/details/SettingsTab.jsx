import { useState } from "react"
import { Link } from "react-router-dom"
import { toast } from "sonner"
import { Loader2 } from "@food/components/admin/theme/icons"
import { adminAPI } from "@food/api"
import { adminCatalogExtrasAPI } from "@food/api/adminCatalogExtras"
import { Panel, Toggle, errorMessage, rupees } from "./shared"

/**
 * The per-restaurant switches the old Settings tab had, where this system
 * stores them. Each switch saves on its own; the text fields save with their
 * button. Everything else (timings, documents, location) is on Edit Store.
 */

function SettingRow({ title, description, children }) {
  return (
    <div className="flex flex-col gap-3 border-b border-slate-100 py-4 last:border-b-0 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="text-sm font-semibold text-slate-800">{title}</p>
        {description && <p className="mt-0.5 text-xs text-slate-500">{description}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

export default function SettingsTab({ restaurantId, restaurant, analytics, onRestaurantChange }) {
  const [busy, setBusy] = useState("")
  const [packaging, setPackaging] = useState(String(Number(restaurant?.extraPackagingAmount || 0)))
  const [deliveryTime, setDeliveryTime] = useState(restaurant?.estimatedDeliveryTime || "")

  const save = async (key, patch, message) => {
    setBusy(key)
    try {
      await adminAPI.updateRestaurant(restaurantId, patch)
      onRestaurantChange(patch)
      toast.success(message)
    } catch (err) {
      toast.error(errorMessage(err, "Could not save the setting"))
    } finally {
      setBusy("")
    }
  }

  const saveFeatured = async (next) => {
    setBusy("isFeatured")
    try {
      await adminCatalogExtrasAPI.setRestaurantFeatured(restaurantId, next)
      onRestaurantChange({ isFeatured: next })
      toast.success(next ? "Restaurant featured" : "Restaurant no longer featured")
    } catch (err) {
      toast.error(errorMessage(err, "Could not save the setting"))
    } finally {
      setBusy("")
    }
  }

  const switchRow = (key, title, description, onMessage, offMessage) => (
    <SettingRow title={title} description={description}>
      <Toggle
        checked={restaurant?.[key] === true}
        disabled={busy === key}
        label={title}
        onChange={(next) => save(key, { [key]: next }, next ? onMessage : offMessage)}
      />
    </SettingRow>
  )

  const minutesFrom = (text) => {
    const numbers = String(text).match(/\d+/g)
    return numbers ? Math.max(...numbers.map(Number)) : null
  }

  const input = "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500 sm:w-40"
  const saveButton = "inline-flex items-center gap-1.5 rounded-lg bg-teal-700 px-3 py-2 text-sm font-semibold text-white hover:bg-teal-800 disabled:opacity-60"
  const commission = analytics?.analytics?.commissionPercentage

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Panel title="Store setup" bodyClassName="px-4 sm:px-5">
        {switchRow("isAcceptingOrders", "Accepting orders", "Off takes the store offline in the customer app, whatever its timings.", "Store is online", "Store is offline")}
        {switchRow("takeawayEnabled", "Takeaway", "Customers may pick their order up (when takeaway is on in Business Settings).", "Takeaway on", "Takeaway off")}
        {switchRow("pureVegRestaurant", "Pure veg", "Only veg dishes may be added to this store.", "Marked pure veg", "No longer pure veg")}
        <SettingRow title="Featured" description="Flagged on the store's card in the customer app.">
          <Toggle checked={restaurant?.isFeatured === true} disabled={busy === "isFeatured"} label="Featured" onChange={saveFeatured} />
        </SettingRow>
        <SettingRow title="Delivery time" description="Shown to customers, e.g. 30-40 min.">
          <div className="flex gap-2">
            <input value={deliveryTime} onChange={(e) => setDeliveryTime(e.target.value)} className={input} maxLength={40} placeholder="30-40 min" />
            <button
              type="button"
              disabled={busy === "deliveryTime"}
              className={saveButton}
              onClick={() =>
                save(
                  "deliveryTime",
                  { estimatedDeliveryTime: deliveryTime.trim(), estimatedDeliveryTimeMinutes: minutesFrom(deliveryTime) },
                  "Delivery time saved",
                )
              }
            >
              {busy === "deliveryTime" && <Loader2 className="w-4 h-4 animate-spin" />} Save
            </button>
          </div>
        </SettingRow>
      </Panel>

      <div className="space-y-4">
        <Panel title="Extra packaging charge" bodyClassName="px-4 sm:px-5">
          {switchRow("extraPackagingEnabled", "Charge for packaging", "Applies while the extra packaging charge is on in Business Settings.", "Packaging charge on", "Packaging charge off")}
          {switchRow("extraPackagingRequired", "Required on every order", "Off lets the customer choose whether to pay it.", "Packaging charge is required", "Packaging charge is optional")}
          <SettingRow title="Amount" description={`Now ${rupees(restaurant?.extraPackagingAmount)} per order, paid to the store.`}>
            <div className="flex gap-2">
              <input type="number" min="0" step="0.01" value={packaging} onChange={(e) => setPackaging(e.target.value)} className={input} />
              <button
                type="button"
                disabled={busy === "packaging" || !(Number(packaging) >= 0)}
                className={saveButton}
                onClick={() => save("packaging", { extraPackagingAmount: Number(packaging) }, "Packaging charge saved")}
              >
                {busy === "packaging" && <Loader2 className="w-4 h-4 animate-spin" />} Save
              </button>
            </div>
          </SettingRow>
        </Panel>

        <Panel title="Commission">
          <p className="text-sm text-slate-700">
            {commission !== undefined ? (
              <>Effective commission: <span className="font-semibold">{Number(commission).toFixed(2)}%</span></>
            ) : (
              "Commission figures could not be loaded."
            )}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            A store-specific rate overrides the default commission. Billing mode (overall, per dish or subscription) is on the
            Business plan tab.
          </p>
          <Link to="/admin/food/restaurants/commission" className="mt-3 inline-block text-sm font-semibold text-teal-700 hover:underline">
            Set this store's commission
          </Link>
        </Panel>

        <Panel title="Not available here">
          <p className="text-xs text-slate-500">
            The old panel also had home delivery, self delivery, scheduled orders, minimum order amount and veg / non-veg
            switches per store. In this system every order is delivered by platform riders, scheduled orders are switched on
            platform-wide in Business Settings, there is no per-store minimum order amount, and veg / non-veg is set per dish
            (or with Pure veg above). Opening hours,
            documents and location are on <Link to={`/admin/food/restaurants/edit/${encodeURIComponent(String(restaurantId))}`} className="text-teal-700 hover:underline">Edit Store</Link>.
          </p>
        </Panel>
      </div>
    </div>
  )
}
