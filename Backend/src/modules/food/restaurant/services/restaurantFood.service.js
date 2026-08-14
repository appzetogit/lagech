import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { ValidationError } from '../../../../core/auth/errors.js';
import { normalizeFoodImages } from '../../admin/services/foodImages.util.js';
import {
    extractRawFoodVariants,
    getFoodDisplayOtherPrice,
    getFoodDisplayPrice,
    hasFoodVariants,
    normalizeFoodVariantsInput,
    syncFoodVariants,
} from '../../admin/services/foodVariant.service.js';
import {
    APPROVED_CATEGORY_FILTER,
    categoryAllowsFoodType,
    GLOBAL_CATEGORY_FILTER,
} from '../../shared/categoryWorkflow.js';

const toStr = (v) => (v != null ? String(v).trim() : '');

/** The dish plus its variant rows — hasFoodVariants() needs them loaded. */
const WITH_VARIANTS = { variants: { orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] } };

/**
 * FoodType's Prisma name for 'Non-Veg' is NonVeg (the hyphen is a @map), so the
 * client value and the wire value differ and have to be translated both ways.
 */
const toFoodTypeColumn = (v) => (String(v || '').trim() === 'Veg' ? 'Veg' : 'NonVeg');
const normalizeFoodType = (v) => {
    const t = String(v || '').trim();
    // 'Egg' and anything unrecognised have always counted as non-veg.
    return t === 'Veg' ? 'Veg' : 'Non-Veg';
};

/** Same story for the hyphenated stock modes. */
const STOCK_OFF_MODES = {
    'manual': 'manual',
    'specific-time': 'specific_time',
    'next-business-day': 'next_business_day',
    'custom-date-time': 'custom_date_time',
};

const getCreateFoodPricing = (body = {}) => {
    const variants = normalizeFoodVariantsInput(extractRawFoodVariants(body));
    if (variants.length > 0) {
        return {
            price: getFoodDisplayPrice({ variants }),
            otherPrice: getFoodDisplayOtherPrice({ variants }),
            variants,
        };
    }

    const price = Number(body.price);
    if (!Number.isFinite(price) || price < 0) throw new ValidationError('Price is invalid');
    const otherPrice = Number(body.otherPrice);
    return {
        price,
        otherPrice: Number.isFinite(otherPrice) && otherPrice > 0 ? otherPrice : 0,
        variants: [],
    };
};

