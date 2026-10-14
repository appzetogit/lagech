import { sendError } from '../../utils/response.js';

/**
 * Restaurant staff permissions (the old store panel's Employee Role modules).
 *
 * A restaurant owner's token carries no employeeId and can do everything, as
 * before. An employee's token is the restaurant's (role RESTAURANT, userId =
 * the restaurant) plus employeeId; auth.middleware loads their role's keys
 * fresh on every request into req.user.permissions, and the gates here limit
 * what they may call. No database access in this file: it is the one table of
 * rules, kept pure so it can be tested on its own.
 */
export const RESTAURANT_PERMISSIONS = [
    { key: 'dashboard', label: 'Dashboard' },
    { key: 'orders', label: 'Orders' },
    { key: 'foods', label: 'Foods' },
    { key: 'categories', label: 'Categories & add-ons' },
    { key: 'campaigns', label: 'Campaigns' },
    { key: 'coupons', label: 'Coupons' },
    { key: 'advertisements', label: 'Advertisements' },
    { key: 'reviews', label: 'Reviews' },
    { key: 'wallet', label: 'Wallet & finance' },
    { key: 'withdraws', label: 'Withdraws' },
    { key: 'store_setup', label: 'Store setup' },
    { key: 'chat', label: 'Chat' },
    { key: 'reports', label: 'Reports' },
    { key: 'employees', label: 'Employees & roles' },
];

export const RESTAURANT_PERMISSION_KEYS = RESTAURANT_PERMISSIONS.map((p) => p.key);
const KEY_SET = new Set(RESTAURANT_PERMISSION_KEYS);

/** Known keys only, each once, in catalogue order. */
export const sanitizeRestaurantPermissions = (value) => {
    const given = new Set((Array.isArray(value) ? value : []).map((v) => String(v || '').trim()));
    return RESTAURANT_PERMISSION_KEYS.filter((key) => given.has(key));
};

/**
 * Old 6amMart vendor role modules -> permission keys. A module with no
 * counterpart here (pos, deliveryman, ...) maps to nothing and is reported.
 */
export const LEGACY_MODULE_PERMISSIONS = {
    dashboard: ['dashboard'],
    order: ['orders'],
    pos: ['orders'],
    item: ['foods'],
    addon: ['categories'],
    category: ['categories'],
    campaign: ['campaigns'],
    coupon: ['coupons'],
    advertisement: ['advertisements'],
    advertisement_list: ['advertisements'],
    reviews: ['reviews'],
    review: ['reviews'],
    wallet: ['wallet', 'withdraws'],
    wallet_method: ['withdraws'],
    bank_info: ['wallet'],
    business_plan: ['wallet'],
    profile: ['store_setup'],
    my_shop: ['store_setup'],
    store_setup: ['store_setup'],
    notification_setup: ['store_setup'],
    banner: ['store_setup'],
    chat: ['chat'],
    report: ['reports'],
    expense_report: ['reports'],
    disbursement_report: ['reports'],
    vat_report: ['reports'],
    role: ['employees'],
    employee: ['employees'],
};

/** @returns {{ permissions: string[], unknown: string[] }} */
export const mapLegacyModules = (modules) => {
    let list = modules;
    if (typeof list === 'string') {
        try {
            list = JSON.parse(list || '[]');
        } catch {
            list = [];
        }
    }
    const keys = new Set();
    const unknown = [];
    for (const raw of Array.isArray(list) ? list : []) {
        const name = String(raw || '').trim().toLowerCase();
        if (!name) continue;
        const mapped = LEGACY_MODULE_PERMISSIONS[name];
        if (mapped) mapped.forEach((key) => keys.add(key));
        else unknown.push(name);
    }
    return { permissions: sanitizeRestaurantPermissions([...keys]), unknown };
};

/** Any signed-in employee of the restaurant. */
export const ANY = 'any';
/** The owner only, never staff. */
export const OWNER = 'owner';

