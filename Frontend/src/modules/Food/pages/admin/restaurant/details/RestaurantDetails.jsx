import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react"
import { Link, Navigate, useNavigate, useParams } from "react-router-dom"
import { ArrowLeft, Pencil, Store } from "@food/components/admin/theme/icons"
import { adminAPI } from "@food/api"
import { ErrorState, Spinner, errorMessage, mediaUrl, payload } from "./shared"

/**
 * Restaurant details, the old panel's /admin/store/view/{id}: a header with
 * the name and Edit Store, then a tab strip. Each tab is its own URL
 * (/admin/food/restaurants/view/:id/:tab) so it can be linked to; the bare
 * URL is the Overview.
 *
 * The restaurant and its analytics are loaded once here and handed to the
 * tabs; each tab loads its own list.
 */

const OverviewTab = lazy(() => import("./OverviewTab"))
const OrdersTab = lazy(() => import("./OrdersTab"))
const ItemsTab = lazy(() => import("./ItemsTab"))
const ReviewsTab = lazy(() => import("./ReviewsTab"))
const ReelsTab = lazy(() => import("./ReelsTab"))
const DiscountsTab = lazy(() => import("./DiscountsTab"))
const TransactionsTab = lazy(() => import("./TransactionsTab"))
const SettingsTab = lazy(() => import("./SettingsTab"))
const ConversationsTab = lazy(() => import("./ConversationsTab"))
const MetaDataTab = lazy(() => import("./MetaDataTab"))
const DisbursementsTab = lazy(() => import("./DisbursementsTab"))
const BusinessPlanTab = lazy(() => import("./BusinessPlanTab"))

export const RESTAURANT_TABS = [
  { key: "overview", label: "Overview", Component: OverviewTab },
  { key: "orders", label: "Orders", Component: OrdersTab },
  { key: "items", label: "Items", Component: ItemsTab },
  { key: "reviews", label: "Reviews", Component: ReviewsTab },
  { key: "reels", label: "Reels", Component: ReelsTab },
  { key: "discounts", label: "Discounts", Component: DiscountsTab },
  { key: "transactions", label: "Transactions", Component: TransactionsTab },
  { key: "settings", label: "Settings", Component: SettingsTab },
  { key: "conversations", label: "Conversations", Component: ConversationsTab },
  { key: "meta-data", label: "Meta data", Component: MetaDataTab },
  { key: "disbursements", label: "Disbursements", Component: DisbursementsTab },
  { key: "business-plan", label: "Business plan", Component: BusinessPlanTab },
]

/** Where a restaurant's details page (or one of its tabs) lives. */
export const restaurantDetailsPath = (id, tab = "") =>
  `/admin/food/restaurants/view/${encodeURIComponent(String(id))}${tab && tab !== "overview" ? `/${tab}` : ""}`

export default function RestaurantDetails() {
  const { id, tab = "overview" } = useParams()
  const navigate = useNavigate()
  const [restaurant, setRestaurant] = useState(null)
  const [analytics, setAnalytics] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const activeTabRef = useRef(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError("")
    try {
      const [detailsRes, analyticsRes] = await Promise.all([
        adminAPI.getRestaurantById(id),
        adminAPI.getRestaurantAnalytics(id).catch(() => null),
      ])
      const details = payload(detailsRes)
      if (!details || !(details.id || details._id)) throw new Error("Restaurant not found")
      setRestaurant(details)
      setAnalytics(analyticsRes ? payload(analyticsRes) : null)
    } catch (err) {
      setError(errorMessage(err, "Could not load this restaurant"))
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    load()
  }, [load])

  // Keep the selected tab in view when the strip scrolls sideways on a phone.
  useEffect(() => {
    activeTabRef.current?.scrollIntoView?.({ block: "nearest", inline: "center" })
  }, [tab, loading])

  const current = RESTAURANT_TABS.find((t) => t.key === tab)
  if (!current) return <Navigate to={restaurantDetailsPath(id)} replace />

  const ActiveTab = current.Component
  const name = restaurant?.restaurantName || restaurant?.name || "Restaurant"
  const logo = mediaUrl(restaurant?.profileImage)

  return (
    <div className="min-h-screen w-full max-w-full overflow-x-hidden bg-slate-50 px-4 py-4 lg:px-6 lg:py-6">
      <div className="mx-auto w-full max-w-7xl min-w-0 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <button
              type="button"
              onClick={() => navigate("/admin/food/restaurants")}
              className="shrink-0 rounded-lg border border-slate-200 bg-white p-2 text-slate-600 hover:bg-slate-50"
              title="Back to restaurants"
            >
              <ArrowLeft className="w-4 h-4" />
            </button>
            <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-full border border-slate-200 bg-white">
              {logo ? <img src={logo} alt="" className="h-full w-full object-cover" /> : <Store className="w-5 h-5 text-slate-400" />}
            </div>
            <h1 className="min-w-0 truncate text-lg font-bold text-slate-900 sm:text-xl">{loading ? "Loading…" : name}</h1>
          </div>
          <Link
            to={`/admin/food/restaurants/edit/${encodeURIComponent(String(id))}`}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-teal-50 px-3 py-2 text-sm font-semibold text-teal-700 hover:bg-teal-100"
          >
            <Pencil className="w-4 h-4" /> Edit Store
          </Link>
        </div>

        <nav className="-mx-4 border-b border-slate-200 px-4 lg:mx-0 lg:px-0" aria-label="Restaurant sections">
          <div className="flex gap-1 overflow-x-auto whitespace-nowrap [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {RESTAURANT_TABS.map((t) => {
              const active = t.key === current.key
              return (
                <Link
                  key={t.key}
                  ref={active ? activeTabRef : undefined}
                  to={restaurantDetailsPath(id, t.key)}
                  replace
                  className={`shrink-0 border-b-2 px-3 py-2.5 text-sm transition-colors ${
                    active ? "border-teal-600 font-semibold text-teal-700" : "border-transparent text-slate-600 hover:text-slate-900"
                  }`}
                >
                  {t.label}
                </Link>
              )
            })}
          </div>
        </nav>

        {loading ? (
          <Spinner className="py-20" />
        ) : error ? (
          <div className="rounded-xl border border-slate-200 bg-white">
            <ErrorState message={error} onRetry={load} />
          </div>
        ) : (
          <Suspense fallback={<Spinner className="py-20" />}>
            <ActiveTab
              restaurantId={restaurant.id || restaurant._id}
              restaurant={restaurant}
              analytics={analytics}
              onRestaurantChange={(patch) => setRestaurant((r) => ({ ...r, ...patch }))}
              reload={load}
            />
          </Suspense>
        )}
      </div>
    </div>
  )
}
