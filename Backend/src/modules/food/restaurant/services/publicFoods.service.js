import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import {
    getFoodDisplayOtherPrice,
    getFoodDisplayPrice,
    serializeFoodVariants,
} from '../../admin/services/foodVariant.service.js';
import { restoreExpiredFoodAvailability } from './foodAvailability.service.js';

const buildCategoryKeywords = (categorySlug) => {
    const raw = String(categorySlug || '').trim().toLowerCase();
    if (!raw || raw === 'all') return [];

    const normalized = raw.replace(/&/g, ' and ').replace(/-/g, ' ').trim();
    const words = normalized.split(/\s+/).filter(Boolean);
    return [...new Set([raw, normalized, ...words])];
};

const isSwitch99Price = (price) => String(price ?? '').includes('99');

export async function listPublicFoods(query = {}) {
    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 500, 1), 1000);
    const zoneIdRaw = String(query.zoneId || '').trim();
    const categorySlug = String(query.categorySlug || query.category || '').trim().toLowerCase();
    const promo = String(query.promo || query.promoSlug || '').trim().toLowerCase();
    const isSwitch99Promo = promo === 'switch99' || promo === 'under-250' || promo === 'under250';

    const restaurants = await prisma.foodRestaurant.findMany({
        where: {
            status: 'approved',
            ...(isId(zoneIdRaw) ? { zoneId: zoneIdRaw } : {}),
        },
        select: {
            id: true, restaurantName: true, zoneId: true, profileImage: true,
            rating: true, totalRatings: true,
            estimatedDeliveryTime: true, estimatedDeliveryTimeMinutes: true,
            latitude: true, longitude: true,
            coverImages: true, menuImages: true,
            isAcceptingOrders: true, openDays: true, openingTime: true, closingTime: true,
        },
    });

    if (!restaurants.length) return { foods: [], total: 0 };

    const restaurantMap = new Map(restaurants.map((r) => [r.id, r]));
    const restaurantIds = restaurants.map((r) => r.id);

    await restoreExpiredFoodAvailability({ restaurantId: { in: restaurantIds } });

    const where = {
        restaurantId: { in: restaurantIds },
        approvalStatus: 'approved',
        isAvailable: true,
    };

    const keywords = buildCategoryKeywords(categorySlug);
    if (keywords.length > 0) {
        // Substring match on either the dish name or its category label. The Mongo
        // version escaped these into regexes; `contains` needs no escaping.
        where.OR = keywords.flatMap((keyword) => [
            { name: { contains: keyword, mode: 'insensitive' } },
            { categoryName: { contains: keyword, mode: 'insensitive' } },
        ]);
    }

    const list = await prisma.foodItem.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: isSwitch99Promo ? Math.max(limit, 2000) : limit,
    });

    const foods = list
        .map((food) => {
            const restaurant = restaurantMap.get(food.restaurantId);
            const price = getFoodDisplayPrice(food);
            return {
                id: food.id,
                _id: food.id,
                restaurantId: food.restaurantId,
                restaurantName: restaurant?.restaurantName || 'Unknown Restaurant',
                categoryId: food.categoryId || null,
                categoryName: food.categoryName || '',
                category: food.categoryName || '',
                name: food.name,
                description: food.description || '',
                price,
                otherPrice: getFoodDisplayOtherPrice(food),
                // Both keys, exactly as the restaurant-menu payload sends them.
                //
                // These were missing entirely, so a dish with sizes arrived looking
                // like a plain one: the app added it to the cart with no variant and
                // had nothing to render a size picker from, while checkout — which
                // reads the dish from the database — refused with "please select a
                // size". The customer was left with an error and no control that
                // could clear it.
                variants: serializeFoodVariants(food.variants),
                variations: serializeFoodVariants(food.variants),
                image: food.image || '',
                // Falls back to the single image so a dish saved before galleries
                // existed still returns a one-entry list.
                images: Array.isArray(food.images) && food.images.length
                    ? food.images
                    : food.image ? [food.image] : [],
                foodType: food.foodType || 'Non-Veg',
                isAvailable: food.isAvailable !== false,
                preparationTime: food.preparationTime || '',
                approvalStatus: food.approvalStatus || 'approved',
            };
        })
        .filter((food) => {
            if (food.isAvailable === false) return false;
            if (isSwitch99Promo) return isSwitch99Price(food.price);
            return true;
        })
        .slice(0, limit);

    return { foods, total: foods.length };
}
