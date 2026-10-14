/**
 * Admin order editing (the old 6amMart panel's "Edit" on Order Details) and
 * the admin's payment reference code, as pure rules so they are tested
 * without a database. adminOrderEdit.service.js applies them.
 */
import { ValidationError } from '../../../../core/auth/errors.js';

/**
 * Statuses an order's items can still change in: placed, accepted, cooking.
 * From ready_for_pickup on the food is packed and a rider may be at the
 * counter, so the bill the rider collects against is settled.
 */
export const EDITABLE_ORDER_STATUSES = ['created', 'confirmed', 'preparing'];

/** Paid at the door (or offline, before the admin verified it): nothing was captured yet. */
export const EDITABLE_PAYMENT_METHODS = ['cash', 'razorpay_qr', 'offline'];

/** Money already taken for the order. */
const PAID_STATUSES = ['paid', 'authorized', 'refunded'];

const CANCELLED = ['cancelled_by_user', 'cancelled_by_restaurant', 'cancelled_by_admin'];

/**
 * Why the admin may not edit this order's items, or null when they may.
 *
 * Takes the toOrder shape (payment.method, deliveryState.pickedUpAt) or a bare
 * row (paymentMethod, pickedUpAt). Like 6amMart, an order paid digitally is
 * never edited: the customer would have to be charged again or refunded the
 * difference, and neither happens from this screen.
 */
export function orderEditRefusal(order) {
    if (!order) return 'Order not found';
    const status = String(order.orderStatus || '');
    const method = String(order.payment?.method ?? order.paymentMethod ?? '');
    const paymentStatus = String(order.payment?.status ?? order.paymentStatus ?? '');
    const walletAmount = Number(order.payment?.walletAmount ?? order.walletAmount ?? 0) || 0;
    const pickedUpAt = order.deliveryState?.pickedUpAt ?? order.pickedUpAt ?? null;
    const refundStatus = String(order.payment?.refund?.status ?? order.refundStatus ?? 'none');

    if (status === 'pending_payment') return 'This order is still waiting for its payment.';
    if (CANCELLED.includes(status)) return 'This order was cancelled.';
    if (status === 'delivered') return 'This order was already delivered.';
    if (pickedUpAt || ['picked_up', 'reached_drop'].includes(status)) {
        return 'This order was already picked up, so its items can no longer change.';
    }
    if (!EDITABLE_ORDER_STATUSES.includes(status)) {
        return 'This order is ready for pickup, so its items can no longer change.';
    }

    if (method === 'wallet') return 'This order was paid from the wallet, so it cannot be edited.';
    if (walletAmount > 0) return 'Part of this order was paid from the wallet, so it cannot be edited.';
    if (method === 'razorpay' || method === 'card') return 'This order was paid online, so it cannot be edited.';
    if (!EDITABLE_PAYMENT_METHODS.includes(method)) return 'This order cannot be edited for its payment method.';
    if (PAID_STATUSES.includes(paymentStatus)) return 'This order is already paid, so it cannot be edited.';
    if (paymentStatus === 'pending_qr') {
        return 'A payment QR for this order is already out, so it cannot be edited.';
    }
    if (refundStatus && refundStatus !== 'none') return 'A refund was started for this order, so it cannot be edited.';
    return null;
}

export const REFERENCE_CODE_MAX = 100;

/**
 * The admin's reference code for an order (a UPI / bank transaction ref for a
 * cash or offline payment): trimmed, at most REFERENCE_CODE_MAX characters,
 * printable characters only. Empty clears it (null).
 */
export function cleanReferenceCode(value) {
    if (value === undefined) throw new ValidationError('referenceCode is required (send "" to clear it)');
    if (value !== null && typeof value !== 'string' && typeof value !== 'number') {
        throw new ValidationError('Reference code must be text');
    }
    const code = String(value ?? '').trim();
    if (!code) return null;
    if (code.length > REFERENCE_CODE_MAX) {
        throw new ValidationError(`Reference code can be at most ${REFERENCE_CODE_MAX} characters`);
    }
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(code)) throw new ValidationError('Reference code has invalid characters');
    return code;
}

/**
 * The edit request's lines, in the shape order creation prices
 * (resolveCartWithCampaigns): { itemId, variantId, quantity, addons, notes,
 * campaignId }. `foodId` is accepted for itemId.
 */
export const MAX_EDIT_QUANTITY = 100;

export function cleanEditLines(items) {
    if (!Array.isArray(items) || items.length === 0) {
        throw new ValidationError('At least one item must remain on the order');
    }
    if (items.length > 100) throw new ValidationError('Too many lines');
    return items.map((raw) => {
        const itemId = String(raw?.itemId ?? raw?.foodId ?? raw?.id ?? '').trim();
        if (!itemId) throw new ValidationError('Each line needs an item id');
        const quantity = Number(raw?.quantity);
        if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_EDIT_QUANTITY) {
            throw new ValidationError(`Quantity must be a whole number from 1 to ${MAX_EDIT_QUANTITY}`);
        }
        const addons = Array.isArray(raw?.addons)
            ? raw.addons
                .map((a) => (a && typeof a === 'object' ? String(a.addonId ?? a.id ?? '').trim() : String(a ?? '').trim()))
                .filter(Boolean)
            : [];
        const campaignId = String(raw?.campaignId ?? raw?.itemCampaignId ?? '').trim();
        return {
            itemId,
            variantId: String(raw?.variantId || '').trim(),
            quantity,
            addons,
            notes: String(raw?.notes || '').slice(0, 500),
            ...(campaignId ? { campaignId } : {}),
        };
    });
}
