import { prisma } from '../../../../config/prisma.js';
import { logger } from '../../../../utils/logger.js';

/**
 * Closing out orders that stopped moving.
 *
 * The dispatch hunt re-queues itself every 45 seconds for as long as it takes
 * to find a rider, and nothing ever calls it off. When the hunt dies -- the
 * queue is drained, the API restarts, Redis loses the delayed job -- the order
 * is simply left where it was: `preparing`, no rider, forever. Three of them
 * had been sitting open for four days, counted as live orders on the admin
 * dashboard, shown to the customer as still coming, and holding COD money that
 * could never be settled.
 *
 * The watchdog that already existed only heals orders stuck in `assigned` (a
 * rider was offered the order and never answered). An order that no rider was
 * ever assigned to does not match it, which is exactly the state these were in.
 *
 * Nothing here decides an order is stalled from its status alone -- it also has
 * to have gone quiet. `updatedAt` moves on every dispatch round, so an order
 * whose hunt is still running is never a candidate no matter how long it has
 * been open.
 */

/** Restaurant has not answered yet. */
const AWAITING_RESTAURANT = ['created'];

/**
 * The restaurant is on it, but no rider has taken the trip.
 *
 * `picked_up` and beyond are deliberately absent: a rider is holding the food,
 * so a human is already involved and cancelling under them would be wrong.
 */
const AWAITING_RIDER = ['confirmed', 'preparing', 'ready_for_pickup', 'reached_pickup'];

const minutes = (value, fallback) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

/**
 * How long an order may sit untouched before it is written off.
 *
 * Waiting on the restaurant is cheap to cancel -- nothing has been cooked -- so
 * that window is short. Once the kitchen has started, the food may already be
 * made, so the longer window gives dispatch and the admin alert (which fires at
 * about six minutes) a real chance before the order is given up on.
 */
export const expiryWindows = () => ({
    awaitingRestaurantMinutes: minutes(process.env.ORDER_ACCEPT_EXPIRY_MINUTES, 30),
    awaitingRiderMinutes: minutes(process.env.ORDER_DISPATCH_EXPIRY_MINUTES, 120),
});

/**
 * The `where` clauses for the two kinds of stall.
 *
 * Split out so the selection can be read and tested without a database: the
 * cost of getting these wrong is cancelling somebody's live order.
 */
export const buildStallFilters = (now = new Date(), windows = expiryWindows()) => {
    const cutoff = (mins) => new Date(now.getTime() - mins * 60 * 1000);

    return [
        {
            reason: 'restaurant-never-responded',
            note: 'The restaurant did not respond in time, so this order expired automatically.',
            where: {
                orderStatus: { in: AWAITING_RESTAURANT },
                updatedAt: { lt: cutoff(windows.awaitingRestaurantMinutes) },
            },
        },
        {
            reason: 'no-rider-found',
            note: 'We could not find a delivery partner for this order, so it expired automatically.',
            where: {
                orderStatus: { in: AWAITING_RIDER },
                // Never had a rider accept. Once one has, the trip is somebody's
                // job and a timer should not take it away from them.
                dispatchAcceptedAt: null,
                updatedAt: { lt: cutoff(windows.awaitingRiderMinutes) },
            },
        },
    ];
};

/**
 * Cancel every order that has stopped moving.
 *
 * Cancellation goes through the ordinary admin status change rather than a
 * direct write, so the refund, the status history, the customer's push and the
 * socket update all happen the way they do when a person does it. The only
 * difference is who it is recorded against.
 *
 * @returns {Promise<{expired: number, failed: number}>}
 */
export async function expireStalledOrders() {
    const { updateOrderStatusAdmin } = await import('./order.service.js');
    const windows = expiryWindows();
    let expired = 0;
    let failed = 0;

    for (const group of buildStallFilters(new Date(), windows)) {
        const rows = await prisma.foodOrder.findMany({
            where: group.where,
            select: { id: true, order_id: true, orderStatus: true, updatedAt: true },
        });
        if (!rows.length) continue;

        logger.warn(
            `[OrderExpiry] ${rows.length} order(s) stalled: ${group.reason}. ` +
                `Windows: ${windows.awaitingRestaurantMinutes}m awaiting restaurant, ` +
                `${windows.awaitingRiderMinutes}m awaiting rider.`,
        );

        for (const row of rows) {
            try {
                await updateOrderStatusAdmin(row.id, 'cancelled_by_admin', group.note, null, {
                    byRole: 'SYSTEM',
                });
                expired += 1;
                logger.info(
                    `[OrderExpiry] Expired ${row.order_id || row.id} ` +
                        `(${row.orderStatus}, idle since ${row.updatedAt.toISOString()}): ${group.reason}`,
                );
            } catch (err) {
                // One bad order must not stop the rest from being cleaned up.
                failed += 1;
                logger.error(
                    `[OrderExpiry] Could not expire ${row.order_id || row.id}: ${err?.message || err}`,
                );
            }
        }
    }

    return { expired, failed };
}
