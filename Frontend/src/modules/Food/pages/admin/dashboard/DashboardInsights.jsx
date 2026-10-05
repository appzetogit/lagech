import { useEffect, useState } from "react"
import { useNavigate } from "react-router-dom"
import { Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import { Loader2 } from "lucide-react"
import { adminAPI } from "@food/api"

const rupees = (n) => `₹${Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`
const count = (n) => Number(n || 0).toLocaleString("en-IN")
const MONTH = new Intl.DateTimeFormat("en-IN", { month: "short" })
const monthLabel = (key) => MONTH.format(new Date(`${key}-01T00:00:00`))

// Colours of the previous panel's earning chart and user donut.
const SERIES = [
  ["grossSale", "Gross Sale", "#64E1A0"],
  ["commission", "Admin Comission", "#FF6D6D"],
  ["deliveryMargin", "Delivery Comission", "#005555"],
]
const SPLIT_COLORS = ["#005555", "#00AA96", "#B9E0E0"]

/** An image that falls back to a TIO glyph when missing or broken. */
function Thumb({ src, glyph, className = "", contain = false }) {
  const [failed, setFailed] = useState(false)
  if (!src || failed) {
    return (
      <span className={`flex shrink-0 items-center justify-center bg-[#F3F4F5] text-[#99A7BA] ${className}`}>
        <i className={`tio-${glyph} text-2xl`} />
      </span>
    )
  }
  return (
    <img
      src={src}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
      className={`shrink-0 ${contain ? "object-contain bg-white" : "object-cover"} ${className}`}
    />
  )
}

/** A dashboard card in the old panel's style: title, "View All", body. */
function Panel({ title, viewAll, children, empty }) {
  const navigate = useNavigate()
  return (
    <div className="flex flex-col rounded-xl border border-[#E7EAF3] bg-white shadow-[0_6px_12px_rgba(140,152,164,0.075)]">
      <div className="flex items-center justify-between border-b border-[#E7EAF3] px-6 py-5">
        <h5 className="text-[17px] font-semibold text-[#334257]">{title}</h5>
        {viewAll && (
          <button type="button" onClick={() => navigate(viewAll)} className="text-sm font-medium text-[#0177CD] hover:underline">
            View All
          </button>
        )}
      </div>
      <div className="flex-1 p-5">
        {empty ? <p className="py-10 text-center text-sm text-[#99A7BA]">No data yet</p> : children}
      </div>
    </div>
  )
}

function Row({ image, glyph, name, onClick, children }) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className="flex w-full items-center gap-3 rounded-lg py-2 text-left transition-colors hover:bg-[#F9FAFC]"
      >
        <Thumb src={image} glyph={glyph} className="h-[60px] w-[60px] rounded-[5px] border border-[#E7EAF3]" />
        <span className="min-w-0 flex-1 truncate text-[15px] font-semibold text-[#334257]" title={name}>
          {name}
        </span>
        {children}
      </button>
    </li>
  )
}

/** Avatar cards, as the old panel shows its top delivery men and customers. */
function PersonGrid({ rows, glyph, onOpen, line }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {rows.map((row) => (
        <button
          key={row.id}
          type="button"
          onClick={() => onOpen(row)}
          className="flex flex-col items-center rounded-[10px] border border-[#E7EAF3] bg-white px-2 pb-3 pt-4 text-center transition-shadow hover:shadow-md"
        >
          <Thumb src={row.image} glyph={glyph} className="h-14 w-14 rounded-full border border-[#E7EAF3]" />
          <span className="mt-2 w-full truncate text-[13px] font-semibold text-[#334257]" title={row.name || row.phone}>
            {row.name || row.phone || "—"}
          </span>
          <span className="mt-2 rounded-[5px] bg-[#E8F6F4] px-2.5 py-1 text-xs font-semibold text-[#00AA96]">{line(row)}</span>
        </button>
      ))}
    </div>
  )
}

