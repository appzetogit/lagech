import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { ValidationError } from '../../../../core/auth/errors.js';
import { normalizeFoodImages } from './foodImages.util.js';
import {
    extractRawFoodVariants,
    getFoodDisplayOtherPrice,
    getFoodDisplayPrice,
    hasFoodVariants,
    normalizeFoodVariantsInput,
    serializeFoodVariants,
    syncFoodVariants,
} from './foodVariant.service.js';
import { categoryAllowsFoodType } from '../../shared/categoryWorkflow.js';

/**
 * Admin-side dish management, extracted from admin.service.js.
 *
 * An admin can file a dish under any category — unlike the restaurant path,
 * which is limited to global categories plus its own — and what an admin
 * creates is approved on the spot.
 */

const WITH_VARIANTS = { variants: { orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] } };

/** FoodType's Prisma name for 'Non-Veg' is NonVeg; the hyphen is a @map. */
const toFoodTypeColumn = (v) => (String(v || '').trim() === 'Veg' ? 'Veg' : 'NonVeg');
const fromFoodTypeColumn = (v) => (String(v || '') === 'Veg' ? 'Veg' : 'Non-Veg');

const serializeFood = (f, restaurantName) => ({
    id: f.id,
    _id: f.id,
    restaurantId: f.restaurantId,
    restaurantName: restaurantName || f.restaurant?.restaurantName || 'Unknown Restaurant',
    categoryId: f.categoryId || null,
    categoryName: f.categoryName || '',
    name: f.name,
    description: f.description || '',
    price: getFoodDisplayPrice(f),
    otherPrice: getFoodDisplayOtherPrice(f),
    variants: serializeFoodVariants(f.variants),
    variations: serializeFoodVariants(f.variants),
    image: f.image || '',
    // Falls back to the single image so a dish saved before galleries existed
    // still returns a one-entry list, rather than the panel having to special
    // case "no images but there is an image".
    images: Array.isArray(f.images) && f.images.length ? f.images : f.image ? [f.image] : [],
    foodType: fromFoodTypeColumn(f.foodType),
    isAvailable: f.isAvailable !== false,
    preparationTime: f.preparationTime || '',
    approvalStatus: f.approvalStatus || 'approved',
    createdAt: f.createdAt,
    updatedAt: f.updatedAt,
});

const dropMenuCache = async (restaurantId) => {
    if (!restaurantId) return;
    try {
        const { invalidateCache } = await import('../../../../middleware/cache.js');
        await invalidateCache(`restaurant_menu:${restaurantId}`);
    } catch (cacheErr) {
        console.error('Failed to invalidate menu cache:', cacheErr);
    }
};

export async function getFoods(query = {}) {
    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 100, 1), 1000);
    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    const skip = (page - 1) * limit;

    const where = {};
    if (isId(query.restaurantId)) where.restaurantId = String(query.restaurantId);

    if (query.search && String(query.search).trim()) {
        const contains = { contains: String(query.search).trim(), mode: 'insensitive' };
        where.OR = [{ name: contains }, { categoryName: contains }];
    }

    if (['pending', 'approved', 'rejected'].includes(String(query.approvalStatus))) {
        where.approvalStatus = String(query.approvalStatus);
    }

    const [list, total] = await Promise.all([
        prisma.foodItem.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            skip,
            take: limit,
            include: {
                ...WITH_VARIANTS,
                // The restaurant name came from a second query and a Map; it is
                // a foreign key, so it is an include.
                restaurant: { select: { restaurantName: true } },
            },
        }),
        prisma.foodItem.count({ where }),
    ]);

    return { foods: list.map((f) => serializeFood(f)), total, page, limit };
}

/**
 * Resolve the category a dish is being filed under.
 *
 * An admin may use any category, but the diet rules still apply: a Veg-only
 * category cannot take a non-veg dish, and a pure-veg restaurant cannot use a
 * non-veg category at all.
 */
