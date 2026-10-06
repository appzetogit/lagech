import { useEffect, useRef, useState } from "react"
import { Link } from "react-router-dom"
import { Loader2, Wallet } from "@food/components/admin/theme/icons"
import { toast } from "sonner"
import {
  customerExtrasAPI,
  dataOf,
  errorMessage,
  formatDateTime,
  formatMoney,
  newRequestId,
} from "@food/api/adminCustomerExtras"
import { CustomerPicker, PageHeader, inputClass } from "./shared"

/** Admin credits a customer's wallet (old panel: Customer Wallet → Add Fund). */
export default function AddFund() {
  const [customer, setCustomer] = useState(null)
  const [amount, setAmount] = useState("")
  const [reference, setReference] = useState("")
  const [saving, setSaving] = useState(false)
  const [recent, setRecent] = useState([])
  const [loadingRecent, setLoadingRecent] = useState(true)
  // One id per filled-in form: a double click or a retry after a timeout
  // reaches the server with the same id and credits once.
  const requestId = useRef(newRequestId())

  const loadRecent = async () => {
    try {
      setLoadingRecent(true)
      const res = await customerExtrasAPI.getWalletTransactions({ source: "add_fund", limit: 10 })
      setRecent(dataOf(res).transactions || [])
    } catch {
      setRecent([])
    } finally {
      setLoadingRecent(false)
    }
  }

  useEffect(() => {
    loadRecent()
  }, [])

  const reset = () => {
    setCustomer(null)
    setAmount("")
    setReference("")
    requestId.current = newRequestId()
  }

  const submit = async (e) => {
    e.preventDefault()
    if (!customer) {
      toast.error("Choose a customer")
      return
    }
    const value = Number(amount)
    if (!(value > 0)) {
      toast.error("Enter an amount greater than 0")
      return
    }
    if (!window.confirm(`Add ${formatMoney(value)} to the wallet of ${customer.name || customer.phone}?`)) return
    try {
      setSaving(true)
      const res = await customerExtrasAPI.addFund({ userId: customer.id, amount: value, reference, requestId: requestId.current })
      const balance = dataOf(res).walletBalance
      toast.success(`Added. Wallet balance is now ${formatMoney(balance)}`)
      reset()
      loadRecent()
    } catch (err) {
      toast.error(errorMessage(err, "Could not add the fund"))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="min-h-screen bg-slate-50 p-4 lg:p-6">
      <div className="mx-auto max-w-5xl space-y-6">
        <PageHeader
          icon={Wallet}
          title="Add Fund"
          description="Credit a customer's wallet. It shows in their app's wallet straight away and is recorded with your name."
        />

        <form onSubmit={submit} className="space-y-5 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="grid gap-5 md:grid-cols-2">
            <label className="block space-y-1.5 md:col-span-2">
              <span className="text-sm font-semibold text-slate-700">Customer <span className="text-red-500">*</span></span>
              <CustomerPicker
                value={customer}
                showBalance
                onChange={(c) => {
                  setCustomer(c)
                  requestId.current = newRequestId()
                }}
              />
            </label>
            <label className="block space-y-1.5">
              <span className="text-sm font-semibold text-slate-700">Amount (₹) <span className="text-red-500">*</span></span>
              <input
                type="number"
                min="0.01"
                step="0.01"
                className={inputClass}
                value={amount}
                onChange={(e) => {
                  setAmount(e.target.value)
                  requestId.current = newRequestId()
                }}
                placeholder="Amount to add"
                required
              />
            </label>
            <label className="block space-y-1.5">
              <span className="text-sm font-semibold text-slate-700">Reference</span>
              <input
                className={inputClass}
                maxLength={200}
                value={reference}
                onChange={(e) => {
                  setReference(e.target.value)
                  requestId.current = newRequestId()
                }}
                placeholder="Why the money is being added (optional)"
              />
            </label>
          </div>
          <div className="flex justify-end gap-3">
            <button type="button" onClick={reset} className="rounded-lg border border-slate-300 px-5 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">
              Reset
            </button>
            <button type="submit" disabled={saving} className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60">
              {saving && <Loader2 className="h-4 w-4 animate-spin" />} Add fund
            </button>
          </div>
        </form>

        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
            <h2 className="text-base font-semibold text-slate-900">Recently added by admins</h2>
            <Link to="/admin/food/wallet/report?source=add_fund" className="text-sm font-medium text-blue-600 hover:underline">
              Full report
            </Link>
          </div>
          {loadingRecent ? (
            <div className="py-10 text-center"><Loader2 className="mx-auto h-5 w-5 animate-spin text-slate-400" /></div>
          ) : !recent.length ? (
            <p className="py-10 text-center text-sm text-slate-500">No funds have been added by an admin yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-left text-xs font-semibold text-slate-600">
                  <tr>
                    <th className="px-6 py-3">Date</th>
                    <th className="px-6 py-3">Customer</th>
                    <th className="px-6 py-3 text-right">Amount</th>
                    <th className="px-6 py-3">Reference</th>
                    <th className="px-6 py-3">Added by</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {recent.map((t) => (
                    <tr key={t.id}>
                      <td className="whitespace-nowrap px-6 py-3 text-slate-600">{formatDateTime(t.createdAt)}</td>
                      <td className="px-6 py-3">
                        <div className="font-medium text-slate-800">{t.customer?.name || "Unnamed customer"}</div>
                        <div className="text-xs text-slate-500">{t.customer?.phone}</div>
                      </td>
                      <td className="whitespace-nowrap px-6 py-3 text-right font-semibold text-emerald-700">{formatMoney(t.amount)}</td>
                      <td className="px-6 py-3 text-slate-600">{t.reference || "—"}</td>
                      <td className="px-6 py-3 text-slate-600">{t.addedBy || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