/**
 * `METHOD /path` (as written in restaurant.routes.js) -> who may call it.
 * A list means an employee needs at least one of those keys. A route missing
 * from this table is refused to employees: a new route is closed to staff
 * until someone decides who it is for (restaurantPermissions.test.js fails
 * on any route left out).
 */
export const RESTAURANT_ROUTE_RULES = {
    'GET /current': ANY,
    'DELETE /me': OWNER,
    'PATCH /profile': ['store_setup'],
    'PATCH /availability': ['orders', 'store_setup'],
    'PATCH /takeaway-settings': ['store_setup'],
    'PATCH /packaging-settings': ['store_setup'],
    // Notification Setup (the old panel's notification_setup module).
    'GET /notification-settings': ['store_setup'],
    'PATCH /notification-settings': ['store_setup'],
    'PATCH /dining-settings': ['store_setup'],
    'GET /outlet-timings': ANY,
    'PUT /outlet-timings': ['store_setup'],

    'GET /finance': ['wallet'],
    'POST /withdraw': ['withdraws'],
    'GET /withdrawals': ['withdraws', 'wallet'],
    'GET /disbursements': ['wallet'],
    'GET /payout-methods': ['wallet', 'withdraws'],
    'GET /payout-details': ['wallet'],
    'PUT /payout-details': ['wallet'],
    'GET /subscription-history': ['wallet'],
    'GET /subscription/overview': ['wallet'],
    'GET /subscription/invoices': ['wallet'],
    'GET /subscription/invoices/:invoiceId': ['wallet'],
    'GET /subscription/transactions': ['wallet'],

    'GET /advertisements': ['advertisements'],
    'POST /advertisements': ['advertisements'],
    'DELETE /advertisements/:id': ['advertisements'],

    'POST /profile/profile-image': ['store_setup'],
    'POST /profile/menu-image': ['store_setup'],
    'POST /profile/cover-images': ['store_setup'],
    'POST /profile/menu-images': ['store_setup'],
    'GET /app-banners': ANY,
    'GET /media': ['store_setup'],
    'POST /media/cover-image': ['store_setup'],
    'POST /media/gallery': ['store_setup'],
    'DELETE /media/gallery': ['store_setup'],
    'GET /banners': ['store_setup'],
    'POST /banners': ['store_setup'],
    'DELETE /banners': ['store_setup'],
    'PATCH /banners/order': ['store_setup'],

    'GET /categories': ANY,
    'POST /categories': ['categories'],
    'PATCH /categories/:id': ['categories'],
    'DELETE /categories/:id': ['categories'],
    'GET /menu': ['foods', 'categories'],
    'PATCH /menu': ['foods'],
    'POST /foods': ['foods'],
    'PATCH /foods/:id': ['foods'],
    'GET /bulk-upload/template': ['foods'],
    'POST /bulk-upload': ['foods'],
    'GET /addons': ['foods', 'categories'],
    'POST /addons': ['categories'],
    'PATCH /addons/:id': ['categories'],
    'DELETE /addons/:id': ['categories'],

    'POST /feedback-experience': ANY,

    'GET /orders': ['orders'],
    'GET /orders/:orderId': ['orders'],
    'GET /orders/:orderId/invoice': ['orders'],
    'PATCH /orders/:orderId/status': ['orders'],
    'POST /orders/:orderId/handover': ['orders'],
    'POST /orders/:orderId/resend-notification': ['orders'],

    'GET /complaints': ['reviews', 'orders'],
    'POST /support/tickets': ANY,
    'GET /support/tickets': ANY,
    'GET /reviews': ['reviews'],
    'PUT /reviews/:orderId/reply': ['reviews'],

    'GET /my-offers': ['coupons'],
    'POST /my-offers': ['coupons'],
    'PATCH /my-offers/:id/status': ['coupons'],
    'DELETE /my-offers/:id': ['coupons'],

    'GET /employee-roles/permissions': ['employees'],
    'GET /employee-roles': ['employees'],
    'POST /employee-roles': ['employees'],
    'PATCH /employee-roles/:id': ['employees'],
    'DELETE /employee-roles/:id': ['employees'],
    'GET /employees': ['employees'],
    'POST /employees': ['employees'],
    'GET /employees/:id': ['employees'],
    'PATCH /employees/:id': ['employees'],
    'PATCH /employees/:id/status': ['employees'],
    'DELETE /employees/:id': ['employees'],
};

