/**
 * The Business Settings rules order placement and pricing obey, as pure
 * functions over the cleaned settings (see admin/services/businessSettings.defaults.js),
 * so each rule is tested without a database.
 */

const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Online methods switched by "Digital payment". Offline and wallet have their own switches. */
export const DIGITAL_METHODS = ['razorpay', 'razorpay_qr', 'card'];

/**
 * Why a payment method may not be used, worded for the customer, or null.
 * `codEnvEnabled` is the COD_ENABLED deploy switch, which still wins.
 */
export function paymentMethodRefusal(method, { payment, customer, codEnvEnabled = true }) {
    if (method === 'cash' && (!payment.cod || !codEnvEnabled)) {
        return 'Cash on Delivery is not available right now. Please pay online.';
    }
    if (DIGITAL_METHODS.includes(method) && !payment.digital) {
        return 'Online payment is not available right now. Please choose another payment method.';
    }
    if (method === 'wallet' && !customer.walletEnabled) {
        return 'Wallet payment is not available right now. Please choose another payment method.';
    }
    return null;
}

/** Scheduled orders off: anything more than this ahead of now counts as scheduled. */
export const SCHEDULE_GRACE_MS = 5 * 60 * 1000;

export function isScheduledFor(scheduledAt, now = new Date()) {
    if (!scheduledAt) return false;
    const at = new Date(scheduledAt);
    return !Number.isNaN(at.getTime()) && at.getTime() - now.getTime() > SCHEDULE_GRACE_MS;
}

/**
 * Delivery fee plus its GST waived by "free delivery over ₹X", or 0. Never
 * stacks with a coupon that already waived the fee.
 */
export function freeDeliveryOverWaiver(rule, { subtotal, deliveryFee, deliveryFeeGst, couponWaived = 0 }) {
    if (!rule?.enabled || !(Number(rule.minSubtotal) > 0)) return 0;
    if (Number(couponWaived) > 0) return 0;
    if (!(Number(subtotal) >= Number(rule.minSubtotal))) return 0;
    return round2((Number(deliveryFee) || 0) + (Number(deliveryFeeGst) || 0));
}

/**
 * The new-customer discount on a customer's first order, or 0.
 *
 * Applies when it is switched on, the customer has no earlier order that
 * counts (placed, not cancelled or failed), their account is younger than the
 * validity (0 days = no limit), the item total reaches the minimum, and no
 * coupon discount already applies -- the two do not stack.
 */
export function newCustomerDiscount(rule, { subtotal, priorOrders, accountCreatedAt, couponDiscount = 0, now = new Date() }) {
    if (!rule?.enabled || !(Number(rule.value) > 0)) return 0;
    if (Number(priorOrders) > 0 || Number(couponDiscount) > 0) return 0;
    const items = Number(subtotal) || 0;
    if (items <= 0 || items < (Number(rule.minOrderAmount) || 0)) return 0;
    if (Number(rule.validityDays) > 0) {
        const created = accountCreatedAt ? new Date(accountCreatedAt).getTime() : NaN;
        if (!Number.isFinite(created) || now.getTime() - created > Number(rule.validityDays) * DAY_MS) return 0;
    }
    let amount = rule.type === 'percent' ? (items * Number(rule.value)) / 100 : Number(rule.value);
    if (rule.type === 'percent' && Number(rule.maxDiscount) > 0) amount = Math.min(amount, Number(rule.maxDiscount));
    return round2(Math.max(0, Math.min(amount, items)));
}

/**
 * Rider pay when riders are paid a share of the delivery fee: the fee the
 * order was priced at before any waiver (excluding its GST), less the
 * platform's commission on delivery charge.
 */
export function percentageRiderEarning(originalDeliveryFee, commissionPercent) {
    const fee = Number(originalDeliveryFee) || 0;
    const pct = Math.min(100, Math.max(0, Number(commissionPercent) || 0));
    return round2(Math.max(0, (fee * (100 - pct)) / 100));
}

/**
 * The restaurant's extra packaging charge for one order, or 0 (Business
 * Settings > Order "extra packaging charge", as in the old panel): charged
 * only while the global switch is on and the restaurant has its own charge
 * on; a restaurant that requires it adds it to every order, otherwise only
 * when the customer asked for it (`requested`). It is the restaurant's money
 * (packagingFee is part of the restaurant's share), takes no coupon and
 * carries no commission.
 */
export function extraPackagingFee(orderRules, restaurant, requested = false) {
    if (!orderRules?.extraPackagingCharge || !restaurant?.extraPackagingEnabled) return 0;
    const amount = round2(Math.max(0, Number(restaurant.extraPackagingAmount) || 0));
    if (amount <= 0) return 0;
    const wanted = requested === true || requested === 'true';
    return restaurant.extraPackagingRequired || wanted ? amount : 0;
}

/**
 * What checkout should offer for extra packaging at this restaurant, or null
 * when there is nothing to offer: { amount, required, applied }.
 */
export function extraPackagingOffer(orderRules, restaurant, chargedFee = 0) {
    const amount = extraPackagingFee(orderRules, restaurant, true);
    if (amount <= 0) return null;
    return { amount, required: Boolean(restaurant.extraPackagingRequired), applied: Number(chargedFee) > 0 };
}

/**
 * The flat additional charge on every order (Business Settings > Business
 * info), as { amount, name }; { 0, '' } when off. The platform's money: it is
 * added to platformFee, so every split, refund and report already counts it.
 */
export function additionalChargeFor(info) {
    const rule = info?.additionalCharge;
    const amount = round2(Math.max(0, Number(rule?.amount) || 0));
    if (!rule?.enabled || amount <= 0) return { amount: 0, name: '' };
    return { amount, name: String(rule.name || '').trim() || 'Additional charge' };
}
