import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { ValidationError } from '../../../../core/auth/errors.js';
import {
    APPROVED_CATEGORY_FILTER,
    GLOBAL_CATEGORY_FILTER,
    getCategoryStats,
    normalizeCategoryFoodTypeScope,
    serializeCategoryForResponse,
    zoneVisibilityFilter,
} from '../../shared/categoryWorkflow.js';

/** Columns the category screens read. */
const CATEGORY_SELECT = {
    id: true, name: true, image: true, type: true, foodTypeScope: true,
    approvalStatus: true, isApproved: true, rejectionReason: true,
    zoneId: true, restaurantId: true, createdByRestaurantId: true,
    isActive: true, sortOrder: true,
    requestedAt: true, approvedAt: true, rejectedAt: true, globalizedAt: true,
    createdAt: true, updatedAt: true,
};

const RESTAURANT_PARTY = { id: true, restaurantName: true, ownerName: true, ownerPhone: true };

const getRestaurantContext = async (restaurantId) => {
    if (!isId(restaurantId)) throw new ValidationError('Invalid restaurant id');

    const restaurant = await prisma.foodRestaurant.findUnique({
        where: { id: String(restaurantId) },
        select: { id: true, zoneId: true, pureVegRestaurant: true },
    });
    if (!restaurant) throw new ValidationError('Restaurant not found');

    return {
        restaurantId: restaurant.id,
        zoneId: restaurant.zoneId ? String(restaurant.zoneId) : '',
        pureVegRestaurant: restaurant.pureVegRestaurant === true,
    };
};

export async function listRestaurantCategories(restaurantId, query = {}) {
    const context = await getRestaurantContext(restaurantId);
    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 1000, 1), 1000);
    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    const skip = (page - 1) * limit;

    const search = typeof query.search === 'string' ? query.search.trim() : '';
    const includeInactive = query.includeInactive === 'true' || query.includeInactive === '1';
    const withCounts = query.withCounts === 'true' || query.withCounts === '1';
    const compact = query.compact === 'true' || query.compact === '1';
    const zoneIdRaw = typeof query.zoneId === 'string' ? query.zoneId.trim() : context.zoneId;

    // What this restaurant may see: approved global categories, plus its own.
    // In compact mode (the menu-builder picker) its own must be approved too;
    // in the management list it sees its pending and rejected ones as well.
    const visibility = {
        OR: compact
            ? [
                { ...GLOBAL_CATEGORY_FILTER, ...APPROVED_CATEGORY_FILTER },
                { restaurantId: context.restaurantId, ...APPROVED_CATEGORY_FILTER },
            ]
            : [
                { ...GLOBAL_CATEGORY_FILTER, ...APPROVED_CATEGORY_FILTER },
                { restaurantId: context.restaurantId },
                { createdByRestaurantId: context.restaurantId },
            ],
    };

    const AND = [visibility, zoneVisibilityFilter(zoneIdRaw)];
    if (search) {
        AND.push({ name: { contains: search.slice(0, 80), mode: 'insensitive' } });
    }
    if (compact && context.pureVegRestaurant) {
        AND.push({ foodTypeScope: 'Veg' });
    }

    const where = { AND, ...(includeInactive ? {} : { isActive: true }) };

    const [list, total] = await Promise.all([
        prisma.foodCategory.findMany({
            where,
            orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
            skip,
            take: limit,
            select: compact
                ? CATEGORY_SELECT
                : {
                    ...CATEGORY_SELECT,
                    // The management list shows who owns each category. This was
                    // a second query and a Map; both are foreign keys now.
                    restaurant: { select: RESTAURANT_PARTY },
                    createdByRestaurant: { select: RESTAURANT_PARTY },
                },
        }),
        prisma.foodCategory.count({ where }),
    ]);

    const statsById = await getCategoryStats(list.map((category) => category.id));

    const categories = list.map((category) =>
        serializeCategoryForResponse(category, {
            currentRestaurantId: restaurantId,
            includeCounts: withCounts || !compact,
            statsById,
        })
    );

    return { categories, total, page, limit };
}

export async function listPublicCategories(query = {}) {
    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 1000, 1), 1000);
    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    const skip = (page - 1) * limit;

    const search = typeof query.search === 'string' ? query.search.trim() : '';
    const zoneIdRaw = typeof query.zoneId === 'string' ? query.zoneId.trim() : '';

    const AND = [
        GLOBAL_CATEGORY_FILTER,
        APPROVED_CATEGORY_FILTER,
        zoneVisibilityFilter(zoneIdRaw),
        // Only categories that actually have an approved dish — an empty
        // category is a dead tab in the app. This was a distinct() over
        // food_items followed by an $in; a relation filter does it in one query
        // instead of shipping every category id back to Node first.
        { foodItems: { some: { approvalStatus: 'approved' } } },
    ];
    if (search) {
        AND.push({ name: { contains: search.slice(0, 80), mode: 'insensitive' } });
    }

    const where = { AND, isActive: true };

    const [list, total] = await Promise.all([
        prisma.foodCategory.findMany({
            where,
            orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
            skip,
            take: limit,
            select: {
                id: true, name: true, image: true, type: true, foodTypeScope: true,
                zoneId: true, sortOrder: true, createdAt: true, updatedAt: true,
            },
        }),
        prisma.foodCategory.count({ where }),
    ]);

    return {
        categories: list.map((category) => serializeCategoryForResponse(category)),
        total,
        page,
        limit,
    };
}

