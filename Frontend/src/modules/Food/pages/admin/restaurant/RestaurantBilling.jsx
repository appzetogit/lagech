import { useState, useEffect, useMemo, useCallback } from "react"
import { Search, Loader2, Percent, IndianRupee, X, RotateCcw, Info } from "lucide-react"
import { toast } from "sonner"
import { adminAPI } from "@food/api"

/**
 * How each restaurant is billed, and the per-dish rates that go with it.
 *
 * Separate from the Restaurant Commission screen on purpose: that one is a list
 * of commission rows, so a restaurant on a subscription plan -- which has no
 * commission row at all -- simply would not appear on it. Billing mode belongs
 * to the restaurant, so this lists restaurants.
 */

const MODES = [
    {
        value: "commission_overall",
        label: "Overall commission",
        blurb: "One rate against the order subtotal.",
    },
    {
        value: "commission_dish",
        label: "Dish-based commission",
        blurb: "Each dish at its own rate; dishes without one fall back to the restaurant rate.",
    },
    {
        value: "subscription",
        label: "Subscription",
        blurb: "Monthly plan instead of per-order commission. No commission is charged.",
    },
]

const modeLabel = (value) => MODES.find((m) => m.value === value)?.label || "Overall commission"

const badgeClass = (mode) =>
    mode === "subscription"
        ? "bg-purple-50 text-purple-700 border-purple-200"
        : mode === "commission_dish"
            ? "bg-amber-50 text-amber-700 border-amber-200"
            : "bg-slate-100 text-slate-700 border-slate-200"

