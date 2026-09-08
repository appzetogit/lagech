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
 * Age is measured from when the order was meant to happen -- `scheduledAt` if
 * the customer picked a time, otherwise when they placed it. Deliberately not
 * `updatedAt`: the watchdog restarts the dispatch hunt, and a hunt touches the
 * row, so an order that is being retried would keep resetting its own clock and
 * never expire. What keeps a live order safe is the status and rider guards
 * below, not the timestamp.
 */

/** Restaurant has not answered yet. */
const AWAITING_RESTAURANT = ['created'];

/**
 * The restaurant is on it, but no rider has taken the trip.
 *
 * `picked_up` and beyond are deliberately absent: a rider is holding the food,
 * so a human is already involved and cancelling under them would be wrong.
 */
export const AWAITING_RIDER = ['confirmed', 'preparing', 'ready_for_pickup', 'reached_pickup'];

/**
 * Older than this, by the clock that matters to the customer.
 *
 * A scheduled order is not late until the time it was scheduled for, so an
 * order placed at noon for 7pm must not be expired at half past twelve.
 */
const olderThan = (cutoff) => ({
    OR: [
        { scheduledAt: null, createdAt: { lt: cutoff } },
        { scheduledAt: { lt: cutoff } },
    ],
});

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
                ...olderThan(cutoff(windows.awaitingRestaurantMinutes)),
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
                ...olderThan(cutoff(windows.awaitingRiderMinutes)),
            },
        },
    ];
};

/**
 * Orders whose dispatch hunt has died and should be started again.
 *
 * A hunt lives only in the delayed job it queues for itself each round, so when
 * that job is lost -- the API restarts, the queue is drained -- the order stops
 * dead with no rider and nothing to wake it. Trying again is what should happen
 * before giving up, so this sits alongside the expiry filters: the resume window
 * ends exactly where the expiry window begins, and an order is only ever in one
 * of them.
 *
 * @param {number} huntDeadAfterMs how long silent counts as "the hunt is gone"
 */
export const buildDeadHuntFilter = (now = new Date(), windows = expiryWindows(), huntDeadAfterMs = 3 * 60 * 1000) => {
    const openedAfter = new Date(now.getTime() - windows.awaitingRiderMinutes * 60 * 1000);

    return {
        orderStatus: { in: AWAITING_RIDER },
        dispatchStatus: 'unassigned',
        // No rider holds this trip, by either half of the record.
        dispatchAcceptedAt: null,
        dispatchDeliveryPartnerId: null,
        // Not in the middle of a round right now.
        dispatchingAt: null,
        // A live hunt writes to the row every round, so silence for several
        // rounds is what says it has stopped rather than merely being slow.
        updatedAt: { lt: new Date(now.getTime() - huntDeadAfterMs) },
        // Past this the expiry pass is about to close the order, and waking every
        // rider for it would only be a push nobody can act on.
        OR: [
            { scheduledAt: null, createdAt: { gte: openedAfter } },
            { scheduledAt: { gte: openedAfter } },
        ],
    };
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
            select: { id: true, order_id: true, orderStatus: true, createdAt: true, scheduledAt: true },
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
                        `(${row.orderStatus}, open since ${(row.scheduledAt || row.createdAt).toISOString()}): ` +
                        group.reason,
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
