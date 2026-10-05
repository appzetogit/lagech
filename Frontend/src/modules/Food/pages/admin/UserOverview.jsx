import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { Bike, Loader2, UserCog, Users } from "lucide-react"
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import { toast } from "sonner"
import { customerExtrasAPI, dataOf, errorMessage } from "@food/api/adminCustomerExtras"
import { PageHeader, StatCard } from "./wallet/shared"

const monthLabel = (ym) => {
  const [y, m] = String(ym).split("-").map(Number)
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-IN", { month: "short", year: "2-digit", timeZone: "UTC" })
}

const num = (v) => Number(v || 0).toLocaleString("en-IN")

function MonthlyChart({ title, data, color, empty }) {
  const rows = (data || []).map((d) => ({ month: monthLabel(d.month), count: d.count }))
  const any = rows.some((r) => r.count > 0)
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <h3 className="mb-3 text-sm font-semibold text-slate-800">{title}</h3>
      {!any ? (
        <p className="py-12 text-center text-sm text-slate-500">{empty}</p>
      ) : (
        <div className="h-56">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={rows}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e5e5" />
              <XAxis dataKey="month" tick={{ fontSize: 12 }} />
              <YAxis allowDecimals={false} tick={{ fontSize: 12 }} width={36} />
              <Tooltip formatter={(v) => [num(v), "Joined"]} />
              <Bar dataKey="count" fill={color} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  )
}

/** One bar per part of a whole, e.g. riders by status. */
function Breakdown({ title, parts, total, empty }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <h3 className="mb-4 text-sm font-semibold text-slate-800">{title}</h3>
      {!total ? (
        <p className="py-8 text-center text-sm text-slate-500">{empty}</p>
      ) : (
        <div className="space-y-3">
          {parts.map((p) => (
            <div key={p.label}>
              <div className="mb-1 flex justify-between text-xs text-slate-600">
                <span>{p.label}</span>
                <span className="font-semibold text-slate-800">{num(p.value)}</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-slate-100">
                <div className={`h-full rounded-full ${p.cls}`} style={{ width: `${Math.round((p.value / total) * 100)}%` }} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** Customers, riders and employees at a glance (old panel: Users → User Overview). */
export default function UserOverview() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    customerExtrasAPI
      .getUserOverview()
      .then((res) => setData(dataOf(res)))
      .catch((err) => toast.error(errorMessage(err, "Could not load the user overview")))
      .finally(() => setLoading(false))
  }, [])

  if (loading) {
    return <div className="flex min-h-screen items-center justify-center bg-slate-50"><Loader2 className="h-6 w-6 animate-spin text-slate-400" /></div>
  }

  const c = data?.customers || {}
  const r = data?.riders || {}
  const e = data?.employees || {}

  return (
    <div className="min-h-screen bg-slate-50 p-4 lg:p-6">
      <div className="mx-auto max-w-7xl space-y-6">
        <PageHeader icon={Users} title="User Overview" description="Customers, delivery riders and employees at a glance." />

        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-base font-semibold text-slate-900"><Users className="h-4 w-4 text-blue-600" /> Customers</h2>
            <Link to="/admin/food/customers" className="text-sm font-medium text-blue-600 hover:underline">All customers</Link>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label="Total customers" value={num(c.total)} hint={`${num(c.blocked)} blocked`} />
            <StatCard label="New this month" value={num(c.newThisMonth)} tone="blue" />
            <StatCard label="Ordered in the last 30 days" value={num(c.orderedLast30Days)} tone="green" />
            <StatCard label="Active accounts" value={num(c.active)} />
          </div>
          <MonthlyChart title="Customers joined, last 6 months" data={c.signupsByMonth} color="#0ea5e9" empty="No customers joined in the last 6 months." />
        </section>

        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-base font-semibold text-slate-900"><Bike className="h-4 w-4 text-blue-600" /> Delivery riders</h2>
            <Link to="/admin/food/delivery-partners" className="text-sm font-medium text-blue-600 hover:underline">All riders</Link>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label="Total riders" value={num(r.total)} />
            <StatCard label="Approved" value={num(r.approved)} tone="green" />
            <StatCard label="Online now" value={num(r.onlineNow)} tone="blue" hint="Approved riders taking orders" />
            <StatCard label="Waiting for approval" value={num(r.pending)} />
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <MonthlyChart title="Riders joined, last 6 months" data={r.signupsByMonth} color="#f97316" empty="No riders joined in the last 6 months." />
            <Breakdown
              title="Riders by status"
              total={r.total}
              empty="No riders yet."
              parts={[
                { label: "Approved", value: r.approved || 0, cls: "bg-emerald-500" },
                { label: "Waiting for approval", value: r.pending || 0, cls: "bg-amber-400" },
                { label: "Rejected", value: r.rejected || 0, cls: "bg-rose-400" },
                { label: "Deactivated", value: r.deactivated || 0, cls: "bg-slate-400" },
              ]}
            />
          </div>
        </section>

        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-base font-semibold text-slate-900"><UserCog className="h-4 w-4 text-blue-600" /> Employees</h2>
            <Link to="/admin/food/employees" className="text-sm font-medium text-blue-600 hover:underline">All employees</Link>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <StatCard label="Employees" value={num(e.total)} hint="Admin panel staff accounts" />
            <StatCard label="Active" value={num(e.active)} tone="green" />
            <StatCard label="Inactive" value={num(e.inactive)} />
          </div>
        </section>
      </div>
    </div>
  )
}
