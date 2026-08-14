import { prisma } from '../../../config/prisma.js';
import { isId } from '../../../utils/helpers.js';

export const CATEGORY_APPROVAL_STATUSES = ['pending', 'approved', 'rejected'];
export const CATEGORY_FOOD_TYPE_SCOPES = ['Veg', 'Non-Veg', 'Both'];

/**
 * A category with no restaurant is an admin/global one.
 *
 * Was `[{ restaurantId: { $exists: false } }, { restaurantId: null }]` — two
 * clauses because a Mongo document could omit the field entirely. A column
 * cannot, so it is one condition.
 */
export const GLOBAL_CATEGORY_FILTER = { restaurantId: null };

/**
 * Same story: the Mongo filter had to allow for `approvalStatus` being absent
 * and fall back to `isApproved !== false`. The column is NOT NULL with a
 * default, so the status alone is the answer.
 */
export const APPROVED_CATEGORY_FILTER = { approvalStatus: 'approved' };

/** zoneId set = that zone only; null = everywhere. */
export const zoneVisibilityFilter = (zoneIdRaw) =>
    isId(zoneIdRaw)
        ? { OR: [{ zoneId: String(zoneIdRaw) }, { zoneId: null }] }
        : { zoneId: null };

export const normalizeCategoryApprovalStatus = (value, fallback = 'pending') => {
    const normalized = String(value || '').trim();
    return CATEGORY_APPROVAL_STATUSES.includes(normalized) ? normalized : fallback;
};

export const normalizeCategoryFoodTypeScope = (value, fallback = 'Both') => {
    const normalized = String(value || '').trim();
    return CATEGORY_FOOD_TYPE_SCOPES.includes(normalized) ? normalized : fallback;
};

export const normalizeFoodTypeForCategory = (value) =>
    String(value || '').trim() === 'Veg' ? 'Veg' : 'Non-Veg';

export const categoryAllowsFoodType = (scope, foodType) => {
    const normalizedScope = normalizeCategoryFoodTypeScope(scope, 'Both');
    if (normalizedScope === 'Both') return true;
    return normalizedScope === normalizeFoodTypeForCategory(foodType);
};

export const isGlobalCategory = (category = {}) => !category?.restaurantId;

export const getCategoryApprovalStatus = (category = {}) => {
    const status = String(category?.approvalStatus || '').trim();
    if (CATEGORY_APPROVAL_STATUSES.includes(status)) return status;
    return category?.isApproved === false ? 'pending' : 'approved';
};

/**
 * Per-category dish counts: total, veg, and approved.
 *
 * Was a Mongo $group aggregation. Postgres does conditional counts with
 * COUNT(*) FILTER, which Prisma's groupBy cannot express — it only offers a
 * plain _count — so this stays raw rather than becoming three round trips.
 *
 * @returns {Promise<Map<string, {totalFoods: number, vegFoods: number, approvedFoods: number}>>}
 */
export const getCategoryStats = async (categoryIds = []) => {
    const validIds = [...new Set((categoryIds || []).map((v) => (v ? String(v) : '')).filter(isId))];
    if (!validIds.length) return new Map();

    const rows = await prisma.$queryRaw`
        SELECT "categoryId",
               COUNT(*)                                            AS "totalFoods",
               COUNT(*) FILTER (WHERE "foodType" = 'Veg')          AS "vegFoods",
               COUNT(*) FILTER (WHERE "approvalStatus" = 'approved') AS "approvedFoods"
        FROM "food_items"
        WHERE "categoryId" = ANY(${validIds})
        GROUP BY "categoryId"
    `;

    // COUNT is int8, which the driver returns as BigInt.
    return new Map(
        rows.map((row) => [
            String(row.categoryId),
            {
                totalFoods: Number(row.totalFoods),
                vegFoods: Number(row.vegFoods),
                approvedFoods: Number(row.approvedFoods),
            },
        ])
    );
};

/**
 * The shape the category screens render.
 *
 * `restaurantId` may arrive as a bare id or as a hydrated restaurant, depending
 * on whether the caller asked for the relation, so both are handled.
 */
export const serializeCategoryForResponse = (category = {}, options = {}) => {
    const statsById = options.statsById instanceof Map ? options.statsById : new Map();
    const categoryId = String(category?.id || category?._id || '');
    const stats = statsById.get(categoryId) || null;
    const approvalStatus = getCategoryApprovalStatus(category);

    const idOf = (value) => {
        if (!value) return null;
        if (typeof value === 'object') return String(value.id || value._id || '') || null;
        return String(value);
    };
    const objectOf = (value) => (value && typeof value === 'object' ? value : null);

    const restaurantId = idOf(category?.restaurantId ?? category?.restaurant);
    const createdByRestaurantId = idOf(
        category?.createdByRestaurantId ?? category?.createdByRestaurant
    );

    const owner = objectOf(category?.restaurant ?? category?.restaurantId);
    const creator = objectOf(category?.createdByRestaurant ?? category?.createdByRestaurantId);

    const isOwnedByRestaurant = options.currentRestaurantId
        ? createdByRestaurantId === String(options.currentRestaurantId) ||
          restaurantId === String(options.currentRestaurantId)
        : false;

    const toParty = (restaurant) =>
        restaurant
            ? {
                _id: restaurant.id || restaurant._id,
                name: restaurant.restaurantName || '',
                ownerName: restaurant.ownerName || '',
                ownerPhone: restaurant.ownerPhone || '',
            }
            : null;

    return {
        id: categoryId,
        _id: categoryId,
        name: category.name,
        image: category.image || '',
        type: category.type || '',
        status: category.isActive !== false,
        isActive: category.isActive !== false,
        isApproved: approvalStatus === 'approved',
        approvalStatus,
        foodTypeScope: normalizeCategoryFoodTypeScope(category.foodTypeScope, 'Both'),
        rejectionReason: category.rejectionReason || '',
        restaurantId,
        createdByRestaurantId,
        isGlobal: !restaurantId,
        globalizedAt: category.globalizedAt || null,
        requestedAt: category.requestedAt || null,
        approvedAt: category.approvedAt || null,
        rejectedAt: category.rejectedAt || null,
        ownedByRestaurant: isOwnedByRestaurant,
        canEdit: options.currentRestaurantId
            ? Boolean(restaurantId && restaurantId === String(options.currentRestaurantId))
            : true,
        canDelete: options.currentRestaurantId
            ? Boolean(
                restaurantId &&
                restaurantId === String(options.currentRestaurantId) &&
                Number(stats?.totalFoods || 0) === 0
            )
            : Number(stats?.totalFoods || 0) === 0,
        restaurant: toParty(owner),
        createdByRestaurant: toParty(creator),
        zoneId: category.zoneId || null,
        sortOrder: category.sortOrder || 0,
        itemCount: options.includeCounts ? Number(stats?.totalFoods || 0) : undefined,
        approvedFoodCount: options.includeCounts ? Number(stats?.approvedFoods || 0) : undefined,
        createdAt: category.createdAt,
        updatedAt: category.updatedAt,
    };
};