export default function RestaurantBilling() {
    const [restaurants, setRestaurants] = useState([])
    const [loading, setLoading] = useState(true)
    const [searchQuery, setSearchQuery] = useState("")
    const [savingId, setSavingId] = useState(null)

    // Dish-rate editor
    const [dishOpen, setDishOpen] = useState(false)
    const [dishRestaurant, setDishRestaurant] = useState(null)
    const [dishItems, setDishItems] = useState([])
    const [dishLoading, setDishLoading] = useState(false)
    const [dishSavingId, setDishSavingId] = useState(null)

    const fetchRestaurants = useCallback(async () => {
        try {
            setLoading(true)
            const res = await adminAPI.getRestaurants({ limit: 500, page: 1 })
            const payload = res?.data?.data ?? res?.data ?? {}
            const rows =
                payload.items ||
                payload.data ||
                payload.restaurants ||
                payload.docs ||
                (Array.isArray(payload) ? payload : [])
            setRestaurants(Array.isArray(rows) ? rows : [])
        } catch (error) {
            // The interceptor already toasts; this only stops the spinner.
            setRestaurants([])
        } finally {
            setLoading(false)
        }
    }, [])

    useEffect(() => {
        fetchRestaurants()
    }, [fetchRestaurants])

    const filtered = useMemo(() => {
        const query = searchQuery.trim().toLowerCase()
        if (!query) return restaurants
        return restaurants.filter((r) =>
            String(r.restaurantName || r.name || "").toLowerCase().includes(query) ||
            String(r.id || r._id || "").toLowerCase().includes(query),
        )
    }, [restaurants, searchQuery])

    const changeMode = async (restaurant, billingMode) => {
        const id = restaurant.id || restaurant._id
        const previous = restaurant.billingMode || "commission_overall"
        if (billingMode === previous) return

        // Optimistic: the select should not snap back while the request is in
        // flight. Reverted below if the server refuses.
        setRestaurants((rows) =>
            rows.map((r) => ((r.id || r._id) === id ? { ...r, billingMode } : r)),
        )
        setSavingId(id)
        try {
            await adminAPI.setRestaurantBillingMode(id, billingMode)
            toast.success(`${restaurant.restaurantName || "Restaurant"} is now on ${modeLabel(billingMode)}`)
        } catch (error) {
            setRestaurants((rows) =>
                rows.map((r) => ((r.id || r._id) === id ? { ...r, billingMode: previous } : r)),
            )
        } finally {
            setSavingId(null)
        }
    }

    const openDishRates = async (restaurant) => {
        setDishRestaurant(restaurant)
        setDishOpen(true)
        setDishItems([])
        setDishLoading(true)
        try {
            const res = await adminAPI.getItemCommissions(restaurant.id || restaurant._id)
            const data = res?.data?.data ?? res?.data ?? {}
            setDishItems(Array.isArray(data.items) ? data.items : [])
        } catch (error) {
            setDishItems([])
        } finally {
            setDishLoading(false)
        }
    }

    const saveDishRate = async (item, patch) => {
        const restaurantId = dishRestaurant?.id || dishRestaurant?._id
        setDishSavingId(item.itemId)
        try {
            await adminAPI.upsertItemCommission(restaurantId, item.itemId, patch)
            setDishItems((rows) =>
                rows.map((row) =>
                    row.itemId === item.itemId
                        ? patch.clear
                            ? { ...row, hasOwnRate: false, commissionValue: 0, commissionType: "percentage" }
                            : { ...row, hasOwnRate: true, ...patch }
                        : row,
                ),
            )
            toast.success(patch.clear ? `${item.name} follows the restaurant rate` : `${item.name} updated`)
        } catch (error) {
            // Interceptor toasts the reason; the row keeps its previous value.
        } finally {
            setDishSavingId(null)
        }
    }

    return (
        <div className="p-4 lg:p-6 bg-slate-50 min-h-screen">
            <div className="max-w-7xl mx-auto">
                <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
                    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-4">
                        <div className="flex items-center gap-2">
                            <h1 className="text-2xl font-bold text-slate-900">Billing Mode</h1>
                            <span className="px-3 py-1 rounded-full text-sm font-semibold bg-slate-100 text-slate-700">
                                {filtered.length}
                            </span>
                        </div>
                    </div>

                    <div className="mb-4 flex items-start gap-2 rounded-lg border border-blue-100 bg-blue-50 px-4 py-3">
                        <Info className="w-4 h-4 text-blue-600 shrink-0 mt-0.5" />
                        <p className="text-sm text-blue-900">
                            A restaurant is billed one way only. Switching to{" "}
                            <strong>Subscription</strong> stops per-order commission entirely, so the
                            restaurant is not charged twice for the same order.
                        </p>
                    </div>

                    <div className="mb-4 relative max-w-sm">
                        <input
                            type="text"
                            placeholder="Search by restaurant name or ID"
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            className="pl-10 pr-4 py-2.5 w-full text-sm rounded-lg border border-slate-300 bg-white focus:outline-none focus:ring-2 focus:ring-slate-400"
                        />
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                    </div>

                    {loading ? (
                        <div className="flex items-center justify-center py-12">
                            <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
                        </div>
                    ) : filtered.length === 0 ? (
                        <p className="py-12 text-center text-sm text-slate-500">No restaurants found.</p>
                    ) : (
                        <div className="overflow-x-auto">
                            <table className="w-full">
                                <thead className="bg-slate-50 border-b border-slate-200">
                                    <tr>
                                        <th className="px-6 py-4 text-left text-[10px] font-bold text-slate-700 uppercase tracking-wider">
                                            Restaurant
                                        </th>
                                        <th className="px-6 py-4 text-left text-[10px] font-bold text-slate-700 uppercase tracking-wider">
                                            Current
                                        </th>
                                        <th className="px-6 py-4 text-left text-[10px] font-bold text-slate-700 uppercase tracking-wider">
                                            Billing Mode
                                        </th>
                                        <th className="px-6 py-4 text-center text-[10px] font-bold text-slate-700 uppercase tracking-wider">
                                            Dish Rates
                                        </th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-slate-100">
                                    {filtered.map((restaurant) => {
                                        const id = restaurant.id || restaurant._id
                                        const mode = restaurant.billingMode || "commission_overall"
                                        return (
                                            <tr key={id} className="hover:bg-slate-50">
                                                <td className="px-6 py-4">
                                                    <p className="text-sm font-medium text-slate-900">
                                                        {restaurant.restaurantName || restaurant.name || "Restaurant"}
                                                    </p>
                                                    <p className="text-xs text-slate-500">
                                                        {restaurant.area || restaurant.city || ""}
                                                    </p>
                                                </td>
                                                <td className="px-6 py-4">
                                                    <span className={`inline-block px-2.5 py-1 rounded-full text-xs font-semibold border ${badgeClass(mode)}`}>
                                                        {modeLabel(mode)}
                                                    </span>
                                                </td>
                                                <td className="px-6 py-4">
                                                    <div className="flex items-center gap-2">
                                                        <select
                                                            value={mode}
                                                            disabled={savingId === id}
                                                            onChange={(e) => changeMode(restaurant, e.target.value)}
                                                            className="text-sm rounded-lg border border-slate-300 px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-slate-400 disabled:opacity-60"
                                                        >
                                                            {MODES.map((m) => (
                                                                <option key={m.value} value={m.value}>
                                                                    {m.label}
                                                                </option>
                                                            ))}
                                                        </select>
                                                        {savingId === id && (
                                                            <Loader2 className="w-4 h-4 animate-spin text-slate-400" />
                                                        )}
                                                    </div>
                                                </td>
                                                <td className="px-6 py-4 text-center">
                                                    <button
                                                        type="button"
                                                        onClick={() => openDishRates(restaurant)}
                                                        className="px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-100"
                                                    >
                                                        {mode === "commission_dish" ? "Edit rates" : "View rates"}
                                                    </button>
                                                </td>
                                            </tr>
                                        )
                                    })}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>
            </div>

            {dishOpen && (
                <DishRateDialog
                    restaurant={dishRestaurant}
                    items={dishItems}
                    loading={dishLoading}
                    savingId={dishSavingId}
                    onSave={saveDishRate}
                    onClose={() => setDishOpen(false)}
                />
            )}
        </div>
    )
}

/**
 * Every dish is listed, not just the ones carrying a rate: which dishes have
 * none -- and so fall back to the restaurant rate -- is exactly what an admin
 * needs to see before switching a restaurant to dish-based billing.
 */
function DishRateDialog({ restaurant, items, loading, savingId, onSave, onClose }) {
    const [drafts, setDrafts] = useState({})

    useEffect(() => {
        const next = {}
        for (const item of items) {
            next[item.itemId] = {
                commissionType: item.commissionType || "percentage",
                commissionValue: String(item.commissionValue ?? 0),
            }
        }
        setDrafts(next)
    }, [items])

    const setDraft = (itemId, patch) =>
        setDrafts((d) => ({ ...d, [itemId]: { ...d[itemId], ...patch } }))

    const isDish = (restaurant?.billingMode || "commission_overall") === "commission_dish"
    const withoutRate = items.filter((i) => !i.hasOwnRate).length

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
            <div className="bg-white rounded-xl shadow-xl w-full max-w-3xl max-h-[85vh] flex flex-col">
                <div className="flex items-start justify-between border-b border-slate-200 px-6 py-4">
                    <div>
                        <h2 className="text-lg font-bold text-slate-900">
                            Dish rates — {restaurant?.restaurantName || restaurant?.name}
                        </h2>
                        <p className="text-xs text-slate-500 mt-0.5">
                            {isDish
                                ? "These apply to every order."
                                : "This restaurant is not on dish-based billing, so these are saved but not charged."}
                        </p>
                    </div>
                    <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-600">
                        <X className="w-5 h-5" />
                    </button>
                </div>

                <div className="overflow-y-auto px-6 py-4">
                    {loading ? (
                        <div className="flex items-center justify-center py-12">
                            <Loader2 className="w-7 h-7 animate-spin text-blue-600" />
                        </div>
                    ) : items.length === 0 ? (
                        <p className="py-10 text-center text-sm text-slate-500">
                            This restaurant has no dishes yet.
                        </p>
                    ) : (
                        <>
                            {withoutRate > 0 && (
                                <p className="mb-3 text-xs text-slate-600">
                                    {withoutRate} of {items.length} dishes have no rate of their own and
                                    fall back to the restaurant rate.
                                </p>
                            )}
                            <table className="w-full">
                                <thead>
                                    <tr className="border-b border-slate-200">
                                        <th className="py-2 text-left text-[10px] font-bold uppercase tracking-wider text-slate-600">Dish</th>
                                        <th className="py-2 text-right text-[10px] font-bold uppercase tracking-wider text-slate-600">Price</th>
                                        <th className="py-2 text-left text-[10px] font-bold uppercase tracking-wider text-slate-600">Rate</th>
                                        <th className="py-2 text-right text-[10px] font-bold uppercase tracking-wider text-slate-600">Save</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-slate-100">
                                    {items.map((item) => {
                                        const draft = drafts[item.itemId] || { commissionType: "percentage", commissionValue: "0" }
                                        const busy = savingId === item.itemId
                                        return (
                                            <tr key={item.itemId}>
                                                <td className="py-3 pr-3">
                                                    <p className="text-sm text-slate-900">{item.name}</p>
                                                    {!item.hasOwnRate && (
                                                        <p className="text-[11px] text-slate-500">follows restaurant rate</p>
                                                    )}
                                                </td>
                                                <td className="py-3 text-right text-sm text-slate-600 whitespace-nowrap">
                                                    ₹{Number(item.price).toFixed(2)}
                                                </td>
                                                <td className="py-3">
                                                    <div className="flex items-center gap-1.5">
                                                        <select
                                                            value={draft.commissionType}
                                                            onChange={(e) => setDraft(item.itemId, { commissionType: e.target.value })}
                                                            className="text-xs rounded-md border border-slate-300 px-2 py-1.5 bg-white"
                                                        >
                                                            <option value="percentage">%</option>
                                                            <option value="amount">₹</option>
                                                        </select>
                                                        <input
                                                            type="number"
                                                            min="0"
                                                            step="0.01"
                                                            value={draft.commissionValue}
                                                            onChange={(e) => setDraft(item.itemId, { commissionValue: e.target.value })}
                                                            className="w-24 text-sm rounded-md border border-slate-300 px-2 py-1.5"
                                                        />
                                                        {draft.commissionType === "percentage"
                                                            ? <Percent className="w-3.5 h-3.5 text-slate-400" />
                                                            : <IndianRupee className="w-3.5 h-3.5 text-slate-400" />}
                                                    </div>
                                                </td>
                                                <td className="py-3 text-right whitespace-nowrap">
                                                    <button
                                                        type="button"
                                                        disabled={busy}
                                                        onClick={() =>
                                                            onSave(item, {
                                                                commissionType: draft.commissionType,
                                                                commissionValue: Number(draft.commissionValue),
                                                            })
                                                        }
                                                        className="px-3 py-1.5 text-xs font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-60"
                                                    >
                                                        {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Save"}
                                                    </button>
                                                    {item.hasOwnRate && (
                                                        <button
                                                            type="button"
                                                            disabled={busy}
                                                            title="Clear this rate and follow the restaurant rate"
                                                            onClick={() => onSave(item, { clear: true })}
                                                            className="ml-1.5 px-2 py-1.5 text-xs rounded-lg border border-slate-300 text-slate-600 hover:bg-slate-100 disabled:opacity-60"
                                                        >
                                                            <RotateCcw className="w-3.5 h-3.5" />
                                                        </button>
                                                    )}
                                                </td>
                                            </tr>
                                        )
                                    })}
                                </tbody>
                            </table>
                        </>
                    )}
                </div>

                <div className="border-t border-slate-200 px-6 py-3 text-right">
                    <button
                        type="button"
                        onClick={onClose}
                        className="px-4 py-2 text-sm font-medium rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-100"
                    >
                        Close
                    </button>
                </div>
            </div>
        </div>
    )
}
