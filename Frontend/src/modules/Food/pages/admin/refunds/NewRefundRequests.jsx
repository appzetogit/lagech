import { useCallback, useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import { adminAPI } from "@food/api"
import {
  CheckCircle,
  ChevronLeft,
  ChevronRight,
  Eye,
  Loader2,
  Search,
  XCircle,
} from "@food/components/admin/theme/icons"
import ExportMenu from "@food/components/admin/ExportMenu"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@food/components/ui/dialog"
import { Textarea } from "@food/components/ui/textarea"
import { exportDate, exportMoney, fetchAllPages } from "@food/utils/listExport"

/**
 * Order Refunds > Refund Requests: what customers asked for from the app.
 *
 * Approving refunds the order through the same path as the order's own Refund
 * button (Razorpay back to the card/UPI, wallet orders to the wallet); cash on
 * delivery, verified offline and QR payments go to the customer's wallet.
 * Rejecting needs a note, which the customer sees.
 */

const PAGE_SIZE = 20

const STATUS_TABS = [
  { value: "", label: "All" },
  { value: "pending", label: "Pending" },
  { value: "refunded", label: "Refunded" },
  { value: "rejected", label: "Rejected" },
]

const STATUS_STYLES = {
  pending: "bg-amber-50 text-amber-700 border-amber-200",
  approved: "bg-blue-50 text-blue-700 border-blue-200",
  refunded: "bg-emerald-50 text-emerald-700 border-emerald-200",
  rejected: "bg-rose-50 text-rose-700 border-rose-200",
}

const STATUS_LABELS = { pending: "Pending", approved: "Processing", refunded: "Refunded", rejected: "Rejected" }
const METHOD_LABELS = { razorpay: "Original payment (Razorpay)", wallet: "Customer wallet" }

const rupees = (value) =>
  `₹${Number(value || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const EXPORT_COLUMNS = [
  { label: "Sl", value: (_row, index) => index + 1 },
  { label: "Order ID", value: (r) => r.orderDisplayId },
  { label: "Requested On", value: (r) => exportDate(r.createdAt) },
  { label: "Customer", value: (r) => r.customer?.name || "" },
  { label: "Phone", value: (r) => r.customer?.phone || "" },
  { label: "Restaurant", value: (r) => r.restaurant?.name || "" },
  { label: "Order Total", value: (r) => exportMoney(r.order?.total) },
  { label: "Payment", value: (r) => `${r.order?.paymentMethod || ""} / ${r.order?.paymentStatus || ""}` },
  { label: "Reason", value: (r) => r.reason },
  { label: "Customer Note", value: (r) => r.note },
  { label: "Requested Amount", value: (r) => exportMoney(r.requestedAmount) },
  { label: "Status", value: (r) => STATUS_LABELS[r.status] || r.status },
  { label: "Refunded Amount", value: (r) => (r.refundedAmount == null ? "" : exportMoney(r.refundedAmount)) },
  { label: "Refunded To", value: (r) => METHOD_LABELS[r.refundMethod] || "" },
  { label: "Admin Note", value: (r) => r.adminNote },
  { label: "Decided On", value: (r) => exportDate(r.decidedAt) },
]

function StatusBadge({ status }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${
        STATUS_STYLES[status] || "bg-slate-50 text-slate-700 border-slate-200"
      }`}
    >
      {STATUS_LABELS[status] || status}
    </span>
  )
}