export async function createRestaurantCategory(restaurantId, body = {}) {
    const context = await getRestaurantContext(restaurantId);

    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) throw new ValidationError('Category name is required');
    if (name.length > 200) throw new ValidationError('Category name is too long');

    const foodTypeScopeRaw = typeof body.foodTypeScope === 'string' ? body.foodTypeScope.trim() : '';
    if (!foodTypeScopeRaw) throw new ValidationError('Category diet type is required');

    const foodTypeScope = normalizeCategoryFoodTypeScope(foodTypeScopeRaw, '');
    if (!foodTypeScope) throw new ValidationError('Invalid category diet type');
    if (context.pureVegRestaurant && foodTypeScope !== 'Veg') {
        throw new ValidationError('Pure veg restaurants can only create veg categories');
    }

    return prisma.foodCategory.create({
        data: {
            name,
            image: typeof body.image === 'string' ? body.image.trim() : '',
            type: typeof body.type === 'string' ? body.type.trim() : '',
            foodTypeScope,
            isActive: body.isActive !== false,
            sortOrder: Number.isFinite(Number(body.sortOrder)) ? Number(body.sortOrder) : 0,
            restaurantId: context.restaurantId,
            createdByRestaurantId: context.restaurantId,
            // A restaurant's own category is moderated before it appears.
            approvalStatus: 'pending',
            isApproved: false,
            rejectionReason: '',
            requestedAt: new Date(),
            zoneId: isId(context.zoneId) ? context.zoneId : null,
        },
    });
}

export async function updateRestaurantCategory(restaurantId, id, body = {}) {
    const context = await getRestaurantContext(restaurantId);
    if (!isId(id)) throw new ValidationError('Invalid category id');

    const existing = await prisma.foodCategory.findFirst({
        where: { id: String(id), restaurantId: context.restaurantId },
    });
    if (!existing) return null;

    const nextFoodTypeScope =
        body.foodTypeScope !== undefined
            ? normalizeCategoryFoodTypeScope(body.foodTypeScope, '')
            : normalizeCategoryFoodTypeScope(existing.foodTypeScope, 'Both');

    if (body.foodTypeScope !== undefined && !nextFoodTypeScope) {
        throw new ValidationError('Invalid category diet type');
    }
    if (context.pureVegRestaurant && nextFoodTypeScope !== 'Veg') {
        throw new ValidationError('Pure veg restaurants can only keep veg categories');
    }

    const data = {};

    if (body.name !== undefined) {
        const name = String(body.name || '').trim();
        if (!name) throw new ValidationError('Category name is required');
        if (name.length > 200) throw new ValidationError('Category name is too long');
        data.name = name;
    }
    if (body.image !== undefined) data.image = String(body.image || '').trim();
    if (body.type !== undefined) data.type = String(body.type || '').trim();
    if (body.isActive !== undefined) data.isActive = body.isActive !== false;
    if (body.sortOrder !== undefined) data.sortOrder = Number(body.sortOrder) || 0;

    if (body.foodTypeScope !== undefined) {
        // Narrowing the diet type must not orphan dishes already in it.
        const incompatibleFoods =
            nextFoodTypeScope === 'Both'
                ? 0
                : await prisma.foodItem.count({
                    where: {
                        categoryId: existing.id,
                        foodType: nextFoodTypeScope === 'Veg' ? 'NonVeg' : 'Veg',
                    },
                });
        if (incompatibleFoods > 0) {
            throw new ValidationError(
                `This category already has ${incompatibleFoods} food item(s) outside the selected diet type`
            );
        }
        data.foodTypeScope = nextFoodTypeScope;
    }

    data.createdByRestaurantId = existing.createdByRestaurantId || context.restaurantId;

    // Anything customer-visible goes back through moderation.
    const APPROVAL_CRITICAL_FIELDS = ['name', 'image', 'type', 'foodTypeScope', 'sortOrder'];
    if (APPROVAL_CRITICAL_FIELDS.some((key) => body[key] !== undefined)) {
        data.approvalStatus = 'pending';
        data.isApproved = false;
        data.rejectionReason = '';
        data.requestedAt = new Date();
        // null, not undefined: undefined means "leave alone" to Prisma, so the
        // old approval timestamps would have survived the resubmission.
        data.approvedAt = null;
        data.rejectedAt = null;
    }

    return prisma.foodCategory.update({ where: { id: existing.id }, data });
}

export async function deleteRestaurantCategory(restaurantId, id) {
    const context = await getRestaurantContext(restaurantId);
    if (!isId(id)) throw new ValidationError('Invalid category id');

    const category = await prisma.foodCategory.findFirst({
        where: { id: String(id), restaurantId: context.restaurantId },
        select: { id: true },
    });
    if (!category) return null;

    // Counts dishes from any restaurant, not just this one: food_items.categoryId
    // is a foreign key, so a dish elsewhere would block the delete at the
    // database level anyway, and this reports it as a clear error instead.
    const inUse = await prisma.foodItem.count({ where: { categoryId: category.id } });
    if (inUse > 0) throw new ValidationError('Cannot delete category while it has items');

    await prisma.foodCategory.delete({ where: { id: category.id } });
    return { id: category.id };
}
