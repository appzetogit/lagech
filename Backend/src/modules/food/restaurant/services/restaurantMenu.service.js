import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { ValidationError } from '../../../../core/auth/errors.js';
import {
    getFoodDisplayOtherPrice,
    getFoodDisplayPrice,
    serializeFoodVariants,
} from '../../admin/services/foodVariant.service.js';
import { restoreExpiredFoodAvailability } from './foodAvailability.service.js';
import { findApprovedRestaurant } from './restaurantLookup.helper.js';

const buildMenuFromFoods = async (foods = []) => {
    const categoryIds = [
        ...new Set((foods || []).map((f) => (f?.categoryId ? String(f.categoryId) : '')).filter(isId)),
    ];

    const categoryDocs = categoryIds.length
        ? await prisma.foodCategory.findMany({
            where: { id: { in: categoryIds } },
            select: { id: true, name: true, image: true, sortOrder: true },
        })
        : [];
    const categoryMap = new Map(categoryDocs.map((doc) => [doc.id, doc]));

    const byCategory = new Map();
    for (const food of foods) {
        const categoryId = food?.categoryId ? String(food.categoryId) : '';
        const categoryDoc = categoryMap.get(categoryId) || null;
        const sectionName =
            (categoryDoc?.name || food?.categoryName || 'Menu').trim() || 'Menu';
        const groupKey = categoryId || `name:${sectionName.toLowerCase()}`;

        if (!byCategory.has(groupKey)) {
            byCategory.set(groupKey, {
                id: categoryId || null,
                name: sectionName,
                image: categoryDoc?.image || '',
                sortOrder: Number.isFinite(Number(categoryDoc?.sortOrder))
                    ? Number(categoryDoc.sortOrder)
                    : Number.MAX_SAFE_INTEGER,
                items: [],
            });
        }

        byCategory.get(groupKey).items.push({
            id: food.id,
            _id: food.id,
            categoryId: categoryId || null,
            categoryName: sectionName,
            category: sectionName,
            name: food.name,
            description: food.description || '',
            price: getFoodDisplayPrice(food),
            otherPrice: getFoodDisplayOtherPrice(food),
            variants: serializeFoodVariants(food.variants),
            variations: serializeFoodVariants(food.variants),
            image: food.image || '',
            // Same fallback as the public feed: existing dishes have no gallery, so
            // return their single image as a one-entry list rather than an empty one
            // the detail screen would have to work around.
            images: Array.isArray(food.images) && food.images.length
                ? food.images
                : food.image ? [food.image] : [],
            foodType: food.foodType || 'Non-Veg',
            isAvailable: food.isAvailable !== false,
            approvalStatus: food.approvalStatus || 'approved',
            rejectionReason: food.rejectionReason || '',
            requestedAt: food.requestedAt,
            approvedAt: food.approvedAt,
            rejectedAt: food.rejectedAt,
            preparationTime: food.preparationTime || '',
            createdAt: food.createdAt,
            updatedAt: food.updatedAt,
        });
    }

    const orderedGroups = [...byCategory.values()].sort((a, b) => {
        if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
        return String(a.name || '').localeCompare(String(b.name || ''));
    });

    const sections = orderedGroups.map((group, idx) => ({
        id: group.id || `section-${idx}`,
        categoryId: group.id || null,
        name: group.name,
        image: group.image || '',
        sortOrder: Number.isFinite(Number(group.sortOrder)) ? Number(group.sortOrder) : 0,
        itemCount: group.items.length,
        items: group.items.sort((a, b) => {
            const at = new Date(a.createdAt || a.requestedAt || 0).getTime();
            const bt = new Date(b.createdAt || b.requestedAt || 0).getTime();
            return bt - at;
        }),
        subsections: [],
    }));

    const categories = sections.map((section) => ({
        id: section.categoryId || section.id,
        categoryId: section.categoryId || null,
        name: section.name,
        image: section.image || '',
        sortOrder: section.sortOrder || 0,
        itemCount: section.itemCount || 0,
    }));

    return { sections, categories };
};

export async function getRestaurantMenu(restaurantId) {
    if (!isId(restaurantId)) throw new ValidationError('Invalid restaurant id');
    const id = String(restaurantId);

    await restoreExpiredFoodAvailability({ restaurantId: id });
    const foods = await prisma.foodItem.findMany({
        where: { restaurantId: id },
        include: { variants: { orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] } },
        orderBy: { createdAt: 'desc' },
        take: 5000,
    });
    return buildMenuFromFoods(foods);
}

export async function updateRestaurantMenu() {
    // Option A: single source of truth (food_items). Menu layout snapshots are
    // disabled. The endpoint is kept for backward compatibility, but explicit.
    throw new ValidationError('Menu editing is disabled. Menu is generated from food items.');
}

export async function getPublicApprovedRestaurantMenu(restaurantIdOrSlug) {
    if (!String(restaurantIdOrSlug || '').trim()) {
        throw new ValidationError('Restaurant id is required');
    }

    const restaurant = await findApprovedRestaurant(restaurantIdOrSlug);
    if (!restaurant?.id) return null;

    await restoreExpiredFoodAvailability({ restaurantId: restaurant.id });
    const foods = await prisma.foodItem.findMany({
        where: { restaurantId: restaurant.id, approvalStatus: 'approved' },
        include: { variants: { orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] } },
        orderBy: { createdAt: 'desc' },
        take: 2000,
    });
    return buildMenuFromFoods(foods);
}

export async function syncMenuItemApprovalStatus() {
    // No-op in Option A (menu snapshots removed). Approval status lives only in
    // food_items. Kept so admin approval flows that call it do not break.
}
