import { getPrioritySort } from '../../shared/businessSettings.js';
import { prisma } from '../../../../config/prisma.js';
import { resolveListingZone } from '../../shared/zone.service.js';
import { isId } from '../../../../utils/helpers.js';
import {
    getFoodDisplayOtherPrice,
    getFoodDisplayPrice,
    serializeFoodVariants,
} from '../../admin/services/foodVariant.service.js';
import { restoreExpiredFoodAvailability } from './foodAvailability.service.js';
import { serializeNutrition } from '../../shared/nutrition.util.js';

const buildCategoryKeywords = (categorySlug) => {
    const raw = String(categorySlug || '').trim().toLowerCase();
    if (!raw || raw === 'all') return [];

    const normalized = raw.replace(/&/g, ' and ').replace(/-/g, ' ').trim();
    const words = normalized.split(/\s+/).filter(Boolean);
    return [...new Set([raw, normalized, ...words])];
};

/** The price each promo slug stands for: "₹99 store" means ₹99 or less. */
const PROMO_MAX_PRICE = { switch99: 99, under99: 99, 'under-99': 99, under250: 250, 'under-250': 250 };

/**
 * The most a dish may cost for this request: an explicit `maxPrice`, else the
 * cap a promo slug stands for, else none.
 *
 * The promo used to test String(price).includes('99'), so the "₹99 store" held
 * ₹199 and ₹999 dishes and left out every ₹50 one.
 */
export function priceCapFor(query = {}) {
    const raw = query.maxPrice;
    const explicit = Number(raw);
    if (raw != null && raw !== '' && Number.isFinite(explicit) && explicit > 0) return explicit;
    const promo = String(query.promo || query.promoSlug || '').trim().toLowerCase();
    return PROMO_MAX_PRICE[promo] ?? null;
}

export async function listPublicFoods(query = {}) {
    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 500, 1), 1000);
    const listingZone = await resolveListingZone(query);
    if (listingZone.outOfService) return { foods: [], total: 0, outOfService: true };
    const categorySlug = String(query.categorySlug || query.category || '').trim().toLowerCase();
    const priceCap = priceCapFor(query);

    const restaurants = await prisma.foodRestaurant.findMany({
        where: {
            status: 'approved',
            ...(listingZone.zoneId ? { zoneId: listingZone.zoneId } : {}),
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

    if (isId(query.categoryId)) where.categoryId = String(query.categoryId);

    const keywords = buildCategoryKeywords(categorySlug);
    if (keywords.length > 0) {
        // Substring match on either the dish name or its category label. The Mongo
        // version escaped these into regexes; `contains` needs no escaping.
        where.OR = keywords.flatMap((keyword) => [
            { name: { contains: keyword, mode: 'insensitive' } },
            { categoryName: { contains: keyword, mode: 'insensitive' } },
        ]);
    }

    // Business Settings > Priority setup, "category item lists": applies when
    // a category is asked for. Newest first otherwise, as always.
    const isCategoryList = isId(query.categoryId) || keywords.length > 0;
    const prioritySort = isCategoryList ? await getPrioritySort('categoryItems') : null;
    const orderBy = {
        price_low: [{ price: 'asc' }, { createdAt: 'desc' }],
        price_high: [{ price: 'desc' }, { createdAt: 'desc' }],
    }[prioritySort] || { createdAt: 'desc' };

    const list = await prisma.foodItem.findMany({
        where,
        // variants is a relation now, so it has to be asked for — an omitted
        // include silently returns dishes that look like they have no sizes.
        include: { variants: { orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] } },
        orderBy,
        // With a price cap the cheap dishes can be anywhere in the catalog, so
        // read it all and cap after pricing; taking the newest N first dropped
        // every older cheap dish.
        ...(priceCap === null ? { take: limit } : {}),
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
                ...serializeNutrition(food),
                approvalStatus: food.approvalStatus || 'approved',
            };
        })
        .filter((food) => {
            if (food.isAvailable === false) return false;
            if (priceCap !== null) return Number(food.price) <= priceCap;
            return true;
        })
        .slice(0, limit);

    return { foods, total: foods.length };
}
