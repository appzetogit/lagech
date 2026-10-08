import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { NotFoundError, ValidationError } from '../../../../core/auth/errors.js';
import { displayName } from '../../restaurant/services/restaurantReviews.service.js';

/**
 * Dish reviews for the admin (the old panel's Food Setup -> Review): every
 * per-dish rating a customer left after an order, with the restaurant and the
 * order it came from. The customer is shown as first name and last initial,
 * the same as the customer app shows them.
 *
 * An admin can hide an abusive review. Hiding keeps the row (the customer's
 * own order history still shows what they wrote) but takes it out of every
 * public listing.
 */

const MAX_LIMIT = 100;

const dayStart = (raw) => {
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d;
};

/** Filters from the query string -> a Prisma where for OrderItemRating. */
export function buildFoodReviewWhere(query = {}) {
    const where = {};
    const order = {};
    if (isId(query.restaurantId)) order.restaurantId = String(query.restaurantId);
    if (Object.keys(order).length) where.order = order;

    const rating = Number.parseInt(query.rating, 10);
    if (rating >= 1 && rating <= 5) where.rating = rating;

    const search = String(query.search || '').trim().slice(0, 80);
    if (search) where.name = { contains: search, mode: 'insensitive' };

    if (query.visibility === 'hidden') where.isHidden = true;
    else if (query.visibility === 'visible') where.isHidden = false;

    if (query.withComments === 'true') where.comment = { not: '' };

    const from = query.from ? dayStart(query.from) : null;
    const to = query.to ? dayStart(query.to) : null;
    if (from || to) {
        where.ratedAt = {};
        if (from) where.ratedAt.gte = from;
        if (to) {
            to.setHours(23, 59, 59, 999);
            where.ratedAt.lte = to;
        }
    }
    return where;
}

const serialize = (row, imageByItem) => ({
    id: row.id,
    itemId: row.itemId,
    dishName: row.name || 'Dish',
    dishImage: imageByItem.get(row.itemId) || '',
    rating: row.rating,
    comment: row.comment || '',
    ratedAt: row.ratedAt,
    isHidden: row.isHidden,
    hiddenAt: row.hiddenAt,
    customerName: displayName(row.order?.user?.name || row.order?.customerName),
    orderId: row.orderId,
    orderNumber: row.order?.order_id || row.order?.orderId || '',
    restaurantId: row.order?.restaurantId || '',
    restaurantName: row.order?.restaurant?.restaurantName || '',
    /** The restaurant's reply to the review on that order (the old panel's "Store reply"). */
    storeReply: row.order?.restaurantReply || '',
    storeRepliedAt: row.order?.restaurantRepliedAt || null,
});

export async function listFoodReviews(query = {}) {
    const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
    const limit = Math.min(MAX_LIMIT, Math.max(1, Number.parseInt(query.limit, 10) || 25));
    const where = buildFoodReviewWhere(query);

    const [rows, total, hidden, average] = await Promise.all([
        prisma.orderItemRating.findMany({
            where,
            orderBy: [{ ratedAt: 'desc' }, { id: 'desc' }],
            skip: (page - 1) * limit,
            take: limit,
            include: {
                order: {
                    select: {
                        order_id: true,
                        orderId: true,
                        restaurantId: true,
                        customerName: true,
                        restaurantReply: true,
                        restaurantRepliedAt: true,
                        user: { select: { name: true } },
                        restaurant: { select: { restaurantName: true } },
                    },
                },
            },
        }),
        prisma.orderItemRating.count({ where }),
        prisma.orderItemRating.count({ where: { ...where, isHidden: true } }),
        prisma.orderItemRating.aggregate({ where, _avg: { rating: true } }),
    ]);

    // The dish's current photo; the rating row only kept its name.
    const itemIds = [...new Set(rows.map((r) => r.itemId).filter(isId))];
    const items = itemIds.length
        ? await prisma.foodItem.findMany({ where: { id: { in: itemIds } }, select: { id: true, image: true } })
        : [];
    const imageByItem = new Map(items.map((i) => [i.id, i.image]));

    return {
        reviews: rows.map((row) => serialize(row, imageByItem)),
        summary: {
            total,
            hidden,
            averageRating: average._avg.rating ? Math.round(average._avg.rating * 10) / 10 : 0,
        },
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
}

/** Hide or show one dish review. */
export async function setFoodReviewHidden(id, hidden) {
    if (!isId(id)) throw new ValidationError('Invalid review');
    if (typeof hidden !== 'boolean') throw new ValidationError('Say whether to hide or show the review');
    const { count } = await prisma.orderItemRating.updateMany({
        where: { id: String(id) },
        data: { isHidden: hidden, hiddenAt: hidden ? new Date() : null },
    });
    if (!count) throw new NotFoundError('Review not found');
    return { id: String(id), isHidden: hidden };
}