const resolveAdminFoodCategory = async ({ categoryId, categoryName, foodType, pureVegRestaurant }) => {
    let resolvedId = null;
    let resolvedName = typeof categoryName === 'string' ? categoryName.trim() : '';
    let category = null;

    if (categoryId) {
        if (!isId(categoryId)) throw new ValidationError('Invalid category id');
        category = await prisma.foodCategory.findUnique({
            where: { id: String(categoryId) },
            select: { id: true, name: true, foodTypeScope: true },
        });
        if (!category) throw new ValidationError('Category not found');
        resolvedId = category.id;
        resolvedName = category.name || resolvedName;
    }

    if (!resolvedName) throw new ValidationError('Category is required');

    if (category?.foodTypeScope) {
        if (pureVegRestaurant && category.foodTypeScope !== 'Veg') {
            throw new ValidationError('Pure veg restaurants can only use veg categories');
        }
        if (!categoryAllowsFoodType(category.foodTypeScope, foodType)) {
            throw new ValidationError(
                `This ${category.foodTypeScope} category cannot accept ${foodType} food`
            );
        }
    }

    return { categoryId: resolvedId, categoryName: resolvedName };
};

const getAdminFoodCreatePricing = (body = {}) => {
    const variants = normalizeFoodVariantsInput(extractRawFoodVariants(body));
    if (variants.length > 0) {
        return {
            price: getFoodDisplayPrice({ variants }),
            otherPrice: getFoodDisplayOtherPrice({ variants }),
            variants,
        };
    }

    const price = Number(body.price);
    if (!Number.isFinite(price) || price <= 0) throw new ValidationError('Price must be greater than 0');
    const otherPrice = Number(body.otherPrice);
    return {
        price,
        otherPrice: Number.isFinite(otherPrice) && otherPrice > 0 ? otherPrice : 0,
        variants: [],
    };
};

const getAdminFoodUpdatedPricing = (existing = {}, body = {}) => {
    const variantsTouched = body.variants !== undefined || body.variations !== undefined;
    const existingHasVariants = hasFoodVariants(existing);
    const update = {};

    if (variantsTouched) {
        const variants = normalizeFoodVariantsInput(extractRawFoodVariants(body));
        update.variants = variants;

        if (variants.length > 0) {
            update.price = getFoodDisplayPrice({ variants });
            update.otherPrice = getFoodDisplayOtherPrice({ variants });
            return update;
        }

        const nextBasePrice =
            body.price !== undefined
                ? Number(body.price)
                : Number(existingHasVariants ? NaN : existing.price);
        if (!Number.isFinite(nextBasePrice) || nextBasePrice <= 0) {
            throw new ValidationError('Base price must be greater than 0 when variants are removed');
        }
        update.price = nextBasePrice;

        if (body.otherPrice !== undefined) {
            const otherPrice = Number(body.otherPrice);
            update.otherPrice = Number.isFinite(otherPrice) && otherPrice > 0 ? otherPrice : 0;
        } else {
            update.otherPrice = 0;
        }
        return update;
    }

    if (body.price !== undefined) {
        if (existingHasVariants) {
            throw new ValidationError('Update variants instead of base price for foods with variants');
        }
        const price = Number(body.price);
        if (!Number.isFinite(price) || price <= 0) throw new ValidationError('Price must be greater than 0');
        update.price = price;
    }

    if (body.otherPrice !== undefined) {
        if (existingHasVariants) {
            throw new ValidationError(
                'Update variants instead of base other price for foods with variants'
            );
        }
        const otherPrice = Number(body.otherPrice);
        update.otherPrice = Number.isFinite(otherPrice) && otherPrice > 0 ? otherPrice : 0;
    }

    return update;
};

