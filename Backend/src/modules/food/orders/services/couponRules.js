/**
 * Whether a coupon applies to a cart, and what it takes off.
 *
 * The rules follow the previous system (6amMart) coupon types:
 *
 *   default        any order
 *   store_wise     only orders from the named restaurant(s)
 *   zone_wise      only orders whose restaurant is in one of the named zones
 *   free_delivery  the delivery fee (and the GST on it) is waived; the item
 *                  discount is 0. Platform fee and item GST are still charged.
 *   first_order    only a customer's first order (see USED_ORDER_WHERE)
 *
 * On top of the type, every coupon checks: switched on, started, not expired,
 * customer restriction, minimum purchase on the item subtotal, the overall
 * usage limit and the per-customer limit. Percent discounts are capped by
 * maxDiscount when one is set.
 *
 * Pure: everything that needs the database (prior orders, uses so far) is
 * passed in, so the rules can be tested without one. order-pricing.service.js
 * loads those numbers and calls evaluateCoupon.
 */

export const COUPON_TYPES = ['default', 'store_wise', 'zone_wise', 'free_delivery', 'first_order'];

/**
 * Orders that count as having happened, for "first order" and for coupon
 * uses: anything placed except an online payment never completed
 * (pending_payment), a failed payment, or a cancelled order. A customer whose
 * only order was cancelled is still on their first order, and a cancelled
 * order gives its coupon use back.
 */
export const CANCELLED_STATUSES = ['cancelled_by_user', 'cancelled_by_restaurant', 'cancelled_by_admin'];
export const USED_ORDER_WHERE = {
    orderStatus: { notIn: ['pending_payment', ...CANCELLED_STATUSES] },
    paymentStatus: { not: 'failed' },
};

const isId = (v) => typeof v === 'string' && /^[0-9a-f]{24}$/i.test(v);

/** The restaurants a coupon names: the list, or the older single column. */
export const couponRestaurantIds = (offer) =>
    Array.isArray(offer?.restaurantIds) && offer.restaurantIds.length > 0
        ? offer.restaurantIds.map(String)
        : [offer?.restaurantId].filter(Boolean).map(String);

/**
 * The type a coupon behaves as. A row from before couponType existed carries
 * the default, so its older columns decide.
 */
export const effectiveCouponType = (offer) => {
    const t = offer?.couponType;
    if (t && t !== 'default') return t;
    if (offer?.restaurantScope === 'selected') return 'store_wise';
    if (offer?.isFirstOrderOnly === true || offer?.customerScope === 'first_time') return 'first_order';
    return 'default';
};

export const requiresFirstOrder = (offer) =>
    effectiveCouponType(offer) === 'first_order' ||
    offer?.isFirstOrderOnly === true ||
    offer?.customerScope === 'first_time';

const rupees = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const day = (d) =>
    new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });

/** End of the coupon's last day. Rows saved as a bare midnight mean that whole day. */
const endInstant = (endDate) => {
    if (!endDate) return null;
    const end = new Date(endDate);
    if (end.getUTCHours() === 0 && end.getUTCMinutes() === 0 && end.getUTCSeconds() === 0 && end.getUTCMilliseconds() === 0) {
        end.setUTCHours(23, 59, 59, 999);
    }
    return end;
};

const reject = (reason, message) => ({ ok: false, reason, message, discount: 0, deliveryFeeWaived: 0 });

/**
 * @param {object} offer   a food_offers row (or null when the code matched nothing)
 * @param {object} ctx
 * @param {Date}   ctx.now
 * @param {string} [ctx.userId]
 * @param {string} [ctx.restaurantId]
 * @param {string} [ctx.zoneId]        the order's zone (the restaurant's)
 * @param {number} ctx.subtotal        item subtotal
 * @param {number} [ctx.deliveryFee]   delivery fee before any waiver
 * @param {number} [ctx.deliveryFeeGst] GST on that fee
 * @param {number} [ctx.priorOrders]   the customer's orders that count (USED_ORDER_WHERE)
 * @param {number} [ctx.userUses]      this customer's counted uses of this coupon
 * @returns {{ ok: boolean, reason?: string, message?: string, discount: number, deliveryFeeWaived: number, couponType?: string }}
 */
