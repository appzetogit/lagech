import { Link } from "react-router-dom"

/**
 * The admin Restaurant Details page for a restaurant id. Same URL as
 * `restaurantDetailsPath` in pages/admin/restaurant/details/RestaurantDetails,
 * kept here so a list does not pull that lazily loaded page into its chunk.
 */
export const restaurantPath = (id) => `/admin/food/restaurants/view/${encodeURIComponent(String(id))}`

const idOf = (value) => {
  if (!value) return ""
  if (typeof value === "object") return String(value.id || value._id || "")
  return String(value)
}

/**
 * The restaurant id on an order or row, whichever shape it arrived in:
 * `restaurantId` as a plain id or the populated restaurant, or a populated
 * `restaurant` object.
 */
export const restaurantIdOf = (row) =>
  idOf(row?.restaurantId) ||
  (row?.restaurant && typeof row.restaurant === "object" ? idOf(row.restaurant) : "") ||
  idOf(row?.restaurant_id) ||
  idOf(row?.storeId)

/**
 * A restaurant's name that opens its Restaurant Details page, like the old
 * panel's lists. Without an id it is plain text. The click does not reach a
 * clickable row underneath.
 */
export default function RestaurantLink({ id, className = "", children }) {
  if (!id) return <span className={className}>{children}</span>
  return (
    <Link
      to={restaurantPath(id)}
      onClick={(event) => event.stopPropagation()}
      className={`${className} hover:text-blue-600 hover:underline`}
    >
      {children}
    </Link>
  )
}
