import { prisma } from '../../../../config/prisma.js';
import { logger } from '../../../../utils/logger.js';
import { isId } from '../../../../utils/helpers.js';
import { NotFoundError } from '../../../../core/auth/errors.js';
import { toOrder, orderInclude } from '../order.mapper.js';
import { getBusinessSettings } from '../../shared/businessSettings.js';
import { loadRestaurantForOrdering } from './order-pricing.service.js';
import { notifyRestaurantNewOrder } from './order.helpers.js';
import { tryAutoAssign } from './order-dispatch.service.js';
import { AWAITING_RIDER } from './order-expiry.service.js';
import {
    buildScheduleSlots,
    scheduleLeadMinutes,
    scheduleReleaseMinutes,
    MAX_RIDER_TIP,
    TIP_PRESETS,
} from './orderModes.js';
import { additionalChargeFor, extraPackagingOffer } from './businessRules.js';

/**
 * Scheduled orders, takeaway and tips at the restaurant level: what a
 * customer may choose at checkout for one restaurant, and the job that
 * releases scheduled orders when their time comes.
 */

/**
 * GET /food/public/restaurants/:restaurantId/order-options
 *
 * Delivery / takeaway, the schedule slots (today and tomorrow, on the admin's
 * slot interval, from the lead time, within the restaurant's hours) and the
 * tip choices -- each only when Business Settings have it on.
 */
export async function getRestaurantOrderOptions(restaurantId, { now = new Date() } = {}) {
    if (!isId(restaurantId)) throw new NotFoundError('Restaurant not found');
    let restaurant;
    try {
        restaurant = await loadRestaurantForOrdering(String(restaurantId));
    } catch {
        throw new NotFoundError('Restaurant not found');
    }
    const [orderRules, riderRules, infoRules] = await Promise.all([
        getBusinessSettings('business_order'),
        getBusinessSettings('business_deliveryman'),
        getBusinessSettings('business_info'),
    ]);
    const takeaway = Boolean(orderRules.takeaway && restaurant.takeawayEnabled !== false);
    const additional = additionalChargeFor(infoRules);
    return {
        restaurantId: restaurant.id,
        /** The restaurant's extra packaging: null, or { amount, required } (required: always charged). */
        extraPackaging: (() => {
            const offer = extraPackagingOffer(orderRules, restaurant);
            return offer ? { amount: offer.amount, required: offer.required } : null;
        })(),
        /** The flat additional charge every order carries: null, or { name, amount }. */
        additionalCharge: additional.amount > 0 ? additional : null,
        orderTypes: {
            delivery: orderRules.homeDelivery !== false,
            takeaway,
        },
        schedule: orderRules.scheduledOrder
            ? {
                enabled: true,
                slotMinutes: orderRules.scheduleSlotMinutes,
                minLeadMinutes: scheduleLeadMinutes(),
                releaseMinutesBefore: scheduleReleaseMinutes(),
                days: buildScheduleSlots(restaurant, { slotMinutes: orderRules.scheduleSlotMinutes, now }),
            }
            : { enabled: false, days: [] },
        tips: riderRules.tipsEnabled
            ? { enabled: true, presets: TIP_PRESETS, max: MAX_RIDER_TIP }
            : { enabled: false, presets: [], max: 0 },
    };
}

/** Released orders older than this are left to the expiry and watchdog passes. */
const RELEASE_LOOKBACK_MS = 12 * 60 * 60 * 1000;

/**
 * Releases scheduled orders whose time has come. Run every minute by the
 * scheduler (scripts/run-scheduled-jobs.js); safe to run concurrently and
 * repeatedly:
 *
 *  - not yet accepted: the restaurant's new-order alert rings now
 *    (notifyRestaurantNewOrder claims restaurantNotifiedAt, so only once);
 *    the acceptance window was already set to start at the release time;
 *  - accepted early: the rider hunt starts now. "Not started" is a row not
 *    touched since its release time -- a hunt round writes to the row, and a
 *    hunt that dies later is the dead-hunt watchdog's.
 *
 * @returns {Promise<{alerted: number, dispatched: number}>}
 */
export async function releaseScheduledOrders(now = new Date()) {
    const since = new Date(now.getTime() - RELEASE_LOOKBACK_MS);
    let alerted = 0;
    let dispatched = 0;

    // When delivery partners confirm orders (Business Settings > Order) a
    // scheduled order is confirmed at placement, and the restaurant has still
    // not been told about it; otherwise a confirmed one was accepted early by
    // the restaurant itself and needs no alert.
    const { orderConfirmedBy } = await getBusinessSettings('business_order');
    const toAlert = await prisma.foodOrder.findMany({
        where: {
            releaseAt: { lte: now, gte: since },
            orderStatus: { in: orderConfirmedBy === 'deliveryman' ? ['created', 'confirmed'] : ['created'] },
            restaurantNotifiedAt: null,
        },
        include: orderInclude,
        take: 100,
    });
    for (const row of toAlert) {
        try {
            await notifyRestaurantNewOrder(toOrder(row));
            alerted += 1;
        } catch (err) {
            logger.warn(`Scheduled release: alert for ${row.id} failed: ${err?.message || err}`);
        }
    }

    const toDispatch = await prisma.$queryRaw`
        SELECT id FROM food_orders
         WHERE "releaseAt" <= ${now} AND "releaseAt" >= ${since}
           AND "updatedAt" < "releaseAt"
           AND "orderType" <> 'takeaway'
           AND "orderStatus"::text = ANY(${AWAITING_RIDER})
           AND "dispatchStatus" = 'unassigned'
           AND "dispatchDeliveryPartnerId" IS NULL
           AND "dispatchingAt" IS NULL
         LIMIT 100`;
    for (const { id } of toDispatch) {
        try {
            await tryAutoAssign(id);
            dispatched += 1;
        } catch (err) {
            logger.warn(`Scheduled release: dispatch for ${id} failed: ${err?.message || err}`);
        }
    }

    if (alerted || dispatched) {
        logger.info(`Scheduled release: ${alerted} restaurant alert(s), ${dispatched} rider hunt(s) started`);
    }
    return { alerted, dispatched };
}
