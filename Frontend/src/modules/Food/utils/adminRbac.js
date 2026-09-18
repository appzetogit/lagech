import { getCurrentUser } from "@food/utils/auth";
import { adminSidebarMenu } from "@food/utils/adminSidebarMenu";

export const ADMIN_ACTIONS = ["view", "create", "edit", "delete", "export"];

export const ADMIN_PERMISSION_SECTIONS = [
  "dashboard",
  "point_of_sale",
  "food_management",
  "restaurant_management",
  "order_management",
  "promotions_management",
  "referral_rewards",
  "customer_management",
  "delivery_management",
  "support_management",
  "report_management",
  "transaction_management",
  "banner_management",
  "pages_social_media",
  // Kept in step with the backend list in src/constants/permissions.js. Both of
  // these are referenced by PATH_PREFIX_TO_SECTION below and by backend guards,
  // but were missing from every section list -- so they could never be granted
  // and their pages were invisible to every sub-admin.
  "system_settings",
  // sub_admin_management is deliberately absent: every one of its endpoints
  // is super-admin only, because a sub-admin who can edit sub-admins can
  // grant themselves everything else. Listing it here would put a checkbox in
  // the role editor that can never do anything.
];

/** Labels for the role editor; the raw keys are not what an admin should read. */
export const ADMIN_SECTION_LABELS = {
  dashboard: "Dashboard",
  point_of_sale: "Point of Sale",
  food_management: "Food Management",
  restaurant_management: "Restaurant Management",
  order_management: "Order Management",
  promotions_management: "Promotions",
  referral_rewards: "Referral & Rewards",
  customer_management: "Customer Management",
  delivery_management: "Delivery Management",
  support_management: "Support Management",
  report_management: "Reports",
  transaction_management: "Transactions",
  banner_management: "Banner Management",
  pages_social_media: "Pages & Social Media",
  system_settings: "System Settings",
  sub_admin_management: "Sub-Admin Management",
};

export const adminSectionLabel = (key) =>
  ADMIN_SECTION_LABELS[key] ||
  String(key || "")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (ch) => ch.toUpperCase());

const PATH_PREFIX_TO_SECTION = [
  { prefix: "/admin/food/point-of-sale", section: "point_of_sale" },
  { prefix: "/admin/food/fee-settings", section: "delivery_management" },
  { prefix: "/admin/food/delivery-cash-limit", section: "delivery_management" },
  { prefix: "/admin/food/cash-limit-settlement", section: "delivery_management" },
  { prefix: "/admin/food/delivery-withdrawal", section: "delivery_management" },
  { prefix: "/admin/food/delivery-boy-wallet", section: "delivery_management" },
  { prefix: "/admin/food/delivery-emergency-help", section: "delivery_management" },
  { prefix: "/admin/food/delivery-support-tickets", section: "delivery_management" },
  { prefix: "/admin/food/delivery-order-reassignment-requests", section: "delivery_management" },
  // Same sections the backend checks for these pages' API calls: refunds are
  // /orders/..., commission rules are /delivery/... .
  { prefix: "/admin/food/delivery-boy-commission", section: "delivery_management" },
  { prefix: "/admin/food/order-refunds", section: "order_management" },
  { prefix: "/admin/food/order-cancel-reasons", section: "order_management" },
  { prefix: "/admin/food/dispatch", section: "order_management" },
  { prefix: "/admin/food/food-approval", section: "food_management" },
  { prefix: "/admin/food/foods", section: "food_management" },
  { prefix: "/admin/food/addons", section: "food_management" },
  { prefix: "/admin/food/categories", section: "food_management" },
  { prefix: "/admin/food/zone-setup", section: "restaurant_management" },
  { prefix: "/admin/food/restaurants", section: "restaurant_management" },
  { prefix: "/admin/food/orders", section: "order_management" },
  { prefix: "/admin/food/order-detect-delivery", section: "order_management" },
  { prefix: "/admin/food/coupons", section: "promotions_management" },
  { prefix: "/admin/food/cashback", section: "promotions_management" },
  { prefix: "/admin/food/referral-settings", section: "referral_rewards" },
  { prefix: "/admin/food/customers", section: "customer_management" },
  { prefix: "/admin/food/support-tickets", section: "customer_management" },
  // Live chat rides on the same section as the rest of support. It is not
  // under /food/admin, so it needs saying explicitly.
  { prefix: "/admin/food/chattings", section: "customer_management" },
  { prefix: "/admin/food/delivery", section: "delivery_management" },
  { prefix: "/admin/food/delivery-partners", section: "delivery_management" },
  { prefix: "/admin/food/contact-messages", section: "support_management" },
  { prefix: "/admin/food/safety-emergency-reports", section: "support_management" },
  { prefix: "/admin/food/transaction-report", section: "report_management" },
  { prefix: "/admin/food/order-report", section: "report_management" },
  { prefix: "/admin/food/tax-report", section: "report_management" },
  { prefix: "/admin/food/restaurant-report", section: "report_management" },
  { prefix: "/admin/food/customer-report", section: "report_management" },
  { prefix: "/admin/food/admin-earning-report", section: "report_management" },
  { prefix: "/admin/food/expense-report", section: "report_management" },
  { prefix: "/admin/food/item-report", section: "report_management" },
  { prefix: "/admin/food/restaurant-withdraws", section: "transaction_management" },
  { prefix: "/admin/food/restaurant-disbursements", section: "transaction_management" },
  { prefix: "/admin/food/balance-sheet", section: "transaction_management" },
  { prefix: "/admin/food/hero-banner-management", section: "banner_management" },
  { prefix: "/admin/food/promotional-banner", section: "banner_management" },
  { prefix: "/admin/food/feature-settings", section: "system_settings" },
  { prefix: "/admin/food/power-scanning", section: "system_settings" },
  { prefix: "/admin/food/business-setup", section: "system_settings" },
  { prefix: "/admin/food/broadcast-notification", section: "system_settings" },
  { prefix: "/admin/food/pages-social-media", section: "pages_social_media" },
  { prefix: "/admin/food/employees", section: "sub_admin_management" },
  { prefix: "/admin/food/employee-role", section: "sub_admin_management" },
];

