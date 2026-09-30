import { Prisma } from '@prisma/client';
import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { NotFoundError } from '../../../../core/auth/errors.js';

/**
 * Customer reviews of one restaurant, for the customer app: the star rating a
 * customer gave the restaurant after an order, with their comment and the first
 * dish in that order. Only the reviewer's first name and last initial are
 * shown, never their phone.
 */

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

    const [rows, stats] = await Promise.all([
        prisma.$queryRaw`
            SELECT o.id, o."restaurantRating" AS rating, o."restaurantRatingComment" AS comment,
                   COALESCE(o."restaurantRatedAt", o."deliveredAt", o."createdAt") AS "ratedAt",
                   COALESCE(NULLIF(u.name, ''), o."customerName") AS name,
                   (SELECT i.name FROM food_order_items i WHERE i."orderId" = o.id ORDER BY i.price DESC LIMIT 1) AS "dishName",
                   (SELECT COALESCE(NULLIF(f.image, ''), i.image) FROM food_order_items i
                      LEFT JOIN food_items f ON f.id = i."itemId"
                     WHERE i."orderId" = o.id ORDER BY i.price DESC LIMIT 1) AS "dishImage"
            FROM food_orders o
            LEFT JOIN food_users u ON u.id = o."userId"
            WHERE o."restaurantId" = ${restaurant.id} AND o."restaurantRating" IS NOT NULL ${commentFilter}
            ORDER BY COALESCE(o."restaurantRatedAt", o."deliveredAt", o."createdAt") DESC
            LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
        prisma.$queryRaw`
            SELECT o."restaurantRating" AS stars, COUNT(*)::int AS count,
                   COUNT(*) FILTER (WHERE o."restaurantRatingComment" <> '')::int AS "withComment"
            FROM food_orders o
            WHERE o."restaurantId" = ${restaurant.id} AND o."restaurantRating" IS NOT NULL
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
        })),
        pagination: { page, limit, total: filteredTotal, pages: Math.ceil(filteredTotal / limit) },
    };
}