export default function NewRefundRequests() {
  const [rows, setRows] = useState([])
  const [counts, setCounts] = useState({})
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [restaurants, setRestaurants] = useState([])
  const [searchInput, setSearchInput] = useState("")
  const [filters, setFilters] = useState({ status: "pending", restaurantId: "", from: "", to: "", search: "" })

  const [detail, setDetail] = useState(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [action, setAction] = useState(null) // { type: "approve" | "reject", request }
  const [amount, setAmount] = useState("")
  const [note, setNote] = useState("")
  const [saving, setSaving] = useState(false)

  const params = useMemo(() => {
    const p = {}
    Object.entries(filters).forEach(([key, value]) => {
      if (value) p[key] = value
    })
    return p
  }, [filters])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await adminAPI.getRefundRequests({ ...params, page, limit: PAGE_SIZE })
      const data = res?.data?.data || {}
      setRows(Array.isArray(data.requests) ? data.requests : [])
      setCounts(data.counts || {})
      setTotal(Number(data.pagination?.total) || 0)
    } catch (error) {
      toast.error(error?.response?.data?.message || "Failed to load refund requests")
      setRows([])
      setTotal(0)
    } finally {
      setLoading(false)
    }
  }, [params, page])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    adminAPI
      .getRestaurants({ limit: 1000 })
      .then((res) => {
        const d = res?.data?.data || {}
        const list = d.restaurants || d.items || d.docs || []
        setRestaurants(list.map((r) => ({ id: r.id || r._id, name: r.restaurantName || r.name })).filter((r) => r.id))
      })
      .catch(() => setRestaurants([]))
  }, [])

  const setFilter = (key, value) => {
    setPage(1)
    setFilters((prev) => ({ ...prev, [key]: value }))
  }

  const openDetail = async (request) => {
    setDetail({ ...request, loadingOnly: true })
    setDetailLoading(true)
    try {
      const res = await adminAPI.getRefundRequest(request.id)
      setDetail(res?.data?.data || request)
    } catch (error) {
      toast.error(error?.response?.data?.message || "Failed to load the request")
      setDetail(null)
    } finally {
      setDetailLoading(false)
    }
  }

  const openAction = (type, request) => {
    setAction({ type, request })
    const max = Math.min(Number(request.requestedAmount) || 0, Number(request.order?.refundable) || 0)
    setAmount(type === "approve" ? String(max || "") : "")
    setNote("")
  }

  const submitAction = async () => {
    if (!action) return
    const { type, request } = action
    if (type === "reject" && !note.trim()) {
      toast.error("Write why the refund is rejected; the customer sees it")
      return
    }
    setSaving(true)
    try {
      if (type === "approve") {
        await adminAPI.approveRefundRequest(request.id, { amount: Number(amount), note: note.trim() })
        toast.success("Refund sent")
      } else {
        await adminAPI.rejectRefundRequest(request.id, { note: note.trim() })
        toast.success("Request rejected")
      }
      setAction(null)
      setDetail(null)
      await load()
    } catch (error) {
      toast.error(error?.response?.data?.message || "Could not save")
    } finally {
      setSaving(false)
    }
  }

  const getExportRows = () =>
    fetchAllPages(
      ({ page: p, limit }) => adminAPI.getRefundRequests({ ...params, page: p, limit }),
      (res) => {
        const data = res?.data?.data || {}
        return { rows: data.requests || [], total: data.pagination?.total, pages: data.pagination?.pages }
      },
    )

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const maxApprovable = action?.type === "approve" ? Number(action.request.order?.refundable) || 0 : 0

  return (
    <div className="p-4 lg:p-6 bg-slate-50 min-h-screen">
      <div className="max-w-7xl mx-auto space-y-4">
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <h1 className="text-xl font-bold text-slate-900">Refund Requests</h1>
              <p className="text-sm text-slate-600 mt-1">
                Refunds customers asked for on delivered orders. Approve all or part of it, or reject with a note.
              </p>
            </div>
            <ExportMenu filename="refund_requests" sheetName="Refund Requests" columns={EXPORT_COLUMNS} getRows={getExportRows} />
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            {STATUS_TABS.map((tab) => (
              <button
                key={tab.value || "all"}
                type="button"
                onClick={() => setFilter("status", tab.value)}
                className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors ${
                  filters.status === tab.value
                    ? "border-slate-900 bg-slate-900 text-white"
                    : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                }`}
              >
                {tab.label}
                <span className="ml-1.5 opacity-70">{tab.value ? counts[tab.value] ?? 0 : counts.all ?? 0}</span>
              </button>
            ))}
          </div>

          <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-5">
            <div className="relative md:col-span-2">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <input
                type="text"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && setFilter("search", searchInput.trim())}
                onBlur={() => searchInput.trim() !== filters.search && setFilter("search", searchInput.trim())}
                placeholder="Order ID, customer name or phone"
                className="w-full rounded-lg border border-slate-200 py-2 pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <select
              value={filters.restaurantId}
              onChange={(e) => setFilter("restaurantId", e.target.value)}
              className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm"
            >
              <option value="">All restaurants</option>
              {restaurants.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
            <input
              type="date"
              value={filters.from}
              onChange={(e) => setFilter("from", e.target.value)}
              className="rounded-lg border border-slate-200 px-3 py-2 text-sm"
              aria-label="From date"
            />
            <input
              type="date"
              value={filters.to}
              onChange={(e) => setFilter("to", e.target.value)}
              className="rounded-lg border border-slate-200 px-3 py-2 text-sm"
              aria-label="To date"
            />
          </div>
        </div>

        <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
          {loading ? (
            <div className="flex items-center justify-center py-20">
              <Loader2 className="w-8 h-8 animate-spin text-slate-400" />
            </div>
          ) : rows.length === 0 ? (
            <p className="py-20 text-center text-sm text-slate-500">No refund requests match these filters.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[960px]">
                <thead className="bg-slate-50 border-b border-slate-200">
                  <tr className="text-left text-[11px] font-bold uppercase text-slate-600">
                    <th className="px-4 py-3">SI</th>
                    <th className="px-4 py-3">Order</th>
                    <th className="px-4 py-3">Requested</th>
                    <th className="px-4 py-3">Customer</th>
                    <th className="px-4 py-3">Restaurant</th>
                    <th className="px-4 py-3">Reason</th>
                    <th className="px-4 py-3 text-right">Amount</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3 text-center">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-sm">
                  {rows.map((r, index) => (
                    <tr key={r.id} className="hover:bg-slate-50">
                      <td className="px-4 py-3 text-slate-600">{(page - 1) * PAGE_SIZE + index + 1}</td>
                      <td className="px-4 py-3">
                        <p className="font-medium text-slate-900">#{r.orderDisplayId}</p>
                        <p className="text-xs text-slate-500">
                          {r.order?.paymentMethod} · {r.order?.paymentStatus}
                        </p>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-slate-700">{exportDate(r.createdAt)}</td>
                      <td className="px-4 py-3">
                        <p className="text-slate-800">{r.customer?.name || "-"}</p>
                        <p className="text-xs text-slate-500">{r.customer?.phone}</p>
                      </td>
                      <td className="px-4 py-3 text-slate-700">{r.restaurant?.name || "-"}</td>
                      <td className="px-4 py-3 max-w-[220px]">
                        <p className="text-slate-800 line-clamp-2">{r.reason}</p>
                        {r.images?.length ? <p className="text-xs text-slate-500">{r.images.length} photo(s)</p> : null}
                      </td>
                      <td className="px-4 py-3 text-right whitespace-nowrap">
                        <p className="font-medium text-slate-900">
                          {rupees(r.refundedAmount ?? r.requestedAmount)}
                        </p>
                        <p className="text-xs text-slate-500">of {rupees(r.order?.total)}</p>
                      </td>
                      <td className="px-4 py-3">
                        <StatusBadge status={r.status} />
                        {r.status === "pending" && r.failureReason ? (
                          <p className="mt-1 text-xs text-rose-600 max-w-[160px]">Last try failed: {r.failureReason}</p>
                        ) : null}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-center gap-1.5">
                          <button
                            type="button"
                            title="View"
                            onClick={() => openDetail(r)}
                            className="rounded p-1.5 text-orange-600 hover:bg-orange-50"
                          >
                            <Eye className="w-4 h-4" />
                          </button>
                          {r.status === "pending" ? (
                            <>
                              <button
                                type="button"
                                title="Approve"
                                onClick={() => openAction("approve", r)}
                                className="rounded p-1.5 text-emerald-600 hover:bg-emerald-50"
                              >
                                <CheckCircle className="w-4 h-4" />
                              </button>
                              <button
                                type="button"
                                title="Reject"
                                onClick={() => openAction("reject", r)}
                                className="rounded p-1.5 text-rose-600 hover:bg-rose-50"
                              >
                                <XCircle className="w-4 h-4" />
                              </button>
                            </>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="flex items-center justify-between border-t border-slate-200 px-4 py-3 text-sm text-slate-600">
            <span>{total} request{total === 1 ? "" : "s"}</span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={page <= 1 || loading}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-3 py-1.5 disabled:opacity-50"
              >
                <ChevronLeft className="w-4 h-4" /> Prev
              </button>
              <span>
                Page {page} of {totalPages}
              </span>
              <button
                type="button"
                disabled={page >= totalPages || loading}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-3 py-1.5 disabled:opacity-50"
              >
                Next <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      </div>

      <Dialog open={Boolean(detail)} onOpenChange={(open) => !open && setDetail(null)}>
        <DialogContent className="flex w-[calc(100%-2rem)] max-w-[680px] max-h-[88vh] flex-col overflow-hidden border border-slate-200 bg-white p-0">
          <DialogHeader className="border-b border-slate-200 px-6 py-4 pr-14 text-left">
            <DialogTitle className="text-lg font-semibold text-slate-900">
              Refund request {detail ? `· #${detail.orderDisplayId}` : ""}
            </DialogTitle>
          </DialogHeader>
          {detail ? (
            <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5 text-sm">
              {detailLoading ? (
                <div className="flex justify-center py-10">
                  <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
                </div>
              ) : (
                <>
                  <div className="flex flex-wrap items-center gap-3">
                    <StatusBadge status={detail.status} />
                    <span className="text-slate-500">Requested {exportDate(detail.createdAt)}</span>
                  </div>
                  <section className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <div>
                      <p className="text-xs uppercase tracking-wide text-slate-400">Customer</p>
                      <p className="font-medium text-slate-900">{detail.customer?.name || "-"}</p>
                      <p className="text-slate-600">{detail.customer?.phone}</p>
                    </div>
                    <div>
                      <p className="text-xs uppercase tracking-wide text-slate-400">Restaurant</p>
                      <p className="font-medium text-slate-900">{detail.restaurant?.name || "-"}</p>
                    </div>
                  </section>
                  <section>
                    <p className="text-xs uppercase tracking-wide text-slate-400">Reason</p>
                    <p className="font-medium text-slate-900">{detail.reason}</p>
                    {detail.note ? <p className="mt-1 whitespace-pre-wrap text-slate-700">{detail.note}</p> : null}
                    {detail.images?.length ? (
                      <div className="mt-3 flex flex-wrap gap-2">
                        {detail.images.map((src) => (
                          <a key={src} href={src} target="_blank" rel="noreferrer">
                            <img src={src} alt="Customer photo" className="h-24 w-24 rounded-lg border border-slate-200 object-cover" />
                          </a>
                        ))}
                      </div>
                    ) : null}
                  </section>
                  {detail.order ? (
                    <section className="rounded-lg border border-slate-200 p-4">
                      <p className="mb-2 font-semibold text-slate-900">Order #{detail.order.displayId}</p>
                      {(detail.order.items || []).map((item, i) => (
                        <div key={`${item.name}-${i}`} className="flex justify-between text-slate-700">
                          <span>
                            {item.quantity} × {item.name}
                            {item.variantName ? ` (${item.variantName})` : ""}
                          </span>
                          <span>{rupees(item.price * item.quantity)}</span>
                        </div>
                      ))}
                      <div className="mt-3 space-y-1 border-t border-slate-100 pt-3 text-slate-700">
                        <div className="flex justify-between font-semibold text-slate-900">
                          <span>Order total</span>
                          <span>{rupees(detail.order.total)}</span>
                        </div>
                        <div className="flex justify-between">
                          <span>Payment</span>
                          <span>
                            {detail.order.paymentMethod} · {detail.order.paymentStatus}
                          </span>
                        </div>
                        <div className="flex justify-between">
                          <span>Still refundable</span>
                          <span>{rupees(detail.order.refundable)}</span>
                        </div>
                        <div className="flex justify-between">
                          <span>Refund goes to</span>
                          <span>{METHOD_LABELS[detail.order.refundTo] || "-"}</span>
                        </div>
                        <div className="flex justify-between">
                          <span>Delivered</span>
                          <span>{exportDate(detail.order.deliveredAt) || "-"}</span>
                        </div>
                      </div>
                    </section>
                  ) : null}
                  {detail.status !== "pending" ? (
                    <section>
                      <p className="text-xs uppercase tracking-wide text-slate-400">Decision</p>
                      {detail.refundedAmount != null ? (
                        <p className="text-slate-900">
                          {rupees(detail.refundedAmount)} to {METHOD_LABELS[detail.refundMethod] || detail.refundMethod}
                        </p>
                      ) : null}
                      {detail.adminNote ? <p className="text-slate-700">{detail.adminNote}</p> : null}
                      <p className="text-slate-500">{exportDate(detail.decidedAt)}</p>
                    </section>
                  ) : null}
                  {detail.otherRequests?.length ? (
                    <section>
                      <p className="text-xs uppercase tracking-wide text-slate-400">Earlier requests on this order</p>
                      {detail.otherRequests.map((o) => (
                        <p key={o.id} className="text-slate-700">
                          {exportDate(o.createdAt)} · {STATUS_LABELS[o.status] || o.status} · {o.reason}
                          {o.adminNote ? ` — ${o.adminNote}` : ""}
                        </p>
                      ))}
                    </section>
                  ) : null}
                </>
              )}
            </div>
          ) : null}
          {detail && detail.status === "pending" && !detailLoading ? (
            <DialogFooter className="border-t border-slate-200 px-6 py-4">
              <button
                type="button"
                onClick={() => openAction("reject", detail)}
                className="rounded-lg border border-rose-300 px-4 py-2 text-sm font-medium text-rose-700 hover:bg-rose-50"
              >
                Reject
              </button>
              <button
                type="button"
                onClick={() => openAction("approve", detail)}
                className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700"
              >
                Approve refund
              </button>
            </DialogFooter>
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(action)} onOpenChange={(open) => !open && setAction(null)}>
        <DialogContent className="w-[calc(100%-2rem)] max-w-[520px] overflow-hidden border border-slate-200 bg-white p-0">
          <DialogHeader className="border-b border-slate-200 px-6 py-4 pr-14 text-left">
            <DialogTitle className="text-lg font-semibold text-slate-900">
              {action?.type === "approve" ? "Approve refund" : "Reject refund request"}
            </DialogTitle>
            {action ? (
              <p className="text-sm text-slate-600">
                Order #{action.request.orderDisplayId} · {action.request.reason}
              </p>
            ) : null}
          </DialogHeader>
          <div className="space-y-4 px-6 py-5">
            {action?.type === "approve" ? (
              <div>
                <label className="mb-1 block text-sm font-medium text-slate-700">Amount to refund (₹)</label>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  max={maxApprovable}
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                />
                <p className="mt-1 text-xs text-slate-500">
                  Up to {rupees(maxApprovable)}. Goes to {METHOD_LABELS[action.request.order?.refundTo] || "the customer"}.
                </p>
              </div>
            ) : null}
            <div>
              <label className="mb-1 block text-sm font-medium text-slate-700">
                {action?.type === "approve" ? "Note (optional)" : "Why is it rejected? The customer sees this."}
              </label>
              <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={4} />
            </div>
          </div>
          <DialogFooter className="border-t border-slate-200 px-6 py-4">
            <button
              type="button"
              onClick={() => setAction(null)}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={saving || (action?.type === "approve" && !(Number(amount) > 0 && Number(amount) <= maxApprovable))}
              onClick={submitAction}
              className={`rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-50 ${
                action?.type === "approve" ? "bg-emerald-600 hover:bg-emerald-700" : "bg-rose-600 hover:bg-rose-700"
              }`}
            >
              {saving ? "Saving..." : action?.type === "approve" ? "Refund" : "Reject"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