const ALWAYS_ALLOWED_FOR_SUB_ADMIN = new Set([
  "/admin/food/profile",
  "/admin/food/settings",
]);

export function isSuperAdmin(adminUser) {
  const type = String(adminUser?.adminType || "").trim().toLowerCase();
  return type === "super_admin";
}

export function getAdminPermissions(adminUser) {
  return adminUser?.effectivePermissions || adminUser?.permissions || {};
}

export function canAdminAccess(adminUser, section, action = "view") {
  if (!section) return true;
  if (isSuperAdmin(adminUser)) return true;
  const permissions = getAdminPermissions(adminUser);
  const actions = Array.isArray(permissions?.[section]) ? permissions[section] : [];
  return actions.includes(action);
}

/**
 * Whether a sub-admin was given this sidebar page. An empty list means the
 * super admin never narrowed them to single pages, so their sections decide.
 */
/** Every page the sidebar links to, top-level links and sub-items alike. */
export function listSidebarPaths(menu = adminSidebarMenu) {
  const paths = [];
  for (const entry of menu) {
    if (entry?.type === "link" && entry.path) paths.push(entry.path);
    for (const item of entry?.items || []) {
      if (item.path) paths.push(item.path);
      for (const sub of item.subItems || []) if (sub.path) paths.push(sub.path);
    }
  }
  return paths;
}

export function canSeeMenuPath(adminUser, path) {
  if (isSuperAdmin(adminUser)) return true;
  const chosen = Array.isArray(adminUser?.menuPaths) ? adminUser.menuPaths : [];
  if (!chosen.length) return true;
  const normalized = String(path || "").replace(/\/+$/, "") || "/";
  return chosen.includes(normalized);
}

export function resolvePermissionSectionByPath(pathname = "") {
  if (pathname === "/admin/food" || pathname === "/admin/food/") return "dashboard";
  const match = PATH_PREFIX_TO_SECTION.find((item) => pathname.startsWith(item.prefix));
  return match?.section || null;
}

export function canAccessAdminPath(pathname, action = "view") {
  const adminUser = getCurrentUser("admin");
  // A page that has its own sidebar entry, but not one this sub-admin was
  // given, is closed even when typed into the address bar. Pages without an
  // entry (an order's detail page, say) follow the section as before.
  const normalizedPath = String(pathname || "").replace(/\/+$/, "") || "/";
  if (listSidebarPaths().includes(normalizedPath) && !canSeeMenuPath(adminUser, normalizedPath)) {
    return false;
  }
  const section = resolvePermissionSectionByPath(pathname);
  if (!section) {
    if (isSuperAdmin(adminUser)) return true;
    const normalized = String(pathname || "").replace(/\/+$/, "") || "/";
    return ALWAYS_ALLOWED_FOR_SUB_ADMIN.has(normalized);
  }
  return canAdminAccess(adminUser, section, action);
}

export function canCurrentAdminAction(action = "view", pathname = "") {
  const adminUser = getCurrentUser("admin");
  const currentPath =
    pathname || (typeof window !== "undefined" ? window.location.pathname : "");
  const section = resolvePermissionSectionByPath(currentPath);
  if (!section) {
    return isSuperAdmin(adminUser);
  }
  return canAdminAccess(adminUser, section, action);
}

export function findFirstAllowedAdminPath(adminUser) {
  const sectionHomePath = {
    dashboard: "/admin/food",
    point_of_sale: "/admin/food/point-of-sale",
    food_management: "/admin/food/food-approval",
    restaurant_management: "/admin/food/restaurants",
    order_management: "/admin/food/orders/all",
    promotions_management: "/admin/food/coupons",
    referral_rewards: "/admin/food/referral-settings",
    customer_management: "/admin/food/customers",
    delivery_management: "/admin/food/delivery-partners",
    support_management: "/admin/food/contact-messages",
    report_management: "/admin/food/transaction-report",
    transaction_management: "/admin/food/restaurant-withdraws",
    banner_management: "/admin/food/hero-banner-management",
    pages_social_media: "/admin/food/pages-social-media/about",
    system_settings: "/admin/food/business-setup",
    sub_admin_management: "/admin/food/employees",
  };

  if (isSuperAdmin(adminUser)) {
    return "/admin/food";
  }

  const chosen = Array.isArray(adminUser?.menuPaths) ? adminUser.menuPaths : [];
  if (chosen.length) return chosen[0];

  for (const section of ADMIN_PERMISSION_SECTIONS) {
    if (canAdminAccess(adminUser, section, "view")) {
      return sectionHomePath[section] || "/admin/food/profile";
    }
  }

  return "/admin/food/profile";
}
