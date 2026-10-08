/**
 * The admin sidebar, laid out like the previous (6amMart) admin panel: the same
 * section order, grouping and names, so the team finds things where they are
 * used to finding them.
 *
 * Only pages that actually work are listed. Features the old panel had that
 * this one does not yet (expenses, collect
 * cash, withdraw methods) get their entry when they are
 * built -- a link to a page that loads and saves nothing is worse than no link.
 * Pages the old panel never had (live tracking, duty log, subscriptions, ...)
 * sit in the nearest old section rather than being dropped.
 *
 * Behaviour is keyed, not derived from the visible text, so renaming an entry
 * can never change what it does:
 *   badge    -- key into the /sidebar-badges counts
 *   requires -- "superPowers" | "adminAccess": extra gate on top of RBAC
 *   feature  -- "codControl" | "restaurantSubscription" | "unregisteredRestaurants"
 *               | "featureSettings": hidden while that feature is switched off
 * Permissions themselves still come from the path, via adminRbac.js.
 */
export const adminSidebarMenu = [
  {
    type: "link",
    label: "Dashboard",
    path: "/admin/food",
    icon: "LayoutDashboard",
  },
  {
    type: "section",
    label: "POS SECTION",
    items: [
      { type: "link", label: "New Sale", path: "/admin/food/point-of-sale", icon: "CreditCard" },
    ],
  },
  {
    type: "section",
    label: "ORDER MANAGEMENT",
    items: [
      {
        type: "expandable",
        label: "Orders",
        icon: "FileText",
        subItems: [
          { label: "All", path: "/admin/food/orders/all" },
          { label: "Scheduled", path: "/admin/food/orders/scheduled" },
          { label: "Pending", path: "/admin/food/orders/pending", badge: "orders" },
          { label: "Processing", path: "/admin/food/orders/processing" },
          { label: "Order On The Way", path: "/admin/food/orders/food-on-the-way" },
          { label: "Delivered", path: "/admin/food/orders/delivered" },
          { label: "Canceled", path: "/admin/food/orders/canceled" },
          { label: "Restaurant Canceled", path: "/admin/food/orders/restaurant-cancelled" },
          { label: "Payment Failed", path: "/admin/food/orders/payment-failed" },
          { label: "Refunded", path: "/admin/food/orders/refunded" },
          {
            label: "Offline Payments",
            path: "/admin/food/orders/offline-payments",
            badge: "offlinePayments",
            feature: "codControl",
          },
          { label: "User Carts", path: "/admin/food/orders/user-carts" },
        ],
      },
      {
        type: "expandable",
        label: "Order Refunds",
        icon: "Receipt",
        subItems: [{ label: "Refund Requests", path: "/admin/food/order-refunds/new" }],
      },
      { type: "link", label: "Dispatch", path: "/admin/food/dispatch", icon: "Truck" },
      { type: "link", label: "Cancel Reasons", path: "/admin/food/order-cancel-reasons", icon: "AlertTriangle" },
      { type: "link", label: "Order Detect Delivery", path: "/admin/food/order-detect-delivery", icon: "Truck" },
    ],
  },
  {
    type: "section",
    label: "PROMOTION MANAGEMENT",
    items: [
      {
        type: "expandable",
        label: "Campaigns",
        icon: "Layers",
        subItems: [
          { label: "Basic Campaign", path: "/admin/food/campaigns/basic" },
          { label: "Food Campaign", path: "/admin/food/campaigns/food" },
        ],
      },
      { type: "link", label: "Banners", path: "/admin/food/hero-banner-management", icon: "Image" },
      { type: "link", label: "Other Banners", path: "/admin/food/promotional-banner", icon: "Megaphone" },
      {
        type: "expandable",
        label: "Advertisement",
        icon: "Megaphone",
        badge: "pendingAds",
        subItems: [
          { label: "New Advertisement", path: "/admin/food/advertisements/new" },
          { label: "Ad Requests", path: "/admin/food/advertisements/requests", badge: "pendingAds" },
          { label: "Ads List", path: "/admin/food/advertisements" },
        ],
      },
      {
        type: "expandable",
        label: "Reels",
        icon: "Camera",
        subItems: [
          { label: "Create Reels", path: "/admin/food/reels/new" },
          { label: "Reels List", path: "/admin/food/reels" },
        ],
      },
      { type: "link", label: "Cashback", path: "/admin/food/cashback", icon: "IndianRupee" },
      { type: "link", label: "Coupons", path: "/admin/food/coupons", icon: "Gift" },
      { type: "link", label: "Push Notification", path: "/admin/food/broadcast-notification", icon: "Bell" },
      { type: "link", label: "Referral Settings", path: "/admin/food/referral-settings", icon: "Gift" },
    ],
  },
  {
    type: "section",
    label: "FOOD MANAGEMENT",
    items: [
      {
        type: "expandable",
        label: "Categories",
        icon: "FolderTree",
        subItems: [
          { label: "Category", path: "/admin/food/categories" },
          { label: "Sub Category", path: "/admin/food/categories/sub" },
          { label: "Bulk Import", path: "/admin/food/categories/bulk-import" },
          { label: "Bulk Export", path: "/admin/food/categories/bulk-export" },
        ],
      },
      {
        type: "expandable",
        label: "Addons",
        icon: "PlusCircle",
        subItems: [
          { label: "List", path: "/admin/food/addons" },
          { label: "Addon Category", path: "/admin/food/addons/categories" },
          { label: "Bulk Import", path: "/admin/food/addons/bulk-import" },
          { label: "Bulk Export", path: "/admin/food/addons/bulk-export" },
        ],
      },
      {
        type: "expandable",
        label: "Food Setup",
        icon: "Utensils",
        badge: "foods",
        subItems: [
          { label: "Add New", path: "/admin/food/foods/add-new" },
          { label: "List", path: "/admin/food/foods" },
          { label: "New Food Request", path: "/admin/food/food-approval", badge: "foodApprovals" },
          { label: "Food Gallery", path: "/admin/food/foods/gallery" },
          { label: "Review", path: "/admin/food/foods/reviews" },
          { label: "Bulk Import", path: "/admin/food/foods/bulk-import" },
          { label: "Bulk Export", path: "/admin/food/foods/bulk-export" },
        ],
      },
    ],
  },
  {
    type: "section",
    label: "RESTAURANT MANAGEMENT",
    items: [
      { type: "link", label: "Zone Setup", path: "/admin/food/zone-setup", icon: "MapPin" },
      {
        type: "link",
        label: "New Restaurants",
        path: "/admin/food/restaurants/joining-request",
        icon: "Store",
        badge: "restaurants",
      },
      { type: "link", label: "Add New Restaurant", path: "/admin/food/restaurants/add", icon: "PlusCircle" },
      { type: "link", label: "Recommended Restaurants", path: "/admin/food/restaurants/recommended", icon: "Flame" },
      { type: "link", label: "Bulk Import", path: "/admin/food/restaurants/bulk-import", icon: "Upload" },
      { type: "link", label: "Bulk Export", path: "/admin/food/restaurants/bulk-export", icon: "Download" },
      {
        type: "expandable",
        label: "Restaurants",
        icon: "UtensilsCrossed",
        subItems: [
          { label: "Restaurants List", path: "/admin/food/restaurants" },
          {
            label: "Unregistered Restaurants",
            path: "/admin/food/restaurants/unregistered",
            feature: "unregisteredRestaurants",
          },
          { label: "Reviews", path: "/admin/food/restaurants/reviews" },
          {
            label: "Complaints",
            path: "/admin/food/restaurants/complaints",
            badge: "restaurantComplaints",
          },
          { label: "Commission", path: "/admin/food/restaurants/commission" },
          { label: "Restaurant Settings", path: "/admin/food/restaurants/settings" },
          { label: "Billing Mode", path: "/admin/food/restaurants/billing" },
          {
            label: "Subscription Settings",
            path: "/admin/food/restaurants/subscription-settings",
            feature: "restaurantSubscription",
          },
          {
            label: "Subscription Billing",
            path: "/admin/food/restaurants/subscription-history",
            feature: "restaurantSubscription",
          },
        ],
      },
    ],
  },
  {
    type: "section",
    label: "DELIVERYMAN SECTION",
    items: [
      { type: "link", label: "Vehicles Category", path: "/admin/food/delivery-partners/vehicle-categories", icon: "Car" },
      { type: "link", label: "Add Delivery Man", path: "/admin/food/delivery-partners/add", icon: "UserPlus" },
      {
        type: "link",
        label: "New Delivery Man",
        path: "/admin/food/delivery-partners/join-request",
        icon: "UserPlus",
        badge: "deliveryPartners",
      },
      { type: "link", label: "Deliveryman List", path: "/admin/food/delivery-partners", icon: "Package" },
      { type: "link", label: "Reviews", path: "/admin/food/delivery-partners/reviews", icon: "Star" },
      { type: "link", label: "Live Tracking", path: "/admin/food/delivery-partners/live-tracking", icon: "MapPin" },
      { type: "link", label: "Duty Log", path: "/admin/food/delivery-partners/duty-log", icon: "Clock" },
      {
        type: "expandable",
        label: "Earnings & Bonus",
        icon: "IndianRupee",
        subItems: [
          { label: "Delivery Earning", path: "/admin/food/delivery-partners/earnings" },
          { label: "Bonus", path: "/admin/food/delivery-partners/bonus" },
          { label: "Earning Addon", path: "/admin/food/delivery-partners/earning-addon" },
          {
            label: "Earning Addon History",
            path: "/admin/food/delivery-partners/earning-addon-history",
            badge: "earningAddons",
          },
          { label: "Delivery Commission", path: "/admin/food/delivery-boy-commission" },
          { label: "Delivery & Platform Fee", path: "/admin/food/fee-settings" },
        ],
      },
      {
        type: "expandable",
        label: "Cash & Wallet",
        icon: "PiggyBank",
        subItems: [
          { label: "Delivery Boy Wallet", path: "/admin/food/delivery-boy-wallet" },
          { label: "Cash Limit", path: "/admin/food/delivery-cash-limit", feature: "codControl" },
          { label: "Cash Limit Settlement", path: "/admin/food/cash-limit-settlement", feature: "codControl" },
        ],
      },
      {
        type: "link",
        label: "Emergency Help",
        path: "/admin/food/delivery-emergency-help",
        icon: "Phone",
        badge: "emergencyHelp",
      },
      {
        type: "link",
        label: "Delivery Support Tickets",
        path: "/admin/food/delivery-support-tickets",
        icon: "MessageSquare",
        badge: "deliverySupportTickets",
      },
      {
        type: "link",
        label: "Order Reassignment Requests",
        path: "/admin/food/delivery-order-reassignment-requests",
        icon: "AlertTriangle",
      },
    ],
  },
  {
    type: "section",
    label: "CUSTOMER SECTION",
    items: [
      { type: "link", label: "User Overview", path: "/admin/food/user-overview", icon: "LayoutDashboard" },
      { type: "link", label: "Customers", path: "/admin/food/customers", icon: "Users" },
      {
        type: "expandable",
        label: "Customer Wallet",
        icon: "Wallet",
        subItems: [
          { label: "Add Fund", path: "/admin/food/wallet/add-fund" },
          { label: "Report", path: "/admin/food/wallet/report" },
          { label: "Bonus", path: "/admin/food/wallet/bonus" },
        ],
      },
      {
        type: "expandable",
        label: "Customer Loyalty Point",
        icon: "Award",
        subItems: [{ label: "Report", path: "/admin/food/loyalty-point/report" }],
      },
      { type: "link", label: "Subscribed Mail List", path: "/admin/food/subscribed-mail-list", icon: "Mail" },
      { type: "link", label: "Live Chat", path: "/admin/food/chattings", icon: "MessagesSquare", badge: "liveChat" },
      {
        type: "link",
        label: "Support Tickets",
        path: "/admin/food/support-tickets",
        icon: "MessageSquare",
        badge: "userSupportTickets",
      },
      { type: "link", label: "Order Issue Reports", path: "/admin/food/order-issue-reports", icon: "AlertTriangle" },
      { type: "link", label: "Contact Messages", path: "/admin/food/contact-messages", icon: "Mail" },
      {
        type: "link",
        label: "Safety Emergency Reports",
        path: "/admin/food/safety-emergency-reports",
        icon: "AlertTriangle",
        badge: "safetyReports",
      },
    ],
  },
  {
    type: "section",
    label: "EMPLOYEE HANDLE",
    items: [
      // Access is edited per employee, from the list.
      {
        type: "expandable",
        label: "Employees",
        icon: "UserCog",
        requires: "adminAccess",
        subItems: [
          { label: "Add new", path: "/admin/food/employees/add" },
          { label: "List", path: "/admin/food/employees" },
        ],
      },
      { type: "link", label: "Employee Roles", path: "/admin/food/employees/roles", icon: "Lock", requires: "adminAccess" },
    ],
  },
  {
    type: "section",
    label: "TRANSACTION MANAGEMENT",
    items: [
      {
        type: "link",
        label: "Withdraw Requests",
        path: "/admin/food/restaurant-withdraws",
        icon: "CreditCard",
        badge: "restaurantWithdrawals",
      },
      // The old panel's "Store Disbursement": the daily payout batches.
      { type: "link", label: "Restaurant Disbursement", path: "/admin/food/restaurant-disbursements", icon: "Receipt" },
      {
        type: "link",
        label: "Deliveryman Withdraws",
        path: "/admin/food/delivery-withdrawal",
        icon: "Wallet",
        badge: "deliveryWithdrawals",
      },
      { type: "link", label: "Delivery Man Disbursement", path: "/admin/food/deliveryman-disbursements", icon: "Wallet" },
      { type: "link", label: "Delivery Man Payments", path: "/admin/food/deliveryman-payments", icon: "Send" },
      { type: "link", label: "Balance Sheet", path: "/admin/food/balance-sheet", icon: "Wallet" },
      // The old panel's "Store Payments": payments made to restaurants by hand.
      { type: "link", label: "Restaurant Payments", path: "/admin/food/restaurant-payments", icon: "CreditCard" },
      { type: "link", label: "Withdraw Method", path: "/admin/food/withdraw-method", icon: "Wallet" },
    ],
  },
  {
    type: "section",
    label: "REPORT AND ANALYTICS",
    items: [
      { type: "link", label: "Transaction Report", path: "/admin/food/transaction-report", icon: "FileText" },
      { type: "link", label: "Order Report", path: "/admin/food/order-report/regular", icon: "FileText" },
      { type: "link", label: "Restaurant Wise Report", path: "/admin/food/restaurant-report", icon: "FileText" },
      { type: "link", label: "Admin Earning Report", path: "/admin/food/admin-earning-report", icon: "IndianRupee" },
      {
        type: "link",
        label: "Deliveryman Earning Report",
        path: "/admin/food/deliveryman-earning-report",
        icon: "IndianRupee",
      },
      { type: "link", label: "Expense Report", path: "/admin/food/expense-report", icon: "Receipt" },
      { type: "link", label: "Item Report", path: "/admin/food/item-report", icon: "Utensils" },
      { type: "link", label: "Tax Report", path: "/admin/food/tax-report", icon: "Receipt" },
      { type: "link", label: "Restaurant Earning Report", path: "/admin/food/restaurant-earning-report", icon: "IndianRupee" },
      { type: "link", label: "Disbursement Report", path: "/admin/food/disbursement-report/restaurants", icon: "PiggyBank" },
      { type: "link", label: "Restaurant VAT Report", path: "/admin/food/restaurant-vat-report", icon: "Receipt" },
      {
        type: "link",
        label: "Customer Feedback Report",
        path: "/admin/food/customer-report/feedback-experience",
        icon: "FileText",
      },
    ],
  },
  {
    type: "section",
    label: "BUSINESS SETTINGS",
    items: [
      { type: "link", label: "Business Settings", path: "/admin/food/business-setup", icon: "Settings" },
      {
        type: "link",
        label: "Feature Settings",
        path: "/admin/food/feature-settings",
        icon: "Settings",
        requires: "superPowers",
        feature: "featureSettings",
      },
      {
        type: "link",
        label: "Power Scanning",
        path: "/admin/food/power-scanning",
        icon: "Zap",
        requires: "superPowers",
      },
    ],
  },
  {
    type: "section",
    label: "SYSTEM SETTINGS",
    items: [
      { type: "link", label: "App Settings", path: "/admin/food/app-web-settings", icon: "Phone" },
      { type: "link", label: "Login Setup", path: "/admin/food/login-setup", icon: "LogIn" },
      { type: "link", label: "Notification Channels", path: "/admin/food/notification-channels", icon: "Bell" },
      { type: "link", label: "Email Templates", path: "/admin/food/email-template", icon: "Mail" },
      { type: "link", label: "Landing Page", path: "/admin/food/landing-page-settings/react", icon: "Globe" },
      { type: "link", label: "Website", path: "/admin/food/react-site", icon: "Globe" },
      { type: "link", label: "Page Meta Data", path: "/admin/food/page-meta-data", icon: "Globe" },
      { type: "link", label: "Gallery", path: "/admin/food/gallery", icon: "Image" },
      // As on the old panel. AI Setup and the Join Us page setup are left out:
      // no feature here uses an AI key, and the signup forms have no custom
      // fields to configure.
      {
        type: "expandable",
        label: "3rd Party & Configurations",
        icon: "Settings",
        subItems: [
          { label: "3rd Party", path: "/admin/food/3rd-party-configurations/third-party" },
          { label: "Firebase Notification", path: "/admin/food/3rd-party-configurations/firebase" },
          { label: "Offline Payment Setup", path: "/admin/food/3rd-party-configurations/offline-payment" },
          { label: "Analytics Script", path: "/admin/food/3rd-party-configurations/analytics" },
        ],
      },
    ],
  },
  {
    type: "section",
    label: "PAGES & SOCIAL MEDIA",
    items: [
      {
        type: "expandable",
        label: "Business Pages",
        icon: "Globe",
        subItems: [
          { label: "Terms And Condition", path: "/admin/food/pages-social-media/terms" },
          { label: "Privacy Policy", path: "/admin/food/pages-social-media/privacy" },
          { label: "About Us", path: "/admin/food/pages-social-media/about" },
          { label: "Refund Policy", path: "/admin/food/pages-social-media/refund" },
          { label: "Cancelation Policy", path: "/admin/food/pages-social-media/cancellation" },
          { label: "Shipping Policy", path: "/admin/food/pages-social-media/shipping" },
          { label: "Support", path: "/admin/food/pages-social-media/support" },
        ],
      },
      { type: "link", label: "Social Media", path: "/admin/food/pages-social-media/social-media", icon: "Globe" },
    ],
  },
];

