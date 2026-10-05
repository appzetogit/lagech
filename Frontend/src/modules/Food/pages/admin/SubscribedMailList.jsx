import { useEffect, useState } from "react"
import { Download, Loader2, Mail, Search, Trash2 } from "lucide-react"
import { toast } from "sonner"
import {
  customerExtrasAPI,
  dataOf,
  errorMessage,
  formatDateTime,
} from "@food/api/adminCustomerExtras"
import { PageHeader, Pager, inputClass } from "./wallet/shared"

/** Newsletter subscribers (old panel: Subscribed Mail List). */
export default function SubscribedMailList() {
  const [search, setSearch] = useState("")
  const [page, setPage] = useState(1)
  const [reload, setReload] = useState(0)
  const [loading, setLoading] = useState(true)
  const [exporting, setExporting] = useState(false)
  const [data, setData] = useState({ subscribers: [], pagination: null })

  useEffect(() => {
    let cancelled = false
    const timer = setTimeout(async () => {
      try {
        setLoading(true)
        const res = await customerExtrasAPI.getSubscribers({ search: search.trim() || undefined, page, limit: 25 })
        if (!cancelled) setData(dataOf(res))
      } catch (err) {
        if (!cancelled) {
          toast.error(errorMessage(err, "Could not load the subscribers"))
          setData({ subscribers: [], pagination: null })
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [search, page, reload])

  const exportCsv = async () => {
    try {
      setExporting(true)
      const res = await customerExtrasAPI.exportSubscribers({ search: search.trim() || undefined })
      const url = URL.createObjectURL(new Blob([res.data], { type: "text/csv;charset=utf-8" }))
      const a = document.createElement("a")
      a.href = url
      a.download = `subscribed-mail-list-${new Date().toISOString().slice(0, 10)}.csv`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch {
      toast.error("Could not export the list")
    } finally {
      setExporting(false)
    }
  }

  const remove = async (s) => {
    if (!window.confirm(`Remove ${s.email} from the mail list?`)) return
    try {
      await customerExtrasAPI.deleteSubscriber(s.id)
      toast.success("Subscriber removed")
      setReload((n) => n + 1)
    } catch (err) {
      toast.error(errorMessage(err, "Could not remove the subscriber"))
    }
  }

  const rows = data.subscribers || []
  const total = data.pagination?.total ?? rows.length
  const offset = ((data.pagination?.page || 1) - 1) * (data.pagination?.limit || 25)

  return (
    <div className="min-h-screen bg-slate-50 p-4 lg:p-6">
      <div className="mx-auto max-w-5xl space-y-6">
        <PageHeader icon={Mail} title="Subscribed Mail List" description="Email addresses that signed up for the newsletter." />

        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-6 py-4">
            <h2 className="text-base font-semibold text-slate-900">Subscribers <span className="ml-1 text-sm font-normal text-slate-500">{total}</span></h2>
            <div className="flex w-full flex-wrap gap-2 sm:w-auto">
              <div className="relative min-w-0 flex-1 sm:w-64">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input className={`${inputClass} pl-9`} placeholder="Search by email" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1) }} />
              </div>
              <button type="button" onClick={exportCsv} disabled={exporting || !total} className="inline-flex items-center gap-2 rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">
                {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />} Export CSV
              </button>
            </div>
          </div>
          {loading ? (
            <div className="py-16 text-center"><Loader2 className="mx-auto h-6 w-6 animate-spin text-slate-400" /></div>
          ) : !rows.length ? (
            <p className="py-16 text-center text-sm text-slate-500">{search.trim() ? "No subscriber matches that search." : "No one has subscribed to the newsletter yet."}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-left text-xs font-semibold text-slate-600">
                  <tr>
                    <th className="px-6 py-3">#</th>
                    <th className="px-6 py-3">Email</th>
                    <th className="px-6 py-3">Subscribed on</th>
                    <th className="px-6 py-3 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {rows.map((s, i) => (
                    <tr key={s.id}>
                      <td className="px-6 py-3 text-slate-500">{offset + i + 1}</td>
                      <td className="px-6 py-3 font-medium text-slate-800">{s.email}</td>
                      <td className="whitespace-nowrap px-6 py-3 text-slate-600">{formatDateTime(s.createdAt)}</td>
                      <td className="px-6 py-3 text-right">
                        <button type="button" onClick={() => remove(s)} className="rounded-lg border border-slate-300 p-1.5 text-rose-600 hover:bg-rose-50" aria-label={`Remove ${s.email}`}>
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <Pager pagination={data.pagination} onPage={setPage} />
        </div>
      </div>
    </div>
  )
}
