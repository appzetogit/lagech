/**
 * Restaurant and rider star ratings, recomputed from the imported orders.
 *
 * This system keeps a running (rating, totalRatings) pair per restaurant and
 * rider, folded in one rated order at a time (applyAggregateRating). Imported
 * orders arrive already rated, so nothing folded them in and every restaurant
 * showed 0 stars. This sets each pair to exactly what folding in every rated
 * order would have produced: the average of the orders' ratings, and their
 * count. Recomputed from scratch, so a re-run gives the same answer.
 *
 * A sync recomputes only the restaurants and riders whose orders it added or
 * changed (the orders step names them), from all their rated orders -- those
 * placed here included.
 *
 * Dishes are not touched: the foods step already carried each dish's own
 * rating from the old system.
 */
import { prisma } from '../../../src/config/prisma.js';

export async function importRatings(mysql, report, ctx = {}) {
    const scope = (kind) => (ctx.sync ? [...(ctx.affected?.(kind) || [])] : null);
    const restaurantIds = scope('restaurant');
    const riderIds = scope('rider');

    const restaurants = restaurantIds && !restaurantIds.length ? 0 : await prisma.$executeRaw`
        UPDATE food_restaurants r
           SET rating = COALESCE(agg.avg, 0),
               "totalRatings" = COALESCE(agg.n, 0),
               "updatedAt" = now()
          FROM (SELECT r2.id, ROUND(AVG(o."restaurantRating")::numeric, 1) AS avg, COUNT(o."restaurantRating")::int AS n
                  FROM food_restaurants r2
                  LEFT JOIN food_orders o ON o."restaurantId" = r2.id AND o."restaurantRating" IS NOT NULL
                 WHERE ${restaurantIds}::text[] IS NULL OR r2.id = ANY(${restaurantIds}::text[])
                 GROUP BY r2.id) agg
         WHERE agg.id = r.id
           AND (r.rating IS DISTINCT FROM COALESCE(agg.avg, 0) OR r."totalRatings" IS DISTINCT FROM COALESCE(agg.n, 0))`;

    const riders = riderIds && !riderIds.length ? 0 : await prisma.$executeRaw`
        UPDATE food_delivery_partners p
           SET rating = COALESCE(agg.avg, 0),
               "totalRatings" = COALESCE(agg.n, 0),
               "updatedAt" = now()
          FROM (SELECT p2.id, ROUND(AVG(o."partnerRating")::numeric, 1) AS avg, COUNT(o."partnerRating")::int AS n
                  FROM food_delivery_partners p2
                  LEFT JOIN food_orders o ON o."dispatchDeliveryPartnerId" = p2.id AND o."partnerRating" IS NOT NULL
                 WHERE ${riderIds}::text[] IS NULL OR p2.id = ANY(${riderIds}::text[])
                 GROUP BY p2.id) agg
         WHERE agg.id = p.id
           AND (p.rating IS DISTINCT FROM COALESCE(agg.avg, 0) OR p."totalRatings" IS DISTINCT FROM COALESCE(agg.n, 0))`;

    const [rated] = await prisma.$queryRaw`
        SELECT (SELECT COUNT(*)::int FROM food_restaurants WHERE "totalRatings" > 0) AS restaurants,
               (SELECT COUNT(*)::int FROM food_delivery_partners WHERE "totalRatings" > 0) AS riders`;

    for (let i = 0; i < restaurants + riders; i += 1) report.done('rating', 'updated');
    report.warn('rating', '-', '(all)', ctx.sync
        ? `ratings recomputed for ${restaurantIds.length} restaurant(s) and ${riderIds.length} rider(s) with new or changed orders; ${restaurants + riders} changed`
        : `ratings recomputed from rated orders: ${rated.restaurants} restaurant(s) and ${rated.riders} rider(s) now have stars`);
}
