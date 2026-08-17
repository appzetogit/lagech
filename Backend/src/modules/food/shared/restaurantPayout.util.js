import { isCancelledOrder } from '../orders/services/order.helpers.js';
import { resolveDiscountSplit } from './discountSplit.util.js';

/**
 * What a restaurant earns from one order.
 *
 * These take a flat `money` object rather than an order or a transaction,
 * because the same numbers arrive under two shapes: Postgres has them as
 * columns on `FoodTransaction` / `FoodOrder`, and the not-yet-ported report
 * code still has them nested under `pricing` and `amounts`. The column names
 * and the old field names are identical, so `orderMoney()` below flattens the
 * nested shape and every caller ends up passing the same thing.
 */

/** Delivered / completed orders that count toward restaurant earnings. */
export function isRestaurantEarnedOrder(order) {
    if (isCancelledOrder(order)) return false;
    const orderStatus = String(order?.orderStatus || order?.status || '').trim().toLowerCase();
    // deliveryPhase is the column; deliveryState.currentPhase was the sub-document.
    const deliveryPhase = String(
        order?.deliveryPhase || order?.deliveryState?.currentPhase || '',
    ).trim().toLowerCase();

    return (
        orderStatus === 'delivered' ||
        deliveryPhase === 'delivered' ||
        deliveryPhase === 'completed'
    );
}

/**
 * The money fields for one order, preferring the transaction's snapshot.
 *
 * A transaction is written when payment is set up and is what finance reports
 * settle against; the order's own columns are the fallback for orders that
 * never reached one.
 */
export function orderMoney(order, tx = null) {
    if (tx) {
        // Nested while the reports are still on the Mongo shape; flat afterwards.
        if (tx.pricing || tx.amounts) return { ...(tx.pricing || {}), ...(tx.amounts || {}) };
        return tx;
    }
    if (order?.pricing) return { ...order.pricing };
    return order || {};
}

/**
 * Restaurant net share for one order — same formula as Hub Finance / wallet payout.
 *
 * `restaurantShare` is what the split actually credited, so it wins whenever it
 * was recorded. The subtraction below only reconstructs it for orders written
 * before the split was stored.
 */
export function computeRestaurantOrderShare(money = {}, offers = [], restaurantId = null) {
    const stored = Number(money.restaurantShare);
    if (Number.isFinite(stored)) return Math.max(0, stored);

    const subtotal = Number(money.subtotal) || 0;
    const packagingFee = Number(money.packagingFee) || 0;
    const commission = Number(money.restaurantCommission) || 0;
    const { restaurantDiscountShare } = resolveDiscountSplit({ money, offers, restaurantId });

    return Math.max(0, subtotal + packagingFee - commission - restaurantDiscountShare);
}