/**
 * The lower half of the old panel's food dashboard: earning statistics, user
 * statistics, and the six top lists with their photos. Follows the page's
 * zone and period filters.
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
        <Loader2 className="h-6 w-6 animate-spin text-[#99A7BA]" />
      </div>
    )
  }
  if (failed && !data) {
    return <p className="py-6 text-center text-sm text-[#677788]">Couldn't load the dashboard lists. Refresh to try again.</p>
  }
  if (!data) return null

  const split = [
    { name: "Customer", value: data.userSplit.customers },
    { name: "Restaurant", value: data.userSplit.restaurants },
    { name: "Delivery man", value: data.userSplit.riders },
  ]
  const splitTotal = split.reduce((sum, s) => sum + (s.value || 0), 0)
  const earnings = data.earnings.map((m) => ({ ...m, label: monthLabel(m.month) }))
  const openRestaurant = (row) => navigate(`/admin/food/restaurants/edit/${row.id}`)
  const openFood = () => navigate("/admin/food/foods")

  return (
    <div className={`space-y-6 transition-opacity ${loading ? "opacity-60" : ""}`}>
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="rounded-xl border border-[#E7EAF3] bg-white p-6 shadow-[0_6px_12px_rgba(140,152,164,0.075)] lg:col-span-2">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <h5 className="text-[17px] font-semibold text-[#334257]">Yearly Statistics</h5>
            <span className="text-[13px] text-[#677788]">Last 12 months, delivered orders</span>
          </div>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={earnings} barGap={2}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#E7EAF3" />
                <XAxis dataKey="label" tick={{ fontSize: 12, fill: "#677788" }} axisLine={false} tickLine={false} />
                <YAxis
                  tick={{ fontSize: 12, fill: "#677788" }}
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={(v) => (v >= 1000 ? `${Math.round(v / 1000)}k` : v)}
                />
                <Tooltip formatter={(v) => rupees(v)} cursor={{ fill: "#F9FAFC" }} />
                {SERIES.map(([key, name, color]) => (
                  <Bar key={key} dataKey={key} name={name} fill={color} radius={[3, 3, 0, 0]} maxBarSize={14} />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="mt-2 flex flex-wrap justify-center gap-4 text-sm text-[#334257]">
            {SERIES.map(([key, name, color]) => (
              <span key={key} className="inline-flex items-center gap-1.5">
                <span className="h-3 w-3 rounded-full" style={{ background: color }} />
                {name}
              </span>
            ))}
          </div>
        </div>

        <div className="rounded-xl border border-[#E7EAF3] bg-white p-6 shadow-[0_6px_12px_rgba(140,152,164,0.075)]">
          <h5 className="text-[17px] font-semibold text-[#334257]">User Statistics</h5>
          <div className="relative h-56">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={split} dataKey="value" nameKey="name" innerRadius={62} outerRadius={88} paddingAngle={2} stroke="none">
                  {split.map((entry, i) => <Cell key={entry.name} fill={SPLIT_COLORS[i]} />)}
                </Pie>
                <Tooltip formatter={(v) => count(v)} />
              </PieChart>
            </ResponsiveContainer>
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
              <span className="text-2xl font-bold text-[#334257]">{count(splitTotal)}</span>
              <span className="text-xs text-[#677788]">Total users</span>
            </div>
          </div>
          <ul className="mt-2 space-y-2 text-sm">
            {split.map((s, i) => (
              <li key={s.name} className="flex items-center justify-between text-[#334257]">
                <span className="inline-flex items-center gap-2">
                  <span className="h-3 w-3 rounded-full" style={{ background: SPLIT_COLORS[i] }} />
                  {s.name}
                </span>
                <span className="font-semibold">{count(s.value)}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-3">
        <Panel title="Top Selling Stores" viewAll="/admin/food/restaurants" empty={!data.topRestaurants?.length}>
          <div className="grid grid-cols-2 gap-4">
            {(data.topRestaurants || []).map((r) => (
              <button
                key={r.id}
                type="button"
                title={`${r.name} · ${count(r.orders)} orders`}
                onClick={() => openRestaurant(r)}
                className="group relative overflow-hidden rounded-[10px] bg-white p-2 shadow-[0_3px_10px_rgba(51,66,87,0.1)] transition-shadow hover:shadow-md"
              >
                <Thumb src={r.image} glyph="shop" contain className="h-[124px] w-full rounded-md" />
                <span className="absolute inset-x-0 bottom-0 translate-y-full truncate bg-[#005555]/90 px-2 py-1 text-xs font-medium text-white transition-transform group-hover:translate-y-0">
                  {r.name} · {count(r.orders)} orders
                </span>
              </button>
            ))}
          </div>
        </Panel>

        <Panel title="Most Popular Restaurants" viewAll="/admin/food/restaurants" empty={!data.popularRestaurants?.length}>
          <ul className="space-y-2">
            {(data.popularRestaurants || []).map((r) => (
              <Row key={r.id} image={r.image} glyph="shop" name={r.name} onClick={() => openRestaurant(r)}>
                <span className="inline-flex items-center gap-1.5 text-[17px] font-medium text-[#FF6D6D]">
                  {count(r.favourites)}
                  <i className="tio-heart text-lg" />
                </span>
              </Row>
            ))}
          </ul>
        </Panel>

        <Panel title="Top Selling Foods" viewAll="/admin/food/foods" empty={!data.topSellingFoods?.length}>
          <ul className="space-y-2">
            {(data.topSellingFoods || []).map((f) => (
              <Row key={f.id} image={f.image} glyph="meal-outlined" name={f.name} onClick={openFood}>
                <span className="shrink-0 rounded-[5px] bg-[#E8F6F4] px-4 py-2 text-sm font-semibold text-[#00AA96]">
                  Sold : {count(f.sold)}
                </span>
              </Row>
            ))}
          </ul>
        </Panel>

        <Panel title="Most Rated Foods" viewAll="/admin/food/foods" empty={!data.topRatedFoods?.length}>
          <ul className="space-y-2">
            {(data.topRatedFoods || []).map((f) => (
              <Row key={f.id} image={f.image} glyph="meal-outlined" name={f.name} onClick={openFood}>
                <span className="shrink-0 text-right">
                  <span className="inline-flex items-center gap-1 text-[15px] font-semibold text-[#FF6D6D]">
                    {Number(f.rating || 0).toFixed(1)}
                    <i className="tio-star" />
                  </span>
                  <span className="block text-xs text-[#677788]">({count(f.totalRatings)} reviews)</span>
                </span>
              </Row>
            ))}
          </ul>
        </Panel>

        <Panel title="Top Deliveryman" viewAll="/admin/food/delivery-partners" empty={!data.topRiders?.length}>
          <PersonGrid
            rows={data.topRiders || []}
            glyph="user"
            onOpen={() => navigate("/admin/food/delivery-partners")}
            line={(r) => `Orders : ${count(r.orders)}`}
          />
        </Panel>

        <Panel title="Top Customers" viewAll="/admin/food/customers" empty={!data.topCustomers?.length}>
          <PersonGrid
            rows={data.topCustomers || []}
            glyph="user"
            onOpen={() => navigate("/admin/food/customers")}
            line={(c) => `Orders : ${count(c.orders)}`}
          />
        </Panel>
      </div>
    </div>
  )
}
