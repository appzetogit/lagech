import { useCallback, useEffect, useState } from "react"
import { toast } from "sonner"
import {
  Banknote, Building2, Clock, CreditCard, Loader2, Mail, MapPin, Phone, Star, Store, User, Wallet, X,
} from "@food/components/admin/theme/icons"
import { adminSystemExtrasAPI } from "@food/api/adminSystemExtras"
import { zoneLabel } from "@food/utils/entityLabels"
import { Panel, Spinner, errorMessage, formatDate, mediaUrl, newRequestKey, payload, rupees } from "./shared"

/**
 * Overview: Store Info, Performance Evaluation, the money cards with
 * "Collect Cash From Store", a second Store Info block with the map, Owner
 * info and the bank / payout details -- the old panel's first tab.
 */

const METHODS = [
  ["cash", "Cash"],
  ["bank_transfer", "Bank transfer"],
  ["upi", "UPI"],
  ["cheque", "Cheque"],
  ["other", "Other"],
]

const restaurantAddress = (r) =>
  r?.location?.formattedAddress ||
  r?.formattedAddress ||
  [r?.addressLine1, r?.addressLine2, r?.area, r?.city, r?.state, r?.pincode].filter(Boolean).join(", ") ||
  ""

const restaurantZone = (r) => zoneLabel(r?.zone?.name || r?.zone?.zoneName || "") || "-"

const coverOf = (r) =>
  mediaUrl(r?.coverImage) ||
  (Array.isArray(r?.coverImages) ? r.coverImages.map(mediaUrl).find(Boolean) : "") ||
  ""

