import crypto from 'crypto';
import { ValidationError } from '../../../../core/auth/errors.js';

/**
 * The "Business Settings" tabs of the old panel, one JSON document per tab in
 * food_system_settings (key = the area name below). Each area has a cleaner:
 * unknown keys are dropped, numbers are range-checked, and cleaning `{}` gives
 * the old panel's values, so a fresh database behaves like the old live admin.
 *
 * Settings that already have a home elsewhere are not repeated here: the
 * maintenance switch is the `website` area, restaurant payouts are
 * FoodRestaurantPayoutSettings, rider cash limits, referral, loyalty, cancel
 * reasons and offline payment have their own pages. The admin page links to
 * them.
 *
 * Pure, so every rule is tested without a database. The runtime reader with
 * its short cache is core/settings/businessSettings.js.
 */

const str = (value, max = 500) => String(value ?? '').trim().slice(0, max);
const bool = (value, fallback = false) =>
    value === undefined || value === null || value === '' ? fallback : value === true || value === 'true' || value === 1 || value === '1';
const obj = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
const oneOf = (value, options, fallback) => (options.includes(value) ? value : fallback);

/** A number within [min, max], or the fallback when blank; a typed value out of range is refused. */
export function num(value, { min = 0, max = 1e9, fallback = 0, integer = false, label = 'Value' } = {}) {
    if (value === undefined || value === null || value === '') return fallback;
    const n = Number(value);
    if (!Number.isFinite(n)) throw new ValidationError(`${label} must be a number`);
    if (integer && !Number.isInteger(n)) throw new ValidationError(`${label} must be a whole number`);
    if (n < min || n > max) throw new ValidationError(`${label} must be between ${min} and ${max}`);
    return integer ? n : Math.round(n * 100) / 100;
}

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const time = (value, fallback, label) => {
    const t = str(value, 5) || fallback;
    if (!TIME.test(t)) throw new ValidationError(`${label} must be HH:MM, 24-hour`);
    return t;
};

// ─── Reason lists (refund reasons, order-issue messages) ─────────────────────

const REASON_ID = /^[a-f0-9]{12}$/;
const MAX_REASONS = 50;

/** [{ id, text, isActive }]: blank lines dropped, ids kept across edits, duplicates refused. */
export function cleanReasons(value, label) {
    const raw = Array.isArray(value) ? value : [];
    if (raw.length > MAX_REASONS) throw new ValidationError(`At most ${MAX_REASONS} ${label}`);
    const ids = new Set();
    const texts = new Set();
    const out = [];
    for (const item of raw) {
        const entry = typeof item === 'string' ? { text: item } : obj(item);
        const text = str(entry.text, 200);
        if (!text) continue;
        const lower = text.toLowerCase();
        if (texts.has(lower)) throw new ValidationError(`"${text}" is listed twice`);
        texts.add(lower);
        let id = REASON_ID.test(String(entry.id || '')) ? String(entry.id) : '';
        if (!id || ids.has(id)) id = crypto.randomBytes(6).toString('hex');
        ids.add(id);
        out.push({ id, text, isActive: bool(entry.isActive, true) });
    }
    return out;
}

// ─── Business info ───────────────────────────────────────────────────────────

export const RIDER_PAY_MODES = ['bands', 'percentage'];

const cleanBusinessInfo = (value) => {
    const input = obj(value);
    const extra = obj(input.additionalCharge);
    return {
        commissionModel: bool(input.commissionModel, true),
        subscriptionModel: bool(input.subscriptionModel, false),
        /** Used for restaurants with no row in FoodRestaurantCommission. */
        defaultCommissionPercent: num(input.defaultCommissionPercent, { max: 100, fallback: 15, label: 'Default commission' }),
        /** The platform's share of the delivery fee when riders are paid a percentage. */
        deliveryChargeCommissionPercent: num(input.deliveryChargeCommissionPercent, { max: 100, fallback: 20, label: 'Commission on delivery charge' }),
        /** 'bands': riders earn the distance-band pay (DeliveryFeeBand). 'percentage': 100 - commission % of the delivery fee. */
        riderPayMode: oneOf(input.riderPayMode, RIDER_PAY_MODES, 'bands'),
        currency: 'INR',
        currencyDecimals: num(input.currencyDecimals, { max: 2, fallback: 0, integer: true, label: 'Currency decimals' }),
        additionalCharge: {
            enabled: bool(extra.enabled, false),
            name: str(extra.name, 60),
            amount: num(extra.amount, { max: 10000, fallback: 0, label: 'Additional charge' }),
        },
    };
};