const getUpdatedFoodPricing = (existing = {}, body = {}) => {
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
        if (!Number.isFinite(nextBasePrice) || nextBasePrice < 0) {
            throw new ValidationError('Base price is required when variants are removed');
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
        if (!Number.isFinite(price) || price < 0) throw new ValidationError('Price is invalid');
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

const parseStockResumeAt = (value) => {
    if (value === null || value === undefined || value === '') return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
};

/**
 * Availability fields.
 *
 * Mongo needed a separate $unset map to remove a field; a column just goes to
 * NULL, so this returns one flat object.
 */
const buildAvailabilityUpdate = (body = {}) => {
    const update = {};

    if (body.isAvailable !== undefined) {
        update.isAvailable = body.isAvailable !== false;
        // Coming back in stock clears whatever scheduled it off.
        if (body.isAvailable !== false) {
            update.stockResumeAt = null;
            update.stockOffMode = null;
        }
    }

    if (body.stockResumeAt !== undefined) {
        update.stockResumeAt = parseStockResumeAt(body.stockResumeAt);
    }

    if (body.stockOffMode !== undefined) {
        update.stockOffMode = STOCK_OFF_MODES[String(body.stockOffMode || '').trim()] || null;
    }

    return update;
};

const getRestaurantContext = async (restaurantId) => {
    if (!isId(restaurantId)) throw new ValidationError('Invalid restaurant id');

    const restaurant = await prisma.foodRestaurant.findUnique({
        where: { id: String(restaurantId) },
        select: { id: true, pureVegRestaurant: true },
    });
    if (!restaurant) throw new ValidationError('Restaurant not found');

    return { restaurantId: restaurant.id, pureVegRestaurant: restaurant.pureVegRestaurant === true };
};

/** Approved categories this restaurant may file a dish under: its own, or global. */
const getAccessibleCategoryFilter = (context) => ({
    OR: [
        { restaurantId: context.restaurantId, ...APPROVED_CATEGORY_FILTER },
        { ...GLOBAL_CATEGORY_FILTER, ...APPROVED_CATEGORY_FILTER },
    ],
});

const resolveCategoryForRestaurant = async (context, body = {}) => {
    const categoryIdRaw = toStr(body.categoryId);
    const categoryNameRaw = toStr(body.categoryName);
    const foodType = normalizeFoodType(body.foodType);

    if (!categoryIdRaw && !categoryNameRaw) {
        return { categoryId: null, categoryName: '' };
    }

    const baseFilter = {
        ...getAccessibleCategoryFilter(context),
        isActive: true,
        ...(context.pureVegRestaurant ? { foodTypeScope: 'Veg' } : {}),
    };

    let category = null;
    if (categoryIdRaw) {
        if (!isId(categoryIdRaw)) throw new ValidationError('Invalid category id');
        category = await prisma.foodCategory.findFirst({
            where: { id: categoryIdRaw, ...baseFilter },
        });
    } else {
        // An exact, case-insensitive name match. Two accessible categories can
        // legitimately share a name (one global, one private), and silently
        // picking either would file the dish under the wrong one.
        const matches = await prisma.foodCategory.findMany({
            where: { ...baseFilter, name: { equals: categoryNameRaw, mode: 'insensitive' } },
            orderBy: { createdAt: 'desc' },
            take: 2,
        });
        if (matches.length > 1) {
            throw new ValidationError(
                'Multiple categories share this name. Please choose a specific category.'
            );
        }
        category = matches[0] || null;
    }

    if (!category) throw new ValidationError('Category not found for this restaurant');

    if (String(category.approvalStatus || '') !== 'approved') {
        throw new ValidationError('This category is awaiting admin approval');
    }
    if (context.pureVegRestaurant && String(category.foodTypeScope || '') !== 'Veg') {
        throw new ValidationError('Pure veg restaurants can only use veg categories');
    }
    if (!categoryAllowsFoodType(category.foodTypeScope, foodType)) {
        throw new ValidationError(
            `This ${category.foodTypeScope} category cannot accept ${foodType} food`
        );
    }

    return { categoryId: category.id, categoryName: category.name || '', category };
};

const notifyAdmins = async (title, body, id) => {
    try {
        const { notifyAdminsSafely } = await import(
            '../../../../core/notifications/firebase.service.js'
        );
        void notifyAdminsSafely({
            title,
            body,
            data: { type: 'approval_request', subType: 'food', id: String(id) },
        });
    } catch (e) {
        console.error('Failed to notify admins of food approval request:', e);
    }
};

export async function createRestaurantFood(restaurantId, body = {}) {
    const context = await getRestaurantContext(restaurantId);

    const name = toStr(body.name);
    if (!name) throw new ValidationError('Item name is required');
    if (name.length > 200) throw new ValidationError('Item name is too long');

    const { price, otherPrice, variants } = getCreateFoodPricing(body);
    const foodType = normalizeFoodType(body.foodType);
    const { categoryId, categoryName } = await resolveCategoryForRestaurant(context, {
        ...body,
        foodType,
    });

    const doc = await prisma.foodItem.create({
        data: {
            restaurantId: context.restaurantId,
            categoryId,
            categoryName: categoryName || '',
            name,
            description: toStr(body.description),
            price,
            otherPrice,
            // variants is a table now, so it is created alongside the dish in
            // one statement rather than embedded in it.
            variants: {
                create: variants.map((variant, index) => ({
                    name: variant.name,
                    price: variant.price,
                    otherPrice: variant.otherPrice,
                    sortOrder: index,
                })),
            },
            // Same normaliser the admin service uses, so a dish gets the same
            // image/images relationship regardless of which panel created it.
            ...(normalizeFoodImages(body) ?? { image: '', images: [] }),
            foodType: toFoodTypeColumn(foodType),
            isAvailable: body.isAvailable !== false,
            isRecommended: body.isRecommended === true,
            preparationTime: toStr(body.preparationTime),
            approvalStatus: 'pending',
            requestedAt: new Date(),
        },
        include: WITH_VARIANTS,
    });

    await notifyAdmins(
        'New Product Approval Request',
        `Restaurant has submitted a new item "${doc.name}" for approval.`,
        doc.id
    );

    return doc;
}

export async function updateRestaurantFood(restaurantId, foodId, body = {}) {
    const context = await getRestaurantContext(restaurantId);
    if (!isId(foodId)) throw new ValidationError('Invalid food id');

    const existing = await prisma.foodItem.findFirst({
        where: { id: String(foodId), restaurantId: context.restaurantId },
        include: WITH_VARIANTS,
    });
    if (!existing) return null;

    const update = {};

    if (body.name !== undefined) {
        const name = toStr(body.name);
        if (!name) throw new ValidationError('Item name is required');
        if (name.length > 200) throw new ValidationError('Item name is too long');
        update.name = name;
    }
    if (body.description !== undefined) update.description = toStr(body.description);

    const nextImages = normalizeFoodImages(body, existing);
    if (nextImages) {
        update.images = nextImages.images;
        update.image = nextImages.image;
    }

    const pricing = getUpdatedFoodPricing(existing, body);
    // Held back from the column update — variants live in their own table.
    const nextVariants = pricing.variants;
    delete pricing.variants;
    Object.assign(update, pricing);

    Object.assign(update, buildAvailabilityUpdate(body));
    if (body.preparationTime !== undefined) update.preparationTime = toStr(body.preparationTime);
    if (body.isRecommended !== undefined) update.isRecommended = body.isRecommended === true;

    const targetFoodType =
        body.foodType !== undefined
            ? normalizeFoodType(body.foodType)
            : normalizeFoodType(existing.foodType === 'NonVeg' ? 'Non-Veg' : existing.foodType);
    if (body.foodType !== undefined) update.foodType = toFoodTypeColumn(targetFoodType);

    if (
        body.categoryId !== undefined ||
        body.categoryName !== undefined ||
        body.foodType !== undefined
    ) {
        const resolved = await resolveCategoryForRestaurant(context, {
            categoryId: body.categoryId !== undefined ? body.categoryId : existing.categoryId,
            categoryName:
                body.categoryName !== undefined ? body.categoryName : existing.categoryName,
            foodType: targetFoodType,
        });
        update.categoryId = resolved.categoryId;
        update.categoryName = resolved.categoryName || '';
    }

    const CRITICAL_APPROVAL_FIELDS = [
        // `images` alongside `image`: adding or reordering photos changes what
        // customers are shown, so it goes back through approval for the same
        // reason a changed primary image always did.
        'name', 'description', 'image', 'images', 'price',
        'foodType', 'categoryId', 'categoryName', 'preparationTime',
    ];
    const shouldResubmitForApproval =
        Object.keys(update).some((key) => CRITICAL_APPROVAL_FIELDS.includes(key)) ||
        nextVariants !== undefined;

    if (shouldResubmitForApproval) {
        update.approvalStatus = 'pending';
        update.requestedAt = new Date();
        update.rejectionReason = '';
        update.approvedAt = null;
        update.rejectedAt = null;
    }

    // One transaction: a dish must never end up priced from variants that
    // failed to save, or resubmitted for approval without its new sizes.
    const updated = await prisma.$transaction(async (tx) => {
        if (nextVariants !== undefined) {
            await syncFoodVariants(tx, existing.id, nextVariants);
        }
        return tx.foodItem.update({
            where: { id: existing.id },
            data: update,
            include: WITH_VARIANTS,
        });
    });

    if (shouldResubmitForApproval) {
        await notifyAdmins(
            'Updated Product Approval Request',
            `Restaurant has updated and resubmitted "${updated.name}" for approval.`,
            updated.id
        );
    }

    return updated;
}
