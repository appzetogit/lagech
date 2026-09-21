import { useEffect, useState } from "react"
import { useNavigate } from "react-router-dom"
import { Bar, BarChart, CartesianGrid, Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import { Bike, Heart, Loader2, Star, Store, User, UtensilsCrossed } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@food/components/ui/card"
import { adminAPI } from "@food/api"

const rupees = (n) => `₹${Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`
const MONTH = new Intl.DateTimeFormat("en-IN", { month: "short" })
const monthLabel = (key) => MONTH.format(new Date(`${key}-01T00:00:00`))

const STATUS_CARDS = [
  ["pending", "Pending", "#f59e0b", "/admin/food/orders/pending"],
  ["confirmed", "Confirmed", "#6366f1", "/admin/food/orders/processing"],
  ["preparing", "Cooking", "#ec4899", "/admin/food/orders/processing"],
  ["readyForPickup", "Ready for pickup", "#14b8a6", "/admin/food/orders/processing"],
  ["onTheWay", "On the way", "#0ea5e9", "/admin/food/orders/food-on-the-way"],
  ["delivered", "Delivered", "#22c55e", "/admin/food/orders/delivered"],
  ["cancelled", "Cancelled", "#ef4444", "/admin/food/orders/canceled"],
  ["scheduled", "Scheduled", "#8b5cf6", "/admin/food/orders/all"],
]
const SPLIT_COLORS = ["#0ea5e9", "#f97316", "#22c55e"]

/** A round photo, falling back to an icon when there is no image or it fails. */
function Thumb({ src, icon: Icon, square = false }) {
  const [failed, setFailed] = useState(false)
  const shape = square ? "rounded-lg" : "rounded-full"
  if (!src || failed) {
    return (
      <span className={`flex h-11 w-11 shrink-0 items-center justify-center bg-neutral-100 text-neutral-400 ${shape}`}>
        <Icon className="h-5 w-5" />
      </span>
    )
  }
  return <img src={src} alt="" loading="lazy" onError={() => setFailed(true)} className={`h-11 w-11 shrink-0 object-cover border border-neutral-200 ${shape}`} />
}

function RankList({ title, subtitle, rows, icon, square, render, empty = "Nothing yet", onOpen }) {
  return (
    <Card className="border-neutral-200 bg-white">
      <CardHeader className="border-b border-neutral-200 pb-4">
        <CardTitle className="text-lg text-neutral-900">{title}</CardTitle>
        <p className="text-sm text-neutral-500">{subtitle}</p>
      </CardHeader>
      <CardContent className="pt-3">
        {!rows?.length ? (
          <p className="py-8 text-center text-sm text-neutral-400">{empty}</p>
        ) : (
          <ol className="divide-y divide-neutral-100">
            {rows.map((row, index) => {
              const { primary, secondary, value, valueLabel } = render(row)
              return (
                <li
                  key={row.id || index}
                  onClick={onOpen ? () => onOpen(row) : undefined}
                  className={`flex items-center gap-3 py-2.5 ${onOpen ? "cursor-pointer hover:bg-neutral-50 rounded-lg px-1 -mx-1" : ""}`}
                >
                  <span className="w-4 text-xs font-semibold text-neutral-400">{index + 1}</span>
                  <Thumb src={row.image} icon={icon} square={square} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-neutral-900">{primary}</p>
                    {secondary && <p className="truncate text-xs text-neutral-500">{secondary}</p>}
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-semibold text-neutral-900">{value}</p>
                    <p className="text-[11px] text-neutral-500">{valueLabel}</p>
                  </div>
                </li>
              )
            })}
          </ol>
        )}
      </CardContent>
    </Card>
  )
}

const stars = (rating, count) => (
  <span className="inline-flex items-center gap-1">
    <Star className="h-3.5 w-3.5 fill-amber-400 text-amber-400" />
    {Number(rating || 0).toFixed(1)}
    {count != null && <span className="text-neutral-400">({count})</span>}
  </span>
)

/**
 * The lists and charts the previous admin dashboard had: order states, user
 * split, earnings by month and the top dishes, restaurants, riders and
 * customers, with their photos. Follows the page's zone and period filters.
 */
export default function DashboardInsights({ zoneId, period }) {
  const navigate = useNavigate()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setFailed(false)
    adminAPI
      .getDashboardInsights({ period: period === "overall" ? "all" : period, ...(zoneId && zoneId !== "all" ? { zoneId } : {}) })
      .then((res) => {
        if (!cancelled) setData(res?.data?.data || null)
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [zoneId, period])

  if (loading && !data) {
    return (
      <div className="flex justify-center py-10">
        <Loader2 className="h-6 w-6 animate-spin text-neutral-400" />
      </div>
    )
  }
  if (failed && !data) {
    return <p className="py-6 text-center text-sm text-neutral-500">Couldn't load the top lists. Refresh to try again.</p>
  }
  if (!data) return null

  const split = [
    { name: "Customers", value: data.userSplit.customers },
    { name: "Restaurants", value: data.userSplit.restaurants },
    { name: "Delivery partners", value: data.userSplit.riders },
  ]
  const earnings = data.earnings.map((m) => ({ ...m, label: monthLabel(m.month) }))
  const openRestaurant = (row) => navigate(`/admin/food/restaurants/edit/${row.id}`)

  return (
    <div className={`space-y-6 transition-opacity ${loading ? "opacity-60" : ""}`}>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {STATUS_CARDS.map(([key, label, color, path]) => (
          <button
            key={key}
            type="button"
            onClick={() => navigate(path)}
            className="flex items-center justify-between rounded-xl border border-neutral-200 bg-white px-4 py-3 text-left hover:bg-neutral-50"
          >
            <span className="flex items-center gap-2 text-sm text-neutral-700">
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: color }} />
              {label}
            </span>
            <span className="text-lg font-semibold text-neutral-900">{Number(data.orderStatus[key] || 0).toLocaleString("en-IN")}</span>
          </button>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="border-neutral-200 bg-white lg:col-span-2">
          <CardHeader className="border-b border-neutral-200 pb-4">
            <CardTitle className="text-lg text-neutral-900">Earnings by month</CardTitle>
            <p className="text-sm text-neutral-500">Last 12 months, delivered orders. Delivery margin is the delivery fee minus the rider's pay.</p>
          </CardHeader>
          <CardContent className="h-72 pt-4">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={earnings}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e5e5" />
                <XAxis dataKey="label" tick={{ fontSize: 12 }} />
                <YAxis tick={{ fontSize: 12 }} tickFormatter={(v) => (v >= 1000 ? `${Math.round(v / 1000)}k` : v)} />
                <Tooltip formatter={(v) => rupees(v)} />
                <Legend />
                <Bar dataKey="commission" name="Commission" fill="#0ea5e9" radius={[4, 4, 0, 0]} />
                <Bar dataKey="deliveryMargin" name="Delivery margin" fill="#f97316" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card className="border-neutral-200 bg-white">
          <CardHeader className="border-b border-neutral-200 pb-4">
            <CardTitle className="text-lg text-neutral-900">Users</CardTitle>
            <p className="text-sm text-neutral-500">Customers, approved restaurants and riders</p>
          </CardHeader>
          <CardContent className="h-72 pt-4">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={split} dataKey="value" nameKey="name" innerRadius={55} outerRadius={85} paddingAngle={2}>
                  {split.map((entry, i) => <Cell key={entry.name} fill={SPLIT_COLORS[i]} />)}
                </Pie>
                <Tooltip formatter={(v) => Number(v).toLocaleString("en-IN")} />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-3">
        <RankList
          title="Top selling foods"
          subtitle="Most ordered dishes"
          rows={data.topSellingFoods}
          icon={UtensilsCrossed}
          square
          render={(r) => ({ primary: r.name, secondary: r.restaurantName, value: r.sold.toLocaleString("en-IN"), valueLabel: "sold" })}
        />
        <RankList
          title="Top rated foods"
          subtitle="Best customer ratings"
          rows={data.topRatedFoods}
          icon={UtensilsCrossed}
          square
          render={(r) => ({ primary: r.name, secondary: r.restaurantName, value: stars(r.rating), valueLabel: `${r.totalRatings} reviews` })}
        />
        <RankList
          title="Most popular restaurants"
          subtitle="Saved as favourite by the most customers"
          rows={data.popularRestaurants}
          icon={Store}
          onOpen={openRestaurant}
          render={(r) => ({
            primary: r.name,
            secondary: stars(r.rating),
            value: <span className="inline-flex items-center gap-1"><Heart className="h-3.5 w-3.5 fill-rose-500 text-rose-500" />{r.favourites}</span>,
            valueLabel: "favourites",
          })}
        />
        <RankList
          title="Top restaurants"
          subtitle="Most delivered orders"
          rows={data.topRestaurants}
          icon={Store}
          onOpen={openRestaurant}
          render={(r) => ({ primary: r.name, secondary: rupees(r.sales), value: r.orders.toLocaleString("en-IN"), valueLabel: "orders" })}
        />
        <RankList
          title="Top delivery partners"
          subtitle="Most orders delivered"
          rows={data.topRiders}
          icon={Bike}
          render={(r) => ({ primary: r.name, secondary: r.rating ? stars(r.rating) : r.phone, value: r.orders.toLocaleString("en-IN"), valueLabel: "delivered" })}
        />
        <RankList
          title="Top customers"
          subtitle="Most delivered orders"
          rows={data.topCustomers}
          icon={User}
          render={(r) => ({ primary: r.name || r.phone, secondary: rupees(r.spent), value: r.orders.toLocaleString("en-IN"), valueLabel: "orders" })}
        />
      </div>
    </div>
  )
}
