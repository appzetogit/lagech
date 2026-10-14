/**
 * Restaurant staff (Employees) in the restaurant panel.
 *
 * An employee's token is the restaurant's plus `employeeId` and the
 * `permissions` of their role (the server re-reads the role on every request
 * and refuses anything outside it; this only decides what to show). The
 * owner's token has no employeeId and sees everything.
 *
 * Keys match Backend/src/core/auth/restaurantPermissions.js.
 */
import { decodeToken, getModuleToken } from "@food/utils/auth"

export const RESTAURANT_PERMISSIONS = [
  { key: "dashboard", label: "Dashboard", hint: "Home overview" },
  { key: "orders", label: "Orders", hint: "Live orders, order history, accept and update orders" },
  { key: "foods", label: "Foods", hint: "Menu items, inventory, bulk upload" },
  { key: "categories", label: "Categories & add-ons", hint: "Menu categories and add-ons" },
  { key: "campaigns", label: "Campaigns", hint: "Join and view campaigns" },
  { key: "coupons", label: "Coupons", hint: "Offers and coupons" },
  { key: "advertisements", label: "Advertisements", hint: "Advertisement requests" },
  { key: "reviews", label: "Reviews", hint: "Customer reviews, replies and complaints" },
  { key: "wallet", label: "Wallet & finance", hint: "Payouts, invoices, bank and UPI details, subscription" },
  { key: "withdraws", label: "Withdraws", hint: "Withdrawal requests and history" },
  { key: "store_setup", label: "Store setup", hint: "Outlet info, timings, delivery and zone settings, images" },
  { key: "chat", label: "Chat", hint: "Conversations" },
  { key: "reports", label: "Reports", hint: "Download reports" },
  { key: "employees", label: "Employees & roles", hint: "Manage staff and their roles" },
]

const BASE = "/food/restaurant"

/**
 * Panel paths (after /food/restaurant/) -> permissions, any one of which opens
 * the page. Longest match wins; "" is the home page (live orders). A path not
 * listed is open to every signed-in employee.
 */
const PATH_PERMISSIONS = [
  ["", ["orders"]],
  ["orders", ["orders"]],
  ["reservations", ["orders"]],
  ["inventory", ["foods"]],
  ["hub-menu", ["foods"]],
  ["menu-categories", ["categories"]],
  ["coupon", ["coupons"]],
  ["advertise", ["advertisements"]],
  ["feedback", ["reviews", "orders"]],
  ["ratings-reviews", ["reviews"]],
  ["dish-ratings", ["reviews"]],
  ["hub-finance", ["wallet"]],
  ["finance-details", ["wallet"]],
  ["update-bank-details", ["wallet"]],
  ["subscription", ["wallet"]],
  ["disbursements", ["wallet"]],
  ["withdrawal-history", ["withdraws", "wallet"]],
  ["outlet-info", ["store_setup"]],
  ["outlet-timings", ["store_setup"]],
  ["delivery-settings", ["store_setup"]],
  ["rush-hour", ["store_setup"]],
  ["zone-setup", ["store_setup"]],
  ["edit-owner", ["store_setup"]],
  ["edit-cuisines", ["store_setup"]],
  ["edit-address", ["store_setup"]],
  ["fssai", ["store_setup"]],
  ["phone", ["store_setup"]],
  ["manage-outlets", ["store_setup"]],
  ["download-report", ["reports"]],
  ["employee-roles", ["employees"]],
  ["employees", ["employees"]],
]

/** Pages every employee may open, whatever their role. */
const OPEN_PATHS = ["explore", "notifications", "status", "help-centre", "share-feedback", "hyperpure", "privacy", "terms", "help-content"]

/** { isEmployee, employeeId, permissions } from the stored restaurant token. */
export function getRestaurantStaffSession() {
  let decoded = null
  try {
    decoded = decodeToken(getModuleToken("restaurant"))
  } catch {
    decoded = null
  }
  const isEmployee = Boolean(decoded?.employeeId)
  return {
    isEmployee,
    employeeId: decoded?.employeeId || null,
    permissions: isEmployee && Array.isArray(decoded?.permissions) ? decoded.permissions : [],
  }
}

export function hasRestaurantPermission(keys, session = getRestaurantStaffSession()) {
  if (!session.isEmployee) return true
  const list = Array.isArray(keys) ? keys : [keys]
  return list.some((key) => session.permissions.includes(key))
}

/** The relative panel path of a full path or link ("/food/restaurant/x?y" -> "x"). */
const relativeOf = (path) => {
  const bare = String(path || "").split("?")[0].split("#")[0]
  const rest = bare.startsWith(BASE) ? bare.slice(BASE.length) : bare.replace(/^\/restaurant/, "")
  return rest.replace(/^\/+|\/+$/g, "")
}

/** The permissions a panel path needs, or null when any employee may open it. */
export function permissionsForRestaurantPath(path) {
  const rel = relativeOf(path)
  if (OPEN_PATHS.some((p) => rel === p || rel.startsWith(`${p}/`))) return null
  if (rel === "") return ["orders"]
  const match = PATH_PERMISSIONS
    .filter(([p]) => p && (rel === p || rel.startsWith(`${p}/`)))
    .sort((a, b) => b[0].length - a[0].length)[0]
  return match ? match[1] : null
}

export function canOpenRestaurantPath(path, session = getRestaurantStaffSession()) {
  if (!session.isEmployee) return true
  const needed = permissionsForRestaurantPath(path)
  return !needed || hasRestaurantPermission(needed, session)
}

/** Where an employee lands when the home page (live orders) is not theirs. */
export function firstOpenRestaurantPath(session = getRestaurantStaffSession()) {
  const candidates = ["", "inventory", "menu-categories", "coupon", "feedback", "hub-finance", "withdrawal-history",
    "outlet-info", "advertise", "download-report", "employees", "explore"]
  const found = candidates.find((p) => canOpenRestaurantPath(`${BASE}/${p}`, session))
  return found === "" ? BASE : `${BASE}/${found ?? "explore"}`
}
