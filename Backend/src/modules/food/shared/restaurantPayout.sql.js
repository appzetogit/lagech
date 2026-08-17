import { Prisma } from '@prisma/client';
import { prisma } from '../../../config/prisma.js';
import { computeRestaurantOrderShare, orderMoney } from './restaurantPayout.util.js';

/**
 * SQL twins of the predicates in restaurantPayout.util.js.
 *
 * The reports used to load every order a restaurant had ever taken into Node
 * and reduce it there, because the payout formula is JavaScript. That is fine
 * at a few hundred orders and fatal at a few hundred thousand. These let the
 * database do the summing.
 *
 * They must agree with the JS, so both live here and the tests assert on the
 * two producing the same number for the same rows. Queries using them alias
 * `food_orders` as `o` and LEFT JOIN `food_transactions` as `t`.
 */

/** Orders that count toward restaurant earnings — twin of isRestaurantEarnedOrder(). */
export const EARNED_ORDER = Prisma.sql`
    o."orderStatus" NOT IN ('cancelled_by_user', 'cancelled_by_restaurant', 'cancelled_by_admin')
    AND (o."orderStatus" = 'delivered' OR o."deliveryPhase" IN ('delivered', 'completed'))
`;

/**
 * The restaurant's share of one order — twin of computeRestaurantOrderShare().
 *
 * The transaction's recorded share wins whenever there is one; that is what
 * settlement actually paid. Only an order that never reached a transaction is
 * reconstructed from its own columns.
 */
export const RESTAURANT_SHARE = Prisma.sql`
    COALESCE(
        t."restaurantShare",
        GREATEST(0, o."subtotal" + o."packagingFee" - o."restaurantCommission")
    )
`;

/** Money that comes off the transaction where there is one, else the order. */
export const fromTxElseOrder = (column) => Prisma.sql`COALESCE(t.${Prisma.raw(`"${column}"`)}, o.${Prisma.raw(`"${column}"`)})`;

/** The join every aggregate here needs. */
export const ORDERS_JOINED = Prisma.sql`
    FROM "food_orders" o
    LEFT JOIN "food_transactions" t ON t."orderId" = o."id"
`;

/**
 * The one case the SQL above cannot settle.
 *
 * An order carrying a discount but no transaction has no recorded split, so
 * working out how much of that discount the restaurant bore means matching the
 * offer that produced it — which is JavaScript. RESTAURANT_SHARE therefore
 * over-states those orders by exactly the restaurant's share of the discount.
 *
 * Every order gets a transaction at checkout, so this set is normally empty. It
 * is corrected rather than ignored because the difference is money, and the
 * query is bounded by that anomaly rather than by the size of the table.
 */
export async function discountedOrdersWithoutTransaction(where) {
    return prisma.foodOrder.findMany({
        where: {
            ...where,
            discount: { gt: 0 },
            // Prisma models the FK from the transaction's side, so "no
            // transaction" is expressed as the relation being absent.
            foodTransaction: { is: null },
        },
        select: {
            id: true, restaurantId: true, orderStatus: true, deliveryPhase: true,
            subtotal: true, packagingFee: true, restaurantCommission: true,
            discount: true, couponCode: true,
        },
    });
}

/**
 * How much RESTAURANT_SHARE over-counted, per restaurant.
 *
 * Returns a Map of restaurantId → amount to subtract. Empty when every order
 * has a transaction, which is the normal case.
 */
export async function shareOverCountByRestaurant(where, offersByRestaurantId) {
    const orders = await discountedOrdersWithoutTransaction(where);
    if (!orders.length) return new Map();

    const overCount = new Map();
    for (const order of orders) {
        const offers = offersByRestaurantId.get(order.restaurantId) || [];
        const money = orderMoney(order, null);

        // What SQL produced for this row, minus what the JS formula says.
        const sqlValue = Math.max(
            0,
            Number(money.subtotal) + Number(money.packagingFee) - Number(money.restaurantCommission),
        );
        const actual = computeRestaurantOrderShare(money, offers, order.restaurantId);

        const delta = sqlValue - actual;
        if (delta !== 0) {
            overCount.set(order.restaurantId, (overCount.get(order.restaurantId) || 0) + delta);
        }
    }
    return overCount;
}
