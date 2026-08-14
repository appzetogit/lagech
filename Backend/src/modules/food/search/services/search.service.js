import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { toRestaurant } from '../../restaurant/restaurant.mapper.js';
import { restaurantIdsMatchingCuisine } from '../../shared/restaurantQuery.util.js';

/** Columns the search cards need, plus the address columns toRestaurant() rebuilds `location` from. */
const RESTAURANT_SEARCH_SELECT = {
    id: true, restaurantName: true, restaurantNameNormalized: true,
    cuisines: true, profileImage: true, coverImages: true,
    estimatedDeliveryTime: true, estimatedDeliveryTimeMinutes: true,
    offer: true, featuredDish: true, featuredPrice: true,
    rating: true, totalRatings: true, isAcceptingOrders: true,
    status: true, pureVegRestaurant: true, createdAt: true,
    zoneId: true, area: true, city: true,
    latitude: true, longitude: true, formattedAddress: true,
    addressLine1: true, addressLine2: true, state: true, pincode: true, landmark: true,
};

const FOOD_MATCH_SELECT = { id: true, restaurantId: true, name: true, image: true };

const toFiniteNumber = (value) => {
    if (value === undefined || value === null || value === '') return null;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
};

/** Great-circle distance in km, used only to rank an already-fetched page. */
const addDistanceScore = (restaurant, userLat, userLng) => {
    const restaurantLat = Number(restaurant?.latitude);
    const restaurantLng = Number(restaurant?.longitude);
    if (!Number.isFinite(restaurantLat) || !Number.isFinite(restaurantLng)) {
        return { ...restaurant, distanceScore: 999 };
    }

    const dLat = ((restaurantLat - userLat) * Math.PI) / 180;
    const dLon = ((restaurantLng - userLng) * Math.PI) / 180;
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos((userLat * Math.PI) / 180) *
            Math.cos((restaurantLat * Math.PI) / 180) *
            Math.sin(dLon / 2) *
            Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return { ...restaurant, distanceScore: 6371 * c };
};

/**
 * Unified search: matches restaurants by name or cuisine, and also matches
 * dishes, surfacing the restaurant that serves them.
 */