/** Bank / UPI payout fields, which staff without `wallet` never see or set. */
export const PAYOUT_DETAIL_KEYS = new Set([
    'accountNumber', 'ifscCode', 'accountHolderName', 'accountType', 'upiId', 'upiQrImage', 'bankName', 'branchName',
]);

export const isEmployee = (user) => Boolean(user?.employeeId);

/** Owners hold every key; an employee holds their role's. */
export const hasRestaurantPermission = (user, ...keys) => {
    if (!isEmployee(user)) return true;
    const held = new Set(Array.isArray(user.permissions) ? user.permissions : []);
    return keys.flat().some((key) => held.has(key));
};

/** A copy of `value` with every payout detail key removed, however deep. */
export const redactPayoutDetails = (value) => {
    if (Array.isArray(value)) return value.map(redactPayoutDetails);
    if (!value || typeof value !== 'object' || value.constructor !== Object) return value;
    const out = {};
    for (const [key, inner] of Object.entries(value)) {
        if (PAYOUT_DETAIL_KEYS.has(key)) continue;
        out[key] = redactPayoutDetails(inner);
    }
    return out;
};

const labelOf = (key) => RESTAURANT_PERMISSIONS.find((p) => p.key === key)?.label || key;

/**
 * Decide one request. Pure: { allow: true } or { allow: false, message }.
 * `routePath` is Express's req.route.path for the matched route.
 */
export const decideRestaurantRoute = (user, method, routePath, body) => {
    if (!isEmployee(user)) return { allow: true };
    const verb = String(method || '').toUpperCase() === 'HEAD' ? 'GET' : String(method || '').toUpperCase();
    const rule = RESTAURANT_ROUTE_RULES[`${verb} ${routePath}`];
    if (rule === undefined || rule === OWNER) {
        return { allow: false, message: 'Only the restaurant owner can do this' };
    }
    if (rule !== ANY && !hasRestaurantPermission(user, rule)) {
        return { allow: false, message: `Your role does not include ${rule.map(labelOf).join(' or ')}` };
    }
    // Store setup may edit the profile, but bank and UPI details are finance's.
    if (verb !== 'GET' && body && typeof body === 'object' && !hasRestaurantPermission(user, 'wallet')
        && Object.keys(body).some((key) => PAYOUT_DETAIL_KEYS.has(key))) {
        return { allow: false, message: 'Your role does not include Wallet & finance, which bank and UPI details need' };
    }
    return { allow: true };
};

/**
 * Hide payout details from staff without `wallet` on whatever this request
 * sends back. Applied once per request, by the gates below.
 */
const hidePayoutDetailsFromStaff = (req, res) => {
    if (!isEmployee(req.user) || hasRestaurantPermission(req.user, 'wallet') || res.locals.payoutDetailsHidden) return;
    res.locals.payoutDetailsHidden = true;
    const json = res.json.bind(res);
    res.json = (body) => json(redactPayoutDetails(body));
};

/** For the restaurant router, after authMiddleware + the RESTAURANT role check. */
export const restaurantRouteGate = (req, res, next) => {
    const decision = decideRestaurantRoute(req.user, req.method, req.route?.path, req.body);
    if (!decision.allow) return sendError(res, 403, decision.message);
    hidePayoutDetailsFromStaff(req, res);
    return next();
};

/**
 * For routes outside the restaurant router that restaurants share with other
 * roles (chat, wallet): staff need one of `keys`; everyone else passes.
 */
export const requireRestaurantPermission = (...keys) => (req, res, next) => {
    if (req.user?.role !== 'RESTAURANT' || hasRestaurantPermission(req.user, keys)) {
        hidePayoutDetailsFromStaff(req, res);
        return next();
    }
    return sendError(res, 403, `Your role does not include ${keys.flat().map(labelOf).join(' or ')}`);
};