// ─── Deliveryman ─────────────────────────────────────────────────────────────

export const MAX_RIDER_ORDER_LIMIT = 10;

const cleanDeliveryman = (value) => {
    const input = obj(value);
    return {
        /** Deliveries a rider may hold at once (accepted, not yet delivered). */
        maxAssignedOrders: num(input.maxAssignedOrders, { min: 1, max: MAX_RIDER_ORDER_LIMIT, fallback: 2, integer: true, label: 'Maximum assigned order limit' }),
        riderCanCancelOrder: bool(input.riderCanCancelOrder, false),
        tipsEnabled: bool(input.tipsEnabled, false),
        showEarningToRider: bool(input.showEarningToRider, true),
        riderPictureUpload: bool(input.riderPictureUpload, true),
        riderSelfRegistration: bool(input.riderSelfRegistration, true),
    };
};

// ─── Order ───────────────────────────────────────────────────────────────────

export const ORDER_CONFIRMERS = ['restaurant', 'deliveryman'];

const cleanOrder = (value) => {
    const input = obj(value);
    const free = obj(input.freeDelivery);
    const freeDelivery = {
        enabled: bool(free.enabled, false),
        minSubtotal: num(free.minSubtotal, { max: 1000000, fallback: 0, label: 'Free delivery over' }),
    };
    if (freeDelivery.enabled && freeDelivery.minSubtotal <= 0) {
        throw new ValidationError('Enter the order amount above which delivery is free');
    }
    const homeDelivery = bool(input.homeDelivery, true);
    const takeaway = bool(input.takeaway, false);
    if (!homeDelivery && !takeaway) throw new ValidationError('Keep at least one of home delivery or takeaway on');
    return {
        homeDelivery,
        takeaway,
        scheduledOrder: bool(input.scheduledOrder, false),
        scheduleSlotMinutes: num(input.scheduleSlotMinutes, { min: 5, max: 240, fallback: 30, integer: true, label: 'Time slot interval' }),
        freeDelivery,
        extraPackagingCharge: bool(input.extraPackagingCharge, false),
        orderConfirmedBy: oneOf(input.orderConfirmedBy, ORDER_CONFIRMERS, 'restaurant'),
    };
};

// ─── Vendor ──────────────────────────────────────────────────────────────────

const cleanVendor = (value) => {
    const input = obj(value);
    return {
        restaurantCanCancelOrder: bool(input.restaurantCanCancelOrder, false),
        restaurantSelfRegistration: bool(input.restaurantSelfRegistration, true),
        // On by default, unlike the old panel: every new or edited dish has
        // always gone through approval here, and switching that off for every
        // restaurant on deploy should be the admin's choice.
        dishApprovalRequired: bool(input.dishApprovalRequired, true),
        canReplyToReviews: bool(input.canReplyToReviews, false),
        cashInHandLimit: bool(input.cashInHandLimit, false),
    };
};

// ─── Customer ────────────────────────────────────────────────────────────────

export const DISCOUNT_TYPES = ['amount', 'percent'];

const cleanCustomer = (value) => {
    const input = obj(value);
    const nc = obj(input.newCustomerDiscount);
    const type = oneOf(nc.type, DISCOUNT_TYPES, 'amount');
    const newCustomerDiscount = {
        enabled: bool(nc.enabled, false),
        type,
        value: num(nc.value, { max: type === 'percent' ? 100 : 100000, fallback: 0, label: 'New customer discount' }),
        maxDiscount: num(nc.maxDiscount, { max: 100000, fallback: 0, label: 'Maximum discount' }),
        minOrderAmount: num(nc.minOrderAmount, { max: 1000000, fallback: 0, label: 'Minimum order amount' }),
        validityDays: num(nc.validityDays, { max: 3650, fallback: 0, integer: true, label: 'Validity' }),
    };
    if (newCustomerDiscount.enabled && newCustomerDiscount.value <= 0) {
        throw new ValidationError('Enter the new customer discount before switching it on');
    }
    return {
        walletEnabled: bool(input.walletEnabled, true),
        addFundEnabled: bool(input.addFundEnabled, false),
        newCustomerDiscount,
        vegNonVegToggle: bool(input.vegNonVegToggle, true),
        guestCheckout: bool(input.guestCheckout, false),
    };
};

// ─── Payment ─────────────────────────────────────────────────────────────────

/** What may pay the rest of a partial (wallet + ...) payment: cash, online, or either. */
export const PARTIAL_PAYMENT_METHODS = ['both', 'cod', 'digital'];