export const searchUnified = async (query = {}, options = {}) => {
    const {
        q, lat, lng, categoryId, minRating, maxDeliveryTime,
        isVeg, page = 1, limit = 20, zoneId, strictZone,
    } = query;

    const pageNumber = Math.max(parseInt(page, 10) || 1, 1);
    const limitNumber = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 50);
    const skip = (pageNumber - 1) * limitNumber;
    const term = String(q || '').trim();
    const userLat = toFiniteNumber(lat);
    const userLng = toFiniteNumber(lng);
    const hasGeoSorting = userLat !== null && userLng !== null;
    const fetchLimit = Math.min(limitNumber * 3, 120);

    const zoneFiltered = isId(zoneId);
    const categoryFiltered = isId(categoryId);

    // 1. Base filter
    const where = { status: 'approved' };
    if (zoneFiltered) where.zoneId = String(zoneId);
    if (isVeg === 'true') where.pureVegRestaurant = true;
    if (minRating) where.rating = { gte: parseFloat(minRating) };
    if (maxDeliveryTime) {
        where.estimatedDeliveryTimeMinutes = { lte: parseInt(maxDeliveryTime, 10) };
    }

    // 2. Category filter — restaurants have no category, their dishes do.
    if (categoryFiltered) {
        const catFoodItems = await prisma.foodItem.findMany({
            where: { categoryId: String(categoryId), approvalStatus: 'approved' },
            select: { restaurantId: true },
            distinct: ['restaurantId'],
            take: fetchLimit * 4,
        });

        if (!catFoodItems.length) {
            return {
                success: true,
                data: { restaurants: [], total: 0, page: pageNumber, limit: limitNumber },
            };
        }
        where.id = { in: catFoodItems.map((food) => food.restaurantId) };
    }

    // Kept separately: the dish-match branch below needs to intersect with it
    // rather than replace it.
    const categoryRestaurantIds = categoryFiltered ? new Set(where.id.in) : null;

    const found = new Map();

    // 3. Matching
    if (term) {
        const cuisineIds = await restaurantIdsMatchingCuisine(term, fetchLimit);

        const matchedRestaurants = await prisma.foodRestaurant.findMany({
            where: {
                ...where,
                OR: [
                    { restaurantName: { contains: term, mode: 'insensitive' } },
                    ...(cuisineIds.length ? [{ id: { in: cuisineIds } }] : []),
                ],
            },
            select: RESTAURANT_SEARCH_SELECT,
            orderBy: [{ rating: 'desc' }, { createdAt: 'desc' }],
            take: fetchLimit,
        });

        for (const restaurant of matchedRestaurants) {
            found.set(restaurant.id, { ...restaurant, matchType: 'restaurant' });
        }

        const matchedFoods = await prisma.foodItem.findMany({
            where: {
                approvalStatus: 'approved',
                name: { contains: term, mode: 'insensitive' },
                ...(isVeg === 'true' ? { foodType: 'Veg' } : {}),
            },
            select: FOOD_MATCH_SELECT,
            orderBy: { createdAt: 'desc' },
            take: fetchLimit,
        });

        // One dish per restaurant — the first (newest) is the one shown.
        const foodByRestaurant = new Map();
        for (const food of matchedFoods) {
            const restaurantId = String(food.restaurantId || '');
            if (restaurantId && !foodByRestaurant.has(restaurantId)) {
                foodByRestaurant.set(restaurantId, food);
            }
        }

        const remainingIds = [...foodByRestaurant.keys()].filter(
            (id) =>
                !found.has(id) &&
                // Overwriting where.id here would have let a dish match pull in a
                // restaurant the category filter had already excluded, which is
                // what the Mongo version did.
                (!categoryRestaurantIds || categoryRestaurantIds.has(id)),
        );
        if (remainingIds.length) {
            const rsForFoods = await prisma.foodRestaurant.findMany({
                where: { ...where, id: { in: remainingIds } },
                select: RESTAURANT_SEARCH_SELECT,
                take: fetchLimit,
            });

            for (const restaurant of rsForFoods) {
                const matchedFood = foodByRestaurant.get(restaurant.id);
                found.set(restaurant.id, {
                    ...restaurant,
                    matchType: 'food',
                    matchedDish: matchedFood?.name,
                    matchedDishImage: matchedFood?.image,
                    matchedDishId: matchedFood?.id,
                });
            }
        }
    } else {
        const allMatching = await prisma.foodRestaurant.findMany({
            where,
            select: RESTAURANT_SEARCH_SELECT,
            orderBy: [{ rating: 'desc' }, { createdAt: 'desc' }],
            take: fetchLimit,
        });
        for (const restaurant of allMatching) found.set(restaurant.id, restaurant);
    }

    let results = [...found.values()];

    if (hasGeoSorting && results.length) {
        results = results
            .map((restaurant) => addDistanceScore(restaurant, userLat, userLng))
            .sort((a, b) => (a.distanceScore || 999) - (b.distanceScore || 999));
    }

    const finalResult = {
        success: true,
        data: {
            // toRestaurant rebuilds the nested `location` the cards read.
            restaurants: results.slice(skip, skip + limitNumber).map(toRestaurant),
            total: results.length,
            page: pageNumber,
            limit: limitNumber,
            zoneFiltered,
        },
    };

    // Nothing in this zone: widen once rather than showing an empty screen.
    const shouldSkipZoneFallback =
        strictZone === true || strictZone === 'true' || categoryFiltered;

    if (!shouldSkipZoneFallback && !results.length && zoneFiltered) {
        const fallbackResults = await searchUnified({ ...query, zoneId: null }, options);
        if (fallbackResults.data.total > 0) {
            fallbackResults.data.wasFallback = true;
            return fallbackResults;
        }
    }

    return finalResult;
};

/**
 * Admin-owned (global) categories — those with no restaurant attached.
 */
export const getAdminCategories = async (query = {}) => {
    const where = {
        isActive: true,
        isApproved: true,
        restaurantId: null,
    };

    // A zone filter must NARROW the global set. The Mongo version assigned to
    // filter.$or, which overwrote the "global only" clause it already held, so
    // asking for one zone's categories also let in every restaurant's private
    // ones.
    if (isId(query.zoneId)) {
        where.OR = [{ zoneId: String(query.zoneId) }, { zoneId: null }];
    }

    return prisma.foodCategory.findMany({
        where,
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
};
