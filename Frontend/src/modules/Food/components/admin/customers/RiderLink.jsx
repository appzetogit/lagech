import { Link } from "react-router-dom"

/**
 * Where a rider's name leads. The panel has no full-page rider profile; the
 * Delivery Partners list opens its Delivery Partner Details dialog for
 * `?riderId=<id>`.
 */
export const riderPath = (id) => `/admin/food/delivery-partners?riderId=${encodeURIComponent(String(id))}`

const idOf = (value) => {
  if (!value) return ""
  if (typeof value === "object") return String(value.id || value._id || "")
  return String(value)
}

/**
 * The delivery partner id on an order or row, whichever shape it arrived in:
 * the dispatch's `deliveryPartnerId` (plain or populated), a top-level
 * `deliveryPartnerId` / `deliveryPartner`, or the flattened ids some lists send.
 */
export const riderIdOf = (row) =>
  idOf(row?.dispatch?.deliveryPartnerId) ||
  idOf(row?.dispatchDeliveryPartnerId) ||
  idOf(row?.deliveryPartnerId) ||
  (row?.deliveryPartner && typeof row.deliveryPartner === "object" ? idOf(row.deliveryPartner) : "") ||
  idOf(row?.deliveryId) ||
  idOf(row?.deliveryBoyId) ||
  idOf(row?.riderId)

/**
 * A rider's name that opens their Delivery Partner Details. Without an id it
 * is plain text. The click does not reach a clickable row underneath.
 */
export default function RiderLink({ id, className = "", children }) {
  if (!id) return <span className={className}>{children}</span>
  return (
    <Link
      to={riderPath(id)}
      onClick={(event) => event.stopPropagation()}
      className={`${className} hover:text-blue-600 hover:underline`}
    >
      {children}
    </Link>
  )
}
