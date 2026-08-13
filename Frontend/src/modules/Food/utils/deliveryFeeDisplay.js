/**
 * Display helpers for the delivery fee and the GST charged on it.
 *
 * These used to derive 18% locally whenever the stored GST was zero, mirroring a
 * hardcoded rate in the backend. That made the rate impossible to change in one
 * place — and it would have silently kept showing the charge here after the
 * backend stopped applying it. The order (or cart) is now the only source: a
 * stored zero means zero, and the rate is only named when the server sends it.
 */

/**
 * Mirrors the backend's computeDeliveryFeeGst for the web cart's offline
 * fallback bill. The rate is a parameter, never a constant in here.
 */
export function computeDeliveryFeeGst(deliveryFee, ratePercent = 0) {
  const base = Math.max(0, Number(deliveryFee) || 0)
  const rate = Number(ratePercent)
  if (base <= 0 || !Number.isFinite(rate) || rate <= 0) return 0
  return Math.round(((base * rate) / 100) * 100) / 100
}

export function resolveDeliveryFeeGst(deliveryFee, deliveryFeeGst) {
  if (Math.max(0, Number(deliveryFee) || 0) <= 0) return 0
  const stored = Number(deliveryFeeGst)
  return Number.isFinite(stored) && stored > 0 ? stored : 0
}

export function getDeliveryFeeTotal(deliveryFee, deliveryFeeGst) {
  const base = Math.max(0, Number(deliveryFee) || 0)
  if (base <= 0) return 0
  return Math.round((base + resolveDeliveryFeeGst(base, deliveryFeeGst)) * 100) / 100
}

/** "GST" alone when the rate is unknown — never a guessed percentage. */
function gstSuffix(ratePercent) {
  const rate = Number(ratePercent)
  if (!Number.isFinite(rate) || rate <= 0) return "GST"
  return `GST ${rate === Math.round(rate) ? rate : rate.toFixed(2)}%`
}

/** Compact subtext for bill rows, e.g. "₹40.00 + ₹7.20 (GST 18%)". */
export function formatDeliveryFeeBreakdownSubtext(
  deliveryFee,
  deliveryFeeGst,
  rupee = "₹",
  ratePercent = 0,
) {
  const base = Math.max(0, Number(deliveryFee) || 0)
  if (base <= 0) return ""
  const gst = resolveDeliveryFeeGst(base, deliveryFeeGst)
  if (gst <= 0) return `${rupee}${base.toFixed(2)}`
  return `${rupee}${base.toFixed(2)} + ${rupee}${gst.toFixed(2)} (${gstSuffix(ratePercent)})`
}

/** Same, for the single-line delivery fee cell. */
export function formatDeliveryFeeWithGst(
  deliveryFee,
  deliveryFeeGst,
  rupee = "₹",
  ratePercent = 0,
) {
  const base = Math.max(0, Number(deliveryFee) || 0)
  if (base <= 0) return "FREE"
  const gst = resolveDeliveryFeeGst(base, deliveryFeeGst)
  if (gst <= 0) return `${rupee}${base.toFixed(2)}`
  return `${rupee}${base.toFixed(2)} + ${gst.toFixed(2)} (${gstSuffix(ratePercent)})`
}