function InfoLine({ icon: Icon, tone, label, value, href }) {
  return (
    <div className="flex min-w-0 items-start gap-3">
      <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-white ${tone}`}>
        <Icon className="w-4 h-4" />
      </span>
      <div className="min-w-0">
        <p className="text-sm font-semibold text-slate-800">{label}</p>
        {href && value ? (
          <a href={href} className="block break-words text-xs text-teal-700 hover:underline">{value}</a>
        ) : (
          <p className="break-words text-xs text-slate-500">{value || "-"}</p>
        )}
      </div>
    </div>
  )
}

function StoreInfoCard({ restaurant }) {
  const cover = coverOf(restaurant)
  const logo = mediaUrl(restaurant?.profileImage)
  const phone = restaurant?.primaryContactNumber || restaurant?.ownerPhone
  return (
    <Panel title="Store Info" icon={Store} bodyClassName="p-4">
      <div className="overflow-hidden rounded-xl border border-slate-100">
        <div className="relative h-32 bg-slate-100 sm:h-40">
          {cover && <img src={cover} alt="" className="h-full w-full object-cover" />}
          <div className="absolute -bottom-10 left-4 flex h-24 w-24 items-center justify-center overflow-hidden rounded-xl border-4 border-white bg-white shadow">
            {logo ? <img src={logo} alt="" className="h-full w-full object-cover" /> : <Store className="w-8 h-8 text-slate-300" />}
          </div>
        </div>
        <div className="space-y-4 px-4 pb-4 pt-12">
          <div>
            <p className="text-base font-semibold text-slate-900">{restaurant?.restaurantName}</p>
            <p className="text-xs text-slate-500">Created at {formatDate(restaurant?.createdAt)}</p>
          </div>
          <InfoLine icon={MapPin} tone="bg-emerald-500" label="Zone" value={restaurantZone(restaurant)} />
          <InfoLine icon={Phone} tone="bg-orange-500" label="Phone" value={phone} href={phone ? `tel:${phone}` : ""} />
          <InfoLine icon={Mail} tone="bg-rose-500" label="Email" value={restaurant?.ownerEmail} href={restaurant?.ownerEmail ? `mailto:${restaurant.ownerEmail}` : ""} />
          <InfoLine icon={MapPin} tone="bg-sky-500" label="Address" value={restaurantAddress(restaurant)} />
        </div>
      </div>
    </Panel>
  )
}

function PerformanceCard({ restaurant, analytics }) {
  const a = analytics?.analytics || {}
  const rating = Number(a.averageRating ?? restaurant?.rating ?? 0)
  const reviewCount = Number(a.totalRatings ?? restaurant?.totalRatings ?? 0)
  const stats = [
    ["Total orders", a.totalOrders],
    ["Delivered", a.completedOrders],
    ["Cancelled", a.cancelledOrders],
    ["In progress", a.inProgressOrders],
    ["Customers", a.totalCustomers],
    ["Repeat customers", a.repeatCustomers],
  ]
  return (
    <Panel title="Performance Evaluation" icon={Star}>
      {!analytics ? (
        <p className="text-xs text-slate-500">Order figures could not be loaded.</p>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center gap-4">
            <div className="text-center">
              <p className="text-3xl font-bold text-slate-900">{rating.toFixed(1)}</p>
              <div className="mt-1 flex justify-center gap-0.5">
                {[1, 2, 3, 4, 5].map((n) => (
                  <Star key={n} className={`w-3.5 h-3.5 ${n <= Math.round(rating) ? "fill-amber-400 text-amber-400" : "text-slate-300"}`} />
                ))}
              </div>
              <p className="mt-1 text-[11px] text-slate-500">{reviewCount} reviews</p>
            </div>
            <div className="min-w-0 flex-1 space-y-2">
              {[
                ["Completion", a.completionRate, "bg-emerald-500"],
                ["Cancellation", a.cancellationRate, "bg-rose-500"],
              ].map(([label, value, bar]) => (
                <div key={label}>
                  <div className="flex justify-between text-[11px] text-slate-600">
                    <span>{label}</span>
                    <span>{Number(value || 0).toFixed(1)}%</span>
                  </div>
                  <div className="mt-1 h-1.5 rounded-full bg-slate-100">
                    <div className={`h-1.5 rounded-full ${bar}`} style={{ width: `${Math.min(100, Math.max(0, Number(value) || 0))}%` }} />
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {stats.map(([label, value]) => (
              <div key={label} className="rounded-lg bg-slate-50 px-3 py-2">
                <p className="text-base font-bold text-slate-900">{Number(value || 0).toLocaleString("en-IN")}</p>
                <p className="text-[11px] text-slate-500">{label}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </Panel>
  )
}

function MoneyCard({ value, label, icon: Icon, tone }) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="min-w-0">
        <p className={`text-xl font-bold ${tone}`}>{rupees(value)}</p>
        <p className="mt-1 text-sm font-medium text-slate-700">{label}</p>
      </div>
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-slate-50">
        <Icon className="w-4 h-4 text-slate-500" />
      </span>
    </div>
  )
}

function CollectCashModal({ restaurantId, owed, onClose, onSaved }) {
  const [form, setForm] = useState({ amount: owed > 0 ? String(owed) : "", method: "cash", reference: "", note: "" })
  const [requestKey] = useState(newRequestKey)
  const [saving, setSaving] = useState(false)
  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }))
  const amount = Number(form.amount)
  const invalid = !(amount > 0) || amount > owed

  const save = async (e) => {
    e.preventDefault()
    if (invalid) return
    setSaving(true)
    try {
      await adminSystemExtrasAPI.collectCashFromRestaurant(restaurantId, { ...form, amount, requestKey })
      toast.success("Cash collection recorded")
      onSaved()
    } catch (err) {
      toast.error(errorMessage(err, "Could not record the collection"))
    } finally {
      setSaving(false)
    }
  }

  const input = "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500"
  return (
    <div className="fixed inset-0 z-[100] flex items-end justify-center bg-slate-900/40 p-0 sm:items-center sm:p-4" onClick={onClose}>
      <form
        onSubmit={save}
        onClick={(e) => e.stopPropagation()}
        className="max-h-[92vh] w-full overflow-y-auto rounded-t-2xl bg-white p-5 shadow-xl sm:max-w-md sm:rounded-2xl"
      >
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold text-slate-900">Collect Cash From Store</h3>
          <button type="button" onClick={onClose} className="rounded-lg p-1 text-slate-500 hover:bg-slate-100">
            <X className="w-4 h-4" />
          </button>
        </div>
        <p className="mt-2 text-xs text-slate-600">
          Cash owed by this store: <span className="font-semibold text-slate-900">{rupees(owed)}</span>
        </p>
        {owed <= 0 ? (
          <p className="mt-4 rounded-lg bg-slate-50 p-3 text-xs text-slate-600">
            This store holds no cash owed to the platform, so there is nothing to collect. Riders collect cash on
            delivery here; a store only owes cash when its payouts and subscription deductions have run ahead of its
            earnings, for example after an order was refunded once it had been paid out.
          </p>
        ) : (
          <div className="mt-4 space-y-3">
            <label className="block space-y-1">
              <span className="text-xs font-semibold text-slate-600">Amount</span>
              <input type="number" min="0" step="0.01" max={owed} value={form.amount} onChange={(e) => set("amount", e.target.value)} className={input} required />
              {amount > owed && <span className="text-[11px] text-rose-600">More than the store owes.</span>}
            </label>
            <label className="block space-y-1">
              <span className="text-xs font-semibold text-slate-600">Method</span>
              <select value={form.method} onChange={(e) => set("method", e.target.value)} className={input}>
                {METHODS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
            <label className="block space-y-1">
              <span className="text-xs font-semibold text-slate-600">Reference (optional)</span>
              <input value={form.reference} onChange={(e) => set("reference", e.target.value)} className={input} maxLength={120} placeholder="Receipt or transaction number" />
            </label>
            <label className="block space-y-1">
              <span className="text-xs font-semibold text-slate-600">Note (optional)</span>
              <textarea value={form.note} onChange={(e) => set("note", e.target.value)} className={input} rows={2} maxLength={500} />
            </label>
          </div>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-700 hover:bg-slate-50">
            Close
          </button>
          {owed > 0 && (
            <button type="submit" disabled={saving || invalid} className="inline-flex items-center gap-2 rounded-lg bg-teal-700 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-800 disabled:opacity-60">
              {saving && <Loader2 className="w-4 h-4 animate-spin" />} Collect
            </button>
          )}
        </div>
      </form>
    </div>
  )
}

function MoneyCards({ restaurantId }) {
  const [wallet, setWallet] = useState(null)
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(true)
  const [collecting, setCollecting] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError("")
    try {
      setWallet(payload(await adminSystemExtrasAPI.getRestaurantWalletOverview(restaurantId)))
    } catch (err) {
      setError(errorMessage(err, "Could not load the store's wallet"))
    } finally {
      setLoading(false)
    }
  }, [restaurantId])

  useEffect(() => {
    load()
  }, [load])

  if (loading) return <Spinner className="py-10" />
  if (error) return <p className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-rose-600">{error}</p>

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-slate-200 bg-sky-50 p-5 text-center shadow-sm">
        <p className="text-3xl font-bold text-slate-900">{rupees(wallet?.collectedCash)}</p>
        <p className="mt-1 text-sm text-slate-600">Collected Cash By Store</p>
        <button
          type="button"
          onClick={() => setCollecting(true)}
          className="mt-4 rounded-lg bg-teal-700 px-5 py-2.5 text-sm font-semibold text-white hover:bg-teal-800"
        >
          Collect Cash From Store
        </button>
        {wallet?.totalCashCollected > 0 && (
          <p className="mt-2 text-[11px] text-slate-500">Collected so far: {rupees(wallet.totalCashCollected)}</p>
        )}
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <MoneyCard value={wallet?.pendingWithdraw} label="Pending Withdraw" icon={Clock} tone="text-sky-600" />
        <MoneyCard value={wallet?.totalWithdrawn} label="Total Withdrawal Amount" icon={Banknote} tone="text-emerald-600" />
        <MoneyCard value={wallet?.withdrawableBalance} label="Withdraw Able Balance" icon={Wallet} tone="text-rose-600" />
        <MoneyCard value={wallet?.totalEarning} label="Total Earning" icon={CreditCard} tone="text-amber-500" />
      </div>
      {wallet?.lockedAmount > 0 && (
        <p className="text-[11px] text-slate-500">
          {rupees(wallet.lockedAmount)} of the balance is held against unpaid subscription dues.
        </p>
      )}
      {collecting && (
        <CollectCashModal
          restaurantId={restaurantId}
          owed={Number(wallet?.collectedCash) || 0}
          onClose={() => setCollecting(false)}
          onSaved={() => {
            setCollecting(false)
            load()
          }}
        />
      )}
    </div>
  )
}

function StoreLocationCard({ restaurant }) {
  const lat = Number(restaurant?.latitude ?? restaurant?.location?.latitude)
  const lng = Number(restaurant?.longitude ?? restaurant?.location?.longitude)
  const hasPoint = Number.isFinite(lat) && Number.isFinite(lng) && !(lat === 0 && lng === 0)
  const logo = mediaUrl(restaurant?.profileImage)
  const phone = restaurant?.primaryContactNumber || restaurant?.ownerPhone
  return (
    <Panel title="Store Info" icon={Store}>
      <div className="flex flex-col gap-4 sm:flex-row">
        <div className="flex h-24 w-24 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-slate-200 bg-white">
          {logo ? <img src={logo} alt="" className="h-full w-full object-cover" /> : <Store className="w-8 h-8 text-slate-300" />}
        </div>
        <div className="min-w-0 space-y-1.5 text-sm">
          <p className="font-semibold text-slate-900">{restaurant?.restaurantName}</p>
          <p className="break-words text-slate-600"><Building2 className="mr-1.5 inline w-3.5 h-3.5" />Address: <span className="text-teal-700">{restaurantAddress(restaurant) || "-"}</span></p>
          <p className="break-words text-slate-600"><Mail className="mr-1.5 inline w-3.5 h-3.5" />Email: <span className="text-teal-700">{restaurant?.ownerEmail || "-"}</span></p>
          <p className="text-slate-600"><Phone className="mr-1.5 inline w-3.5 h-3.5" />Phone: <span className="text-teal-700">{phone || "-"}</span></p>
          <p className="text-slate-600"><MapPin className="mr-1.5 inline w-3.5 h-3.5" />Zone: {restaurantZone(restaurant)}</p>
        </div>
      </div>
      <div className="mt-4 overflow-hidden rounded-xl border border-slate-200">
        {hasPoint ? (
          <iframe
            title="Store location"
            src={`https://www.google.com/maps?q=${lat},${lng}&hl=en&z=15&output=embed`}
            className="h-56 w-full border-0 sm:h-64"
            loading="lazy"
            referrerPolicy="no-referrer-when-downgrade"
          />
        ) : (
          <p className="p-4 text-xs text-slate-500">This store has no map location set.</p>
        )}
      </div>
    </Panel>
  )
}

