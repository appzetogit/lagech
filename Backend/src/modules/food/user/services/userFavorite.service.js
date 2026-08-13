import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { ValidationError } from '../../../../core/auth/errors.js';

const requireId = (value, label) => {
    const raw = String(value || '').trim();
    if (!isId(raw)) throw new ValidationError(`Invalid ${label}`);
    return raw;
};

/**
 * Everything this user has favourited.
 *
 * Returns the ids AND the entities in one call. The ids are what every heart
 * icon binds to, so they must be present even when the underlying restaurant or
 * dish has since been deleted or unapproved — otherwise a heart would silently
 * un-fill and the user would think their tap was lost. The entity lists are what
 * the Favourites screen renders, and those legitimately omit anything no longer
 * orderable.
 */
export const getUserFavorites = async (userId) => {
    const owner = requireId(userId, 'user id');

    const rows = await prisma.foodUserFavorite.findMany({
        where: { userId: owner },
        select: { entityType: true, entityId: true },
        orderBy: { createdAt: 'desc' },
    });

    const restaurantIds = rows.filter((r) => r.entityType === 'restaurant').map((r) => r.entityId);
    const foodIds = rows.filter((r) => r.entityType === 'food').map((r) => r.entityId);

    const [restaurants, foods] = await Promise.all([
        restaurantIds.length
            ? prisma.foodRestaurant.findMany({
                where: { id: { in: restaurantIds }, status: 'approved' },
                select: {
                    id: true, restaurantName: true, profileImage: true, coverImage: true,
                    coverImages: true, cuisines: true, rating: true, totalRatings: true,
                    area: true, city: true, latitude: true, longitude: true, offer: true,
                    estimatedDeliveryTimeMinutes: true, isAcceptingOrders: true,
                },
            })
            : [],
        foodIds.length
            ? prisma.foodItem.findMany({
                where: { id: { in: foodIds }, approvalStatus: 'approved' },
                select: {
                    id: true, name: true, description: true, price: true, otherPrice: true,
                    image: true, images: true, foodType: true, restaurantId: true,
                    rating: true, totalRatings: true, isAvailable: true,
                    // A relation now, so it has to be asked for — the favourites
                    // screen renders a size picker from it.
                    variants: { orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] },
                },
            })
            : [],
    ]);

    // Preserve the newest-first order the ids came back in; `in` does not guarantee it.
    const byId = (list) => new Map(list.map((d) => [d.id, d]));
    const restaurantMap = byId(restaurants);
    const foodMap = byId(foods);

    return {
        restaurantIds,
        foodIds,
        restaurants: restaurantIds.map((id) => restaurantMap.get(id)).filter(Boolean),
        foods: foodIds.map((id) => foodMap.get(id)).filter(Boolean),
    };
};

/**
 * Adds a favourite, or succeeds silently if it is already there.
 *
 * Idempotent on purpose: a double-tapped heart sends two adds, and the second
 * colliding on the unique constraint means "already favourited", not an error.
 * Treating it as success keeps the client's optimistic state correct without
 * needing a debounce to stay safe.
 */
const addFavorite = async (userId, entityType, entityId) => {
    const owner = requireId(userId, 'user id');
    const target = requireId(entityId, `${entityType} id`);

    try {
        await prisma.foodUserFavorite.create({ data: { userId: owner, entityType, entityId: target } });
    } catch (err) {
        // P2002 is the unique constraint doing its job.
        if (err?.code !== 'P2002') throw err;
    }
    return { favorited: true, entityType, entityId: target };
};

/** Removing something that was never favourited is also success — same reasoning. */
const removeFavorite = async (userId, entityType, entityId) => {
    const owner = requireId(userId, 'user id');
    const target = requireId(entityId, `${entityType} id`);

    await prisma.foodUserFavorite.deleteMany({
        where: { userId: owner, entityType, entityId: target },
    });
    return { favorited: false, entityType, entityId: target };
};

export const addFavoriteRestaurant = (userId, restaurantId) =>
    addFavorite(userId, 'restaurant', restaurantId);

export const removeFavoriteRestaurant = (userId, restaurantId) =>
    removeFavorite(userId, 'restaurant', restaurantId);

export const addFavoriteFood = (userId, foodId) => addFavorite(userId, 'food', foodId);

export const removeFavoriteFood = (userId, foodId) => removeFavorite(userId, 'food', foodId);