/**
 * The old panel split its menu into areas, picked from the top bar (Users,
 * Transactions & Reports, Settings); the sidebar shows only the active area.
 * Sections are assigned here by heading so the menu above stays one list.
 */
export const ADMIN_AREAS = [
  { key: "food", label: "Food" },
  { key: "users", label: "Users", icon: "user-outlined" },
  { key: "transactions", label: "Transactions & Reports", icon: "receipt-outlined" },
  { key: "settings", label: "Settings", icon: "settings-outlined" },
]

const AREA_BY_SECTION = {
  "DELIVERYMAN SECTION": "users",
  "CUSTOMER SECTION": "users",
  "EMPLOYEE HANDLE": "users",
  "TRANSACTION MANAGEMENT": "transactions",
  "REPORT AND ANALYTICS": "transactions",
  "BUSINESS SETTINGS": "settings",
  "SYSTEM SETTINGS": "settings",
  "PAGES & SOCIAL MEDIA": "settings",
}

/** Which area a top-level menu entry belongs to (links and unlisted sections: food). */
export const areaOfEntry = (entry) =>
  (entry?.type === "section" && AREA_BY_SECTION[entry.label]) || "food"

const pathsOf = (entry) => {
  if (entry?.path) return [entry.path]
  const items = entry?.items || entry?.subItems || []
  return items.flatMap(pathsOf)
}

/**
 * The area whose menu holds the page at `pathname` (longest matching path
 * wins, so /admin/food/delivery-partners/... is not taken by /admin/food).
 */
export const areaForPath = (pathname, menu = adminSidebarMenu) => {
  const current = String(pathname || "").replace(/\/+$/, "")
  let best = { area: "food", length: 0 }
  for (const entry of menu) {
    if (!entry) continue
    const area = areaOfEntry(entry)
    for (const path of pathsOf(entry)) {
      const p = String(path).split("?")[0].replace(/\/+$/, "")
      if (!p) continue
      const matches = current === p || current.startsWith(`${p}/`)
      if (matches && p.length > best.length) best = { area, length: p.length }
    }
  }
  return best.area
}

/** First page of an area the admin can see, for the top-bar links. */
export const firstPathOfArea = (area, menu = adminSidebarMenu) => {
  for (const entry of menu) {
    if (entry && areaOfEntry(entry) === area) {
      const [first] = pathsOf(entry)
      if (first) return first
    }
  }
  return null
}

/** The visible entries of one area (sections or links), for the Settings dropdown. */
export const entriesOfArea = (area, menu = adminSidebarMenu) =>
  menu.filter((entry) => entry && areaOfEntry(entry) === area)
