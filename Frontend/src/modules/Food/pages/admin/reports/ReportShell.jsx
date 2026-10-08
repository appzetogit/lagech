import { useEffect, useState } from "react"
import { Loader2 } from "@food/components/admin/theme/icons"
import { toast } from "sonner"
import { adminAPI } from "@food/api"
import ExportMenu from "@food/components/admin/ExportMenu"
import { fetchAllPages } from "@food/utils/listExport"

export const rupees = (value) =>
  `₹${Number(value || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const isoDay = (date) => {
  const d = new Date(date)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

const PRESETS = [
  ["Today", 0],
  ["Last 7 days", 6],
  ["Last 30 days", 29],
  ["Last 90 days", 89],
  ["This year", "year"],
]

const rangeFor = (preset) => {
  const to = new Date()
  const from = new Date()
  if (preset === "year") from.setMonth(0, 1)
  else from.setDate(from.getDate() - preset)
  return { from: isoDay(from), to: isoDay(to) }
}

/** Rows to CSV, quoted, and downloaded. */
export function downloadCsv(filename, columns, rows) {
  const quote = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`
  const lines = [columns.map((c) => quote(c.label)).join(",")]
  for (const row of rows) lines.push(columns.map((c) => quote(c.csv ? c.csv(row) : row[c.key])).join(","))
  const blob = new Blob([`﻿${lines.join("\n")}`], { type: "text/csv;charset=utf-8" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

/**
 * The frame every money report shares: period and restaurant filters, total
 * tiles, a table, paging and Excel/CSV export. `load(params)` fetches one page;
 * export walks every page with the same filters.
 */
export default function ReportShell({ title, icon: Icon, description, load, tiles, columns, rowsKey, csvName, extraFilters = null, filterState = {} }) {
  const [range, setRange] = useState(rangeFor(29))
  const [restaurantId, setRestaurantId] = useState("")
  const [restaurants, setRestaurants] = useState([])
  const [page, setPage] = useState(1)
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    adminAPI
      .getRestaurants({ limit: 1000 })
      .then((res) => {
        const d = res?.data?.data || {}
        const list = d.restaurants || d.items || d.docs || (Array.isArray(d) ? d : [])
        setRestaurants(list.map((r) => ({ id: r.id || r._id, name: r.restaurantName || r.name })).filter((r) => r.id))
      })
      .catch(() => setRestaurants([]))
  }, [])

  const params = { ...range, restaurantId: restaurantId || undefined, ...filterState }

  useEffect(() => {
    let alive = true
    setLoading(true)
    load({ ...params, page, limit: 50 })
      .then((res) => alive && setData(res?.data?.data || null))
      .catch((err) => alive && toast.error(err?.response?.data?.message || `Failed to load ${title}`))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [range.from, range.to, restaurantId, page, JSON.stringify(filterState)])

  const rows = data?.[rowsKey] || []
  const pages = data?.pagination?.pages || 1

  const exportColumns = columns.map((c) => ({ label: c.label, value: (r) => (c.csv ? c.csv(r) : r[c.key]) }))
  const exportAll = () =>
    fetchAllPages(
      ({ page: p, limit }) => load({ ...params, page: p, limit }),
      (res) => {
        const d = res?.data?.data || {}
        return { rows: d[rowsKey] || [], total: d.pagination?.total, pages: d.pagination?.pages }
      },
    )

  const input = "rounded-lg border border-slate-300 px-3 py-2 text-sm bg-white"

  return (
    <div className="p-4 lg:p-6 bg-slate-50 min-h-screen">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
          <div className="flex items-center gap-3">
            {Icon && <Icon className="w-5 h-5 text-teal-700" />}
            <h1 className="text-2xl font-bold text-slate-900">{title}</h1>
          </div>
          {description && <p className="text-sm text-slate-600 mt-1 max-w-3xl">{description}</p>}
          <div className="mt-5 flex flex-wrap items-end gap-3">
            <label className="space-y-1">
              <span className="block text-[11px] font-semibold uppercase tracking-wide text-slate-500">From</span>
              <input type="date" className={input} value={range.from} onChange={(e) => { setRange((r) => ({ ...r, from: e.target.value })); setPage(1) }} />
            </label>
            <label className="space-y-1">
              <span className="block text-[11px] font-semibold uppercase tracking-wide text-slate-500">To</span>
              <input type="date" className={input} value={range.to} onChange={(e) => { setRange((r) => ({ ...r, to: e.target.value })); setPage(1) }} />
            </label>
            <div className="flex flex-wrap gap-1.5">
              {PRESETS.map(([label, preset]) => (
                <button key={label} type="button" onClick={() => { setRange(rangeFor(preset)); setPage(1) }} className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-100">
                  {label}
                </button>
              ))}
            </div>
            <label className="space-y-1">
              <span className="block text-[11px] font-semibold uppercase tracking-wide text-slate-500">Restaurant</span>
              <select className={input} value={restaurantId} onChange={(e) => { setRestaurantId(e.target.value); setPage(1) }}>
                <option value="">All restaurants</option>
                {restaurants.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </label>
            {extraFilters}
            <ExportMenu
              className="ml-auto"
              filename={`${csvName}-${range.from}-to-${range.to}`}
              sheetName={title}
              columns={exportColumns}
              getRows={exportAll}
              disabled={!rows.length}
            />
          </div>
        </div>

        {data && (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {tiles(data).map(([label, value, emphasis]) => (
              <div key={label} className={`rounded-xl border p-4 ${emphasis ? "border-teal-600 bg-teal-50" : "border-slate-200 bg-white"}`}>
                <p className="text-xs font-medium text-slate-500">{label}</p>
                <p className="mt-1 text-xl font-bold text-slate-900">{value}</p>
              </div>
            ))}
          </div>
        )}

        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
          {loading ? (
            <div className="py-16 text-center"><Loader2 className="w-7 h-7 animate-spin text-teal-600 mx-auto" /></div>
          ) : !rows.length ? (
            <p className="py-16 text-center text-sm text-slate-500">Nothing in this period.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-slate-50 border-b border-slate-200">
                  <tr>
                    {columns.map((c) => (
                      <th key={c.key} className={`px-4 py-3 text-[10px] font-bold uppercase tracking-wider text-slate-700 ${c.align === "right" ? "text-right" : "text-left"}`}>{c.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {rows.map((row, i) => (
                    <tr key={i} className="hover:bg-slate-50">
                      {columns.map((c) => (
                        <td key={c.key} className={`px-4 py-3 text-sm text-slate-700 whitespace-nowrap ${c.align === "right" ? "text-right" : ""}`}>{c.render ? c.render(row) : row[c.key]}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {pages > 1 && (
            <div className="flex items-center justify-between mt-4 pt-4 border-t border-slate-200">
              <p className="text-sm text-slate-600">Page {page} of {pages}</p>
              <div className="flex gap-2">
                <button type="button" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1} className="px-4 py-2 text-sm rounded-lg border border-slate-300 disabled:opacity-50">Previous</button>
                <button type="button" onClick={() => setPage((p) => Math.min(pages, p + 1))} disabled={page >= pages} className="px-4 py-2 text-sm rounded-lg border border-slate-300 disabled:opacity-50">Next</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