export async function createFood(body = {}) {
    if (!isId(body.restaurantId)) throw new ValidationError('Valid restaurantId is required');

    const restaurant = await prisma.foodRestaurant.findUnique({
        where: { id: String(body.restaurantId) },
        select: { id: true, pureVegRestaurant: true },
    });
    if (!restaurant) throw new ValidationError('Restaurant not found');

    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) throw new ValidationError('Food name is required');

    const foodType = body.foodType === 'Veg' ? 'Veg' : 'Non-Veg';
    if (restaurant.pureVegRestaurant === true && foodType !== 'Veg') {
        throw new ValidationError('Pure veg restaurants can only use veg foods');
    }

    const { price, otherPrice, variants } = getAdminFoodCreatePricing(body);

    let categoryName = typeof body.categoryName === 'string' ? body.categoryName.trim() : '';
    if (!categoryName && typeof body.category === 'string') categoryName = body.category.trim();

    const resolved = await resolveAdminFoodCategory({
        categoryId: body.categoryId,
        categoryName,
        foodType,
        pureVegRestaurant: restaurant.pureVegRestaurant === true,
    });

    return prisma.foodItem.create({
        data: {
            restaurantId: restaurant.id,
            categoryId: resolved.categoryId,
            categoryName: resolved.categoryName,
            name,
            description: typeof body.description === 'string' ? body.description.trim() : '',
            price,
            otherPrice,
            // variants is a table, so it is created alongside the dish.
            variants: {
                create: variants.map((variant, index) => ({
                    name: variant.name,
                    price: variant.price,
                    otherPrice: variant.otherPrice,
                    sortOrder: index,
                })),
            },
            ...(normalizeFoodImages(body) ?? { image: '', images: [] }),
            foodType: toFoodTypeColumn(foodType),
            isAvailable: body.isAvailable !== false,
            preparationTime: typeof body.preparationTime === 'string' ? body.preparationTime.trim() : '',
            // An admin creating a dish is the approval.
            approvalStatus: 'approved',
        },
        include: WITH_VARIANTS,
    });
}

export async function updateFood(id, body = {}) {
    if (!isId(id)) return null;

    const existing = await prisma.foodItem.findUnique({
        where: { id: String(id) },
        include: WITH_VARIANTS,
    });
    if (!existing) return null;

    const restaurant = await prisma.foodRestaurant.findUnique({
        where: { id: existing.restaurantId },
        select: { id: true, pureVegRestaurant: true },
    });
    if (!restaurant) throw new ValidationError('Restaurant not found');

    const data = {};
    if (body.name !== undefined) data.name = String(body.name || '').trim();
    if (body.description !== undefined) data.description = String(body.description || '').trim();

    const targetFoodType =
        body.foodType !== undefined
            ? body.foodType === 'Veg' ? 'Veg' : 'Non-Veg'
            : fromFoodTypeColumn(existing.foodType);

    if (restaurant.pureVegRestaurant === true && targetFoodType !== 'Veg') {
        throw new ValidationError('Pure veg restaurants can only use veg foods');
    }

    const pricing = getAdminFoodUpdatedPricing(existing, body);
    const nextVariants = pricing.variants;
    delete pricing.variants;
    Object.assign(data, pricing);

    const nextImages = normalizeFoodImages(body, existing);
    if (nextImages) {
        data.images = nextImages.images;
        data.image = nextImages.image;
    }

    if (body.foodType !== undefined) data.foodType = toFoodTypeColumn(targetFoodType);
    if (body.isAvailable !== undefined) data.isAvailable = body.isAvailable !== false;
    if (body.preparationTime !== undefined) {
        data.preparationTime = String(body.preparationTime || '').trim();
    }

    if (
        body.categoryId !== undefined ||
        body.categoryName !== undefined ||
        body.category !== undefined ||
        body.foodType !== undefined
    ) {
        const nextCategoryName =
            body.categoryName !== undefined
                ? String(body.categoryName || '').trim()
                : body.category !== undefined
                    ? String(body.category || '').trim()
                    : existing.categoryName;

        const resolved = await resolveAdminFoodCategory({
            categoryId: body.categoryId !== undefined ? body.categoryId : existing.categoryId,
            categoryName: nextCategoryName,
            foodType: targetFoodType,
            pureVegRestaurant: restaurant.pureVegRestaurant === true,
        });
        data.categoryId = resolved.categoryId;
        data.categoryName = resolved.categoryName;
    }

    // One transaction: a dish must never be priced from variants that failed to
    // save, nor keep sizes it was just repriced away from.
    return prisma.$transaction(async (tx) => {
        if (nextVariants !== undefined) {
            await syncFoodVariants(tx, existing.id, nextVariants);
        }
        return tx.foodItem.update({
            where: { id: existing.id },
            data,
            include: WITH_VARIANTS,
        });
    });
}

