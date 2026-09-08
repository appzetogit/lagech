import { X } from "lucide-react"

/**
 * Filters for Order Detect Delivery.
 *
 * The page had a Filters button wired to open state that nothing rendered, so
 * pressing it did nothing at all. The options below are the derived stage
 * labels the page already builds — matching them against the raw order status
 * would filter on a value the table never shows.
 */

const STATUS_OPTIONS = [
  "Ordered",
  "Restaurant Accepted",
  "Delivery Boy Assigned",
  "Delivery Boy Reached Pickup",
  "Order ID Accepted",
  "Reached Drop",
  "Delivered",
  "Rejected",
]

export default function OrderDetectFilterPanel({
  isOpen,
  onClose,
  filters,
  setFilters,
  onApply,
  onReset,
  restaurants = [],
  deliveryPartners = [],
}) {
  if (!isOpen) return null

  const set = (key, value) => setFilters((prev) => ({ ...prev, [key]: value }))

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-end bg-black/30">
      <div className="h-full w-full max-w-sm overflow-y-auto bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <h2 className="text-lg font-bold text-slate-900">Filters</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600"
            aria-label="Close filters"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-4 px-5 py-5">
          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-600">Status</label>
            <select
              value={filters.status || ""}
              onChange={(event) => set("status", event.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
            >
              <option value="">All statuses</option>
              {STATUS_OPTIONS.map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-600">Restaurant</label>
            <select
              value={filters.restaurantName || ""}
              onChange={(event) => set("restaurantName", event.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
            >
              <option value="">All restaurants</option>
              {restaurants.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-600">
              Delivery Partner
            </label>
            <select
              value={filters.deliveryBoyName || ""}
              onChange={(event) => set("deliveryBoyName", event.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
            >
              <option value="">All delivery partners</option>
              {deliveryPartners.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="flex gap-2 border-t border-slate-200 px-5 py-4">
          <button
            type="button"
            onClick={() => {
              onReset?.()
              onClose?.()
            }}
            className="flex-1 rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100"
          >
            Clear all
          </button>
          <button
            type="button"
            onClick={() => {
              onApply?.()
              onClose?.()
            }}
            className="flex-1 rounded-lg bg-teal-700 px-4 py-2 text-sm font-medium text-white hover:bg-teal-800"
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  )
}