/** How many restaurant panel staff accounts the restaurant has (read-only). */
function useEmployeesSummary(restaurantId) {
  const [summary, setSummary] = useState(null)
  useEffect(() => {
    if (!restaurantId) return undefined
    let alive = true
    adminSystemExtrasAPI
      .getRestaurantEmployeesSummary(restaurantId)
      .then((res) => alive && setSummary(payload(res)))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [restaurantId])
  return summary
}

function OwnerCard({ restaurant, restaurantId }) {
  const staff = useEmployeesSummary(restaurantId)
  const staffText = staff
    ? `${staff.employees || 0} employee(s), ${staff.active || 0} active · ${staff.roles || 0} role(s)`
    : ""
  return (
    <Panel title="Owner Info" icon={User}>
      <div className="space-y-4">
        <InfoLine icon={User} tone="bg-teal-600" label="Name" value={restaurant?.ownerName} />
        <InfoLine icon={Phone} tone="bg-orange-500" label="Phone" value={restaurant?.ownerPhone} href={restaurant?.ownerPhone ? `tel:${restaurant.ownerPhone}` : ""} />
        <InfoLine icon={Mail} tone="bg-rose-500" label="Email" value={restaurant?.ownerEmail} href={restaurant?.ownerEmail ? `mailto:${restaurant.ownerEmail}` : ""} />
        <InfoLine icon={User} tone="bg-slate-500" label="Panel staff" value={staffText} />
      </div>
    </Panel>
  )
}

function BankCard({ restaurant }) {
  const rows = [
    ["Account holder", restaurant?.accountHolderName],
    ["Account number", restaurant?.accountNumber],
    ["IFSC code", restaurant?.ifscCode],
    ["Account type", restaurant?.accountType],
    ["UPI id", restaurant?.upiId],
    ["Payout to", restaurant?.payoutMethod ? String(restaurant.payoutMethod).toUpperCase() : ""],
    ["PAN", restaurant?.panNumber],
    ["GST", restaurant?.gstRegistered ? restaurant?.gstNumber : ""],
    ["FSSAI", restaurant?.fssaiNumber],
  ].filter(([, value]) => value)
  return (
    <Panel title="Bank Info" icon={Banknote}>
      {rows.length === 0 ? (
        <p className="text-xs text-slate-500">No bank or payout details on file.</p>
      ) : (
        <dl className="grid grid-cols-1 gap-x-4 gap-y-2 text-sm sm:grid-cols-2">
          {rows.map(([label, value]) => (
            <div key={label} className="min-w-0">
              <dt className="text-[11px] text-slate-500">{label}</dt>
              <dd className="break-words font-medium text-slate-800">{value}</dd>
            </div>
          ))}
        </dl>
      )}
    </Panel>
  )
}

export default function OverviewTab({ restaurantId, restaurant, analytics }) {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      <div className="min-w-0 space-y-4">
        <StoreInfoCard restaurant={restaurant} />
        <PerformanceCard restaurant={restaurant} analytics={analytics} />
      </div>
      <div className="min-w-0 space-y-4 lg:col-span-2">
        <MoneyCards restaurantId={restaurantId} />
        <StoreLocationCard restaurant={restaurant} />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <OwnerCard restaurant={restaurant} restaurantId={restaurantId} />
          <BankCard restaurant={restaurant} />
        </div>
      </div>
    </div>
  )
}