const cleanPayment = (value) => {
    const input = obj(value);
    const cod = bool(input.cod, true);
    const digital = bool(input.digital, true);
    if (!cod && !digital) throw new ValidationError('Keep at least one of cash on delivery or digital payment on');
    return {
        cod,
        digital,
        partialPayment: bool(input.partialPayment, true),
        partialPaymentMethod: oneOf(input.partialPaymentMethod, PARTIAL_PAYMENT_METHODS, 'both'),
    };
};

// ─── Refund ──────────────────────────────────────────────────────────────────

const cleanRefund = (value) => {
    const input = obj(value);
    return {
        refundRequestEnabled: bool(input.refundRequestEnabled, true),
        reasons: cleanReasons(input.reasons, 'refund reasons'),
    };
};

// ─── Priority setup ──────────────────────────────────────────────────────────

/**
 * Home and search sections, and the sorts each may use besides 'default'.
 * `applied` says whether a public endpoint honours it (see the report /
 * USER_APP_API.md); the rest are saved for when the section exists.
 */
export const PRIORITY_SECTIONS = [
    { key: 'bestNearby', label: 'Best restaurants nearby', sorts: ['nearest', 'rating', 'newest'], applied: false },
    { key: 'recommended', label: 'Recommended restaurants', sorts: ['rating', 'nearest', 'newest', 'deliveryTime'], applied: true },
    { key: 'specialOffers', label: 'Special offers', sorts: ['newest', 'rating'], applied: false },
    { key: 'popularItems', label: 'Popular items', sorts: ['popular', 'rating', 'newest'], applied: false },
    { key: 'bestReviewed', label: 'Best reviewed items', sorts: ['rating', 'popular'], applied: false },
    { key: 'newOnLagech', label: 'New on Lagech', sorts: ['newest', 'rating'], applied: false },
    { key: 'allRestaurants', label: 'All restaurants', sorts: ['rating', 'nearest', 'newest', 'deliveryTime'], applied: true },
    { key: 'categoryItems', label: 'Category item lists', sorts: ['newest', 'price_low', 'price_high'], applied: true },
    { key: 'search', label: 'Search results', sorts: ['rating', 'newest', 'nearest'], applied: true },
];

const cleanPriority = (value) => {
    const sections = obj(obj(value).sections);
    return {
        sections: Object.fromEntries(PRIORITY_SECTIONS.map((section) => {
            const saved = obj(sections[section.key]);
            const custom = saved.mode === 'custom';
            const sort = oneOf(saved.sort, section.sorts, section.sorts[0]);
            return [section.key, { mode: custom ? 'custom' : 'default', sort }];
        })),
    };
};

// ─── Disbursement (riders; restaurants live in FoodRestaurantPayoutSettings) ─

const cleanDisbursement = (value) => {
    const input = obj(value);
    const rider = obj(input.rider);
    return {
        rider: {
            enabled: bool(rider.enabled, true),
            runTime: time(rider.runTime, '01:01', 'Rider disbursement time'),
            minAmount: num(rider.minAmount, { min: 1, max: 1000000, fallback: 1, label: 'Minimum rider disbursement' }),
            waitingDays: num(rider.waitingDays, { max: 30, fallback: 1, integer: true, label: 'Waiting days' }),
        },
    };
};

// ─── Automated messages (order-issue reasons) ────────────────────────────────

const cleanOrderIssueReasons = (value) => ({
    reasons: cleanReasons(obj(value).reasons, 'messages'),
});

/** key -> clean(value). Cleaning `{}` gives the old panel's defaults. */
export const BUSINESS_SETTINGS_AREAS = {
    business_info: cleanBusinessInfo,
    business_deliveryman: cleanDeliveryman,
    business_order: cleanOrder,
    business_vendor: cleanVendor,
    business_customer: cleanCustomer,
    business_payment: cleanPayment,
    business_refund: cleanRefund,
    business_priority: cleanPriority,
    business_disbursement: cleanDisbursement,
    business_order_issue_reasons: cleanOrderIssueReasons,
};

/** Fixed lists the admin page renders, per area. */
export const BUSINESS_AREA_CATALOG = {
    business_info: { riderPayModes: RIDER_PAY_MODES },
    business_deliveryman: { maxOrderLimit: MAX_RIDER_ORDER_LIMIT },
    business_order: { confirmers: ORDER_CONFIRMERS },
    business_vendor: {},
    business_customer: { discountTypes: DISCOUNT_TYPES },
    business_payment: {},
    business_refund: {},
    business_priority: { sections: PRIORITY_SECTIONS },
    business_disbursement: {},
    business_order_issue_reasons: {},
};
