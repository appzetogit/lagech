import { useCallback, useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { toast } from "sonner"
import { adminAPI } from "@food/api"
import { EmptyState, ErrorState, Panel, Pill, Spinner, TableBox, Toggle, errorMessage, formatDate, payload, rupees, td, th } from "./shared"

/**
 * Discounts that belong to this restaurant: coupons limited to it (store-wise
 * coupons from Coupons, and offers the restaurant made itself). Coupons for
 * every restaurant are counted, not listed -- they are not this store's.
 */

const discountText = (o) =>
  o.discountType === "percentage"
    ? `${o.discountValue}%${o.maxDiscount ? ` (max ${rupees(o.maxDiscount)})` : ""}`
    : rupees(o.discountValue)

function StatusToggle({ offer, onChanged }) {
  const [saving, setSaving] = useState(false)
  const toggle = async (next) => {
    setSaving(true)
    try {
      await adminAPI.setAdminOfferStatus(offer.id, next ? "active" : "inactive")
      onChanged(next)
    } catch (err) {
      toast.error(errorMessage(err, "Could not change the status"))
    } finally {
      setSaving(false)
    }
  }
  return <Toggle checked={offer.isActive} disabled={saving || offer.isExpired} onChange={toggle} label="Active" />
}

export default function DiscountsTab({ restaurantId }) {
  const [state, setState] = useState({ loading: true, error: "", offers: [], platformWide: 0 })

  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: "" }))
    try {
      const all = payload(await adminAPI.getAllOffers()).offers || []
      const rid = String(restaurantId)
      setState({
        loading: false,
        error: "",
        offers: all.filter((o) => o.restaurantScope === "selected" && (o.restaurantIds || []).map(String).includes(rid)),
        platformWide: all.filter((o) => o.restaurantScope !== "selected" && o.isActive && !o.isExpired).length,
      })
    } catch (err) {
      setState((s) => ({ ...s, loading: false, error: errorMessage(err, "Could not load discounts") }))
    }
  }, [restaurantId])

  useEffect(() => {
    load()
  }, [load])

  const setActive = (id, isActive) =>
    setState((s) => ({ ...s, offers: s.offers.map((o) => (o.id === id ? { ...o, isActive } : o)) }))

  return (
    <Panel
      title={`Discounts${state.loading ? "" : ` (${state.offers.length})`}`}
      bodyClassName=""
      actions={
        <Link to="/admin/food/coupons" className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50">
          Manage coupons
        </Link>
      }
    >
      {!state.loading && !state.error && state.platformWide > 0 && (
        <p className="border-b border-slate-100 px-4 py-2 text-xs text-slate-500">
          {state.platformWide} active coupon{state.platformWide === 1 ? "" : "s"} for all restaurants also apply here.
        </p>
      )}
      {state.loading ? (
        <Spinner />
      ) : state.error ? (
        <ErrorState message={state.error} onRetry={load} />
      ) : state.offers.length === 0 ? (
        <EmptyState title="No store discounts">No coupon or offer is limited to this restaurant.</EmptyState>
      ) : (
        <TableBox>
          <thead>
            <tr>
              <th className={th}>SL</th>
              <th className={th}>Title / code</th>
              <th className={th}>Type</th>
              <th className={th}>Discount</th>
              <th className={th}>Min order</th>
              <th className={th}>Duration</th>
              <th className={th}>Uses</th>
              <th className={th}>Made by</th>
              <th className={th}>Active</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {state.offers.map((offer, index) => (
              <tr key={offer.id} className="hover:bg-slate-50">
                <td className={td}>{index + 1}</td>
                <td className={td}>
                  <p className="font-medium text-slate-800">{offer.title || offer.couponCode}</p>
                  <p className="font-mono text-[11px] text-slate-500">{offer.couponCode}</p>
                </td>
                <td className={`${td} whitespace-nowrap`}>{offer.couponTypeLabel}</td>
                <td className={`${td} whitespace-nowrap`}>{discountText(offer)}</td>
                <td className={`${td} whitespace-nowrap`}>{rupees(offer.minOrderValue)}</td>
                <td className={`${td} whitespace-nowrap text-xs`}>
                  {offer.startDate || offer.endDate ? `${formatDate(offer.startDate)} – ${formatDate(offer.endDate)}` : "No end date"}
                  {offer.isExpired && <div><Pill tone="red">Expired</Pill></div>}
                </td>
                <td className={td}>{offer.totalUses}{offer.usageLimit ? ` / ${offer.usageLimit}` : ""}</td>
                <td className={td}>{offer.createdByRole === "RESTAURANT" ? "Restaurant" : "Admin"}</td>
                <td className={td}><StatusToggle offer={offer} onChanged={(next) => setActive(offer.id, next)} /></td>
              </tr>
            ))}
          </tbody>
        </TableBox>
      )}
    </Panel>
  )
}
