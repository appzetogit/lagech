import { Prisma } from '@prisma/client';
import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../../../../core/auth/errors.js';
import { getBusinessSettings } from '../../shared/businessSettings.js';

/**
 * Customer reviews of one restaurant, for the customer app: the star rating a
 * customer gave the restaurant after an order, with their comment and the first
 * dish in that order. Only the reviewer's first name and last initial are
 * shown, never their phone.
 *
 * A review an admin has hidden stays out. Hiding is done on a dish review
 * (food_order_item_ratings.isHidden); this list is of order-level restaurant
 * reviews, so an order is left out when any of its dish reviews was hidden --
 * it is the same customer's write-up of the same meal.
 *
 * A restaurant may reply to a review when Business Settings > Restaurant
 * "restaurant can reply to reviews" is on (food_orders.restaurantReply). The
 * reply is public: it comes back with the review here.
 */

const MAX_REPLY = 1000;

const MAX_LIMIT = 50;

/** "Akshat Kaushal" -> "Akshat K.", "neha" -> "Neha", "" -> "Customer". */
export function displayName(raw) {
    const parts = String(raw || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return 'Customer';
    const cap = (w) => w.charAt(0).toUpperCase() + w.slice(1);
    return parts.length > 1 ? `${cap(parts[0])} ${parts[parts.length - 1].charAt(0).toUpperCase()}.` : cap(parts[0]);
}

export async function getRestaurantReviews(restaurantId, query = {}) {
    if (!isId(restaurantId)) throw new NotFoundError('Restaurant not found');
    const restaurant = await prisma.foodRestaurant.findUnique({
        where: { id: String(restaurantId) },
        select: { id: true, rating: true, totalRatings: true },
    });
    if (!restaurant) throw new NotFoundError('Restaurant not found');

    const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
    const limit = Math.min(MAX_LIMIT, Math.max(1, Number.parseInt(query.limit, 10) || 20));
    const withComments = query.withComments === 'true';
    const commentFilter = withComments ? Prisma.sql`AND o."restaurantRatingComment" <> ''` : Prisma.empty;
    const notHidden = Prisma.sql`AND NOT EXISTS (SELECT 1 FROM food_order_item_ratings h WHERE h."orderId" = o.id AND h."isHidden")`;

    const [rows, stats] = await Promise.all([
        prisma.$queryRaw`
            SELECT o.id, o."restaurantRating" AS rating, o."restaurantRatingComment" AS comment,
                   COALESCE(o."restaurantRatedAt", o."deliveredAt", o."createdAt") AS "ratedAt",
                   COALESCE(NULLIF(u.name, ''), o."customerName") AS name,
                   o."restaurantReply" AS reply, o."restaurantRepliedAt" AS "repliedAt",
                   (SELECT i.name FROM food_order_items i WHERE i."orderId" = o.id ORDER BY i.price DESC LIMIT 1) AS "dishName",
                   (SELECT COALESCE(NULLIF(f.image, ''), i.image) FROM food_order_items i
                      LEFT JOIN food_items f ON f.id = i."itemId"
                     WHERE i."orderId" = o.id ORDER BY i.price DESC LIMIT 1) AS "dishImage"
            FROM food_orders o
            LEFT JOIN food_users u ON u.id = o."userId"
            WHERE o."restaurantId" = ${restaurant.id} AND o."restaurantRating" IS NOT NULL ${commentFilter} ${notHidden}
            ORDER BY COALESCE(o."restaurantRatedAt", o."deliveredAt", o."createdAt") DESC
            LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
        prisma.$queryRaw`
            SELECT o."restaurantRating" AS stars, COUNT(*)::int AS count,
                   COUNT(*) FILTER (WHERE o."restaurantRatingComment" <> '')::int AS "withComment"
            FROM food_orders o
            WHERE o."restaurantId" = ${restaurant.id} AND o."restaurantRating" IS NOT NULL ${notHidden}
            GROUP BY o."restaurantRating"`,
    ]);

    const breakdown = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
    let totalRatings = 0;
    let totalReviews = 0;
    let starSum = 0;
    for (const row of stats) {
        const stars = Math.min(5, Math.max(1, Math.round(Number(row.stars) || 0)));
        breakdown[stars] += row.count;
        totalRatings += row.count;
        totalReviews += row.withComment;
        starSum += stars * row.count;
    }
    const filteredTotal = withComments ? totalReviews : totalRatings;

    return {
        summary: {
            rating: totalRatings ? Math.round((starSum / totalRatings) * 10) / 10 : 0,
            totalRatings,
            totalReviews,
            breakdown,
        },
        reviews: rows.map((row) => ({
            id: row.id,
            userName: displayName(row.name),
            rating: Number(row.rating) || 0,
            comment: row.comment || '',
            ratedAt: row.ratedAt,
            dishName: row.dishName || null,
            dishImage: row.dishImage || null,
            /** The restaurant's reply, or null. */
            reply: row.reply ? { text: row.reply, repliedAt: row.repliedAt } : null,
        })),
        pagination: { page, limit, total: filteredTotal, pages: Math.ceil(filteredTotal / limit) },
    };
}

/** Whether restaurants may reply to reviews right now (Business Settings). */
export async function restaurantsCanReply() {
    return (await getBusinessSettings('business_vendor')).canReplyToReviews === true;
}

/** The restaurant's own reviews, for its app: the public list plus whether it may reply. */
export async function listOwnRestaurantReviews(restaurantId, query = {}) {
    const [data, canReply] = await Promise.all([getRestaurantReviews(restaurantId, query), restaurantsCanReply()]);
    return { ...data, canReply };
}

/**
 * Reply to (or edit the reply to) the review a customer left on one of this
 * restaurant's orders. An empty reply takes it down. Refused while the admin
 * has replies switched off.
 */
export async function replyToRestaurantReview(restaurantId, orderId, body = {}) {
    if (!isId(restaurantId)) throw new NotFoundError('Restaurant not found');
    if (!isId(orderId)) throw new NotFoundError('Review not found');
    if (!(await restaurantsCanReply())) throw new ForbiddenError('Replying to reviews is switched off by the admin');
    if (typeof body.reply !== 'string') throw new ValidationError('Write a reply');
    const reply = body.reply.trim();
    if (reply.length > MAX_REPLY) throw new ValidationError(`A reply can be at most ${MAX_REPLY} characters`);

    const order = await prisma.foodOrder.findFirst({
        where: { id: String(orderId), restaurantId: String(restaurantId), restaurantRating: { not: null } },
        select: { id: true },
    });
    if (!order) throw new NotFoundError('Review not found');
    const row = await prisma.foodOrder.update({
        where: { id: order.id },
        data: { restaurantReply: reply, restaurantRepliedAt: reply ? new Date() : null },
        select: { id: true, restaurantReply: true, restaurantRepliedAt: true },
    });
    return {
        id: row.id,
        reply: row.restaurantReply ? { text: row.restaurantReply, repliedAt: row.restaurantRepliedAt } : null,
    };
}