export function evaluateCoupon(offer, ctx = {}) {
    if (!offer) return reject('not_found', 'This coupon code is not valid');

    const now = ctx.now instanceof Date ? ctx.now : new Date();
    const subtotal = Math.max(0, Number(ctx.subtotal) || 0);
    const type = effectiveCouponType(offer);
    const signedIn = isId(String(ctx.userId || ''));

    if (offer.status !== 'active' || offer.showInCart === false) {
        return reject('inactive', 'This coupon is not active');
    }
    if (offer.startDate && now < new Date(offer.startDate)) {
        return reject('not_started', `This coupon can be used from ${day(offer.startDate)}`);
    }
    const end = endInstant(offer.endDate);
    if (end && now > end) {
        return reject('expired', `This coupon expired on ${day(end)}`);
    }

    if (type === 'store_wise' || offer.restaurantScope === 'selected') {
        const ids = couponRestaurantIds(offer);
        if (!ids.includes(String(ctx.restaurantId || ''))) {
            return reject('wrong_restaurant', 'This coupon is not valid for this restaurant');
        }
    }
    if (type === 'zone_wise') {
        const zones = Array.isArray(offer.zoneIds) ? offer.zoneIds.map(String) : [];
        if (!ctx.zoneId || !zones.includes(String(ctx.zoneId))) {
            return reject('wrong_zone', 'This coupon is not valid in this area');
        }
    }

    // A coupon issued to named customers is not usable by anyone else, even if
    // they learn the code. An anonymous cart has nobody to match.
    if (offer.customerScope === 'specific') {
        const allow = Array.isArray(offer.customerIds) ? offer.customerIds.map(String) : [];
        if (!signedIn) return reject('login_required', 'Log in to use this coupon');
        if (!allow.includes(String(ctx.userId))) {
            return reject('not_eligible', 'This coupon is not available for your account');
        }
    }

    if (requiresFirstOrder(offer)) {
        if (!signedIn) return reject('login_required', 'Log in to use this coupon');
        if (Number(ctx.priorOrders) > 0) {
            return reject('not_first_order', 'This coupon is only valid on your first order');
        }
    }

    const minPurchase = Number(offer.minOrderValue) || 0;
    if (subtotal < minPurchase) {
        return reject('min_purchase', `Add items worth ${rupees(minPurchase - subtotal)} more to use this coupon (minimum purchase ${rupees(minPurchase)})`);
    }

    if (Number(offer.usageLimit) > 0 && Number(offer.usedCount || 0) >= Number(offer.usageLimit)) {
        return reject('limit_reached', 'This coupon has reached its usage limit');
    }
    if (Number(offer.perUserLimit) > 0) {
        if (!signedIn) return reject('login_required', 'Log in to use this coupon');
        if (Number(ctx.userUses || 0) >= Number(offer.perUserLimit)) {
            return reject('user_limit_reached', 'You have already used this coupon the maximum number of times');
        }
    }

    if (type === 'free_delivery') {
        const fee = Math.max(0, Number(ctx.deliveryFee) || 0);
        const gst = Math.max(0, Number(ctx.deliveryFeeGst) || 0);
        return { ok: true, couponType: type, discount: 0, deliveryFeeWaived: Math.round((fee + gst) * 100) / 100 };
    }

    let discount;
    if (offer.discountType === 'percentage') {
        const raw = subtotal * ((Number(offer.discountValue) || 0) / 100);
        const cap = Number(offer.maxDiscount);
        discount = cap > 0 ? Math.min(raw, cap) : raw;
    } else {
        discount = Number(offer.discountValue) || 0;
    }
    discount = Math.max(0, Math.min(subtotal, Math.floor(discount)));
    return { ok: true, couponType: type, discount, deliveryFeeWaived: 0 };
}