export async function deleteFood(id) {
    if (!isId(id)) return null;

    const food = await prisma.foodItem.findUnique({
        where: { id: String(id) },
        select: { id: true, restaurantId: true },
    });
    if (!food) return null;

    // Variants cascade from the dish.
    await prisma.foodItem.delete({ where: { id: food.id } });
    await dropMenuCache(food.restaurantId);

    return { id: food.id };
}

export async function bulkDeleteFoods({ restaurantId, foodIds = [], selectAll = false, search = '' }) {
    if (!isId(restaurantId)) throw new ValidationError('Valid restaurantId is required');

    const restaurant = await prisma.foodRestaurant.findUnique({
        where: { id: String(restaurantId) },
        select: { id: true },
    });
    if (!restaurant) throw new ValidationError('Restaurant not found');

    const where = { restaurantId: restaurant.id };

    if (selectAll) {
        // "Select all" means everything the current search matches, not
        // literally every dish — the admin is looking at a filtered list.
        const term = String(search || '').trim();
        if (term) {
            const contains = { contains: term, mode: 'insensitive' };
            where.OR = [{ name: contains }, { categoryName: contains }];
        }
    } else {
        const ids = (Array.isArray(foodIds) ? foodIds : []).map(String).filter(isId);
        if (!ids.length) throw new ValidationError('No valid food items selected');
        where.id = { in: ids };
    }

    const { count } = await prisma.foodItem.deleteMany({ where });
    if (count > 0) await dropMenuCache(restaurant.id);

    return { deletedCount: count };
}

/**
 * Approve everything pending, for one restaurant or across the platform.
 *
 * The add-on half cannot be a single statement: Mongo used an
 * aggregation-pipeline update to copy `draft` into `published`, and Prisma has
 * no column-to-column copy, so each add-on is written individually inside one
 * transaction.
 */
export async function bulkApproveFoodItems(restaurantId) {
    const scoped = isId(restaurantId) ? { restaurantId: String(restaurantId) } : {};
    const now = new Date();

    const result = await prisma.$transaction(async (tx) => {
        // FoodItem has no isDeleted column. The Mongo filter carried
        // `isDeleted: { $ne: true }`, which matched every dish because the field
        // was absent — so it never filtered anything, and dropping it here
        // changes nothing.
        const foodItems = await tx.foodItem.updateMany({
            where: { approvalStatus: 'pending', ...scoped },
            data: { approvalStatus: 'approved', approvedAt: now, rejectionReason: '' },
        });

        const pendingAddons = await tx.foodAddon.findMany({
            where: { approvalStatus: 'pending', isDeleted: false, ...scoped },
            select: { id: true, draft: true },
        });

        for (const addon of pendingAddons) {
            await tx.foodAddon.update({
                where: { id: addon.id },
                data: {
                    published: addon.draft,
                    approvalStatus: 'approved',
                    approvedAt: now,
                    rejectionReason: '',
                },
            });
        }

        return { foodItems, addons: { modifiedCount: pendingAddons.length } };
    });

    if (isId(restaurantId)) await dropMenuCache(String(restaurantId));

    return {
        foodItems: result.foodItems,
        addons: result.addons,
        modifiedCount: (result.foodItems.count || 0) + result.addons.modifiedCount,
    };
}
