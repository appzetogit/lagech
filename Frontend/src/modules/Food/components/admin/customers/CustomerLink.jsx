import { Link } from "react-router-dom"

/** The admin Customer Details page for a customer id. */
export const customerPath = (id) => `/admin/food/customers/${encodeURIComponent(String(id))}`

/**
 * The customer id on an order, whichever shape it arrived in: the order mapper
 * sends `userId` as a plain id, or as the populated user when it was included.
 */
export const customerIdOf = (order) => {
  const user = order?.userId
  if (user && typeof user === "object") return String(user.id || user._id || "")
  if (user) return String(user)
  return String(order?.user?.id || order?.user?._id || order?.customerId || "")
}

/**
 * A customer's name that opens their Customer Details page, like the old
 * panel's order lists. Without an id it is plain text. The click does not
 * reach a clickable row underneath.
 */
export default function CustomerLink({ id, className = "", children }) {
  if (!id) return <span className={className}>{children}</span>
  return (
    <Link
      to={customerPath(id)}
      onClick={(event) => event.stopPropagation()}
      className={`${className} hover:text-blue-600 hover:underline`}
    >
      {children}
    </Link>
  )
}
