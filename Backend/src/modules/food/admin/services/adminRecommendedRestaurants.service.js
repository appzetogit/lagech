import { prisma } from '../../../../config/prisma.js';
import { ValidationError } from '../../../../core/auth/errors.js';

/**
 * Recommended restaurants: the admin's hand-picked list for the customer
 * app's "Recommended" row, in the admin's order. Saved whole -- the list the
 * admin sees is exactly what gets stored, so a reorder and a removal are the
 * same single save.
 */

export const MAX_RECOMMENDED = 50;

const CARD = {
    id: true,
    restaurantName: true,
    profileImage: true,
    area: true,
    city: true,
    rating: true,
    totalRatings: true,
    status: true,
    isAcceptingOrders: true,
    recommendedSortOrder: true,
    zone: { select: { name: true, zoneName: true } },
};

const toCard = (r) => ({
    id: r.id,
    name: r.restaurantName,
    logo: r.profileImage || '',
    area: r.area || r.city || '',
    zoneName: r.zone?.name || r.zone?.zoneName || '',
    rating: Number(r.rating) || 0,
    totalRatings: r.totalRatings,
    status: r.status,
    isAcceptingOrders: r.isAcceptingOrders,
    sortOrder: r.recommendedSortOrder,
});

export async function listRecommendedRestaurants() {
    const rows = await prisma.foodRestaurant.findMany({
        where: { isRecommended: true },
        orderBy: [{ recommendedSortOrder: 'asc' }, { restaurantName: 'asc' }],
        select: CARD,
    });
    return { restaurants: rows.map(toCard) };
}

/** Replace the list with these restaurant ids, in this order. */
export async function saveRecommendedRestaurants(restaurantIds) {
    const ids = [...new Set(restaurantIds)];
    if (ids.length > MAX_RECOMMENDED) throw new ValidationError(`At most ${MAX_RECOMMENDED} recommended restaurants`);
    const found = await prisma.foodRestaurant.findMany({ where: { id: { in: ids } }, select: { id: true, status: true } });
    if (found.length !== ids.length) throw new ValidationError('One or more restaurants no longer exist');
    if (found.some((r) => r.status !== 'approved')) throw new ValidationError('Only approved restaurants can be recommended');

    await prisma.$transaction([
        prisma.foodRestaurant.updateMany({
            where: { isRecommended: true, id: { notIn: ids } },
            data: { isRecommended: false, recommendedSortOrder: 0 },
        }),
        ...ids.map((id, index) =>
            prisma.foodRestaurant.update({ where: { id }, data: { isRecommended: true, recommendedSortOrder: index } })
        ),
    ]);

    try {
        const { invalidateCache } = await import('../../../../middleware/cache.js');
        await Promise.all([invalidateCache('restaurants:*'), invalidateCache('restaurant_detail:*')]);
    } catch {
        // The cached lists expire on their own.
    }
    return listRecommendedRestaurants();
}
