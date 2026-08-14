import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { ValidationError } from '../../../../core/auth/errors.js';
import {
    getCategoryStats,
    normalizeCategoryFoodTypeScope,
    serializeCategoryForResponse,
} from '../../shared/categoryWorkflow.js';

/**
 * Admin-side category moderation, extracted from admin.service.js.
 *
 * A category is either global (no restaurantId — every restaurant may use it)
 * or private to one restaurant. Restaurants create private ones that an admin
 * approves; an admin can also promote an approved private category to global,
 * which is what makeCategoryGlobal does.
 *
 * `createdByRestaurantId` is kept alongside `restaurantId` so a promoted
 * category still records who first proposed it, after restaurantId is cleared.
 */

const RESTAURANT_PARTY = { id: true, restaurantName: true, ownerName: true, ownerPhone: true };

const WITH_PARTIES = {
    restaurant: { select: RESTAURANT_PARTY },
    createdByRestaurant: { select: RESTAURANT_PARTY },
};

/** 'global' means "no zone", which is a different filter from a zone id. */
const zoneFilter = (raw) => {
    const value = String(raw || '').trim();
    if (!value) return null;
    if (value === 'global') return { zoneId: null };
    return isId(value) ? { zoneId: value } : null;
};

export async function getCategories(query = {}) {
    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 100, 1), 1000);
    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    const skip = (page - 1) * limit;

    const where = {};

    if (query.search && String(query.search).trim()) {
        where.name = { contains: String(query.search).trim(), mode: 'insensitive' };
    }

    const zone = zoneFilter(query.zoneId);
    if (zone) Object.assign(where, zone);

    // approvalStatus is a NOT NULL enum, so the old "status missing, fall back
    // to isApproved" branches are unreachable and collapse to one comparison.
    if (query.approvalStatus) {
        where.approvalStatus = String(query.approvalStatus);
    } else if (query.isApproved !== undefined) {
        where.approvalStatus = query.isApproved === true ? 'approved' : 'pending';
    }

    const [list, total] = await Promise.all([
        prisma.foodCategory.findMany({
            where,
            orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
            skip,
            take: limit,
            include: WITH_PARTIES,
        }),
        prisma.foodCategory.count({ where }),
    ]);

    const statsById = await getCategoryStats(list.map((category) => category.id));

    return {
        categories: list.map((category) =>
            serializeCategoryForResponse(category, { includeCounts: true, statsById })
        ),
        total,
        page,
        limit,
    };
}

export async function createCategory(body = {}) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) throw new ValidationError('Category name is required');

    let zoneId = null;
    const rawZone = String(body.zoneId || '').trim();
    if (rawZone && rawZone !== 'global') {
        if (!isId(rawZone)) throw new ValidationError('Invalid zoneId');
        zoneId = rawZone;
    }

    return prisma.foodCategory.create({
        data: {
            name,
            image: typeof body.image === 'string' ? body.image.trim() : '',
            type: typeof body.type === 'string' ? body.type.trim() : '',
            foodTypeScope: normalizeCategoryFoodTypeScope(body.foodTypeScope, 'Both'),
            zoneId,
            isActive: body.isActive !== false,
            sortOrder: Number.isFinite(Number(body.sortOrder)) ? Number(body.sortOrder) : 0,
            // An admin creating a category is the approval; it is global and
            // usable immediately.
            approvalStatus: 'approved',
            isApproved: true,
            approvedAt: new Date(),
            rejectionReason: '',
            restaurantId: null,
            createdByRestaurantId: null,
        },
    });
}

/**
 * Every write here also backfills createdByRestaurantId from restaurantId.
 *
 * A category proposed before that column existed has only restaurantId, and
 * losing the proposer on promotion would leave no record of where a global
 * category came from.
 */
const withProposer = (category, data) => ({
    ...data,
    ...(!category.createdByRestaurantId && category.restaurantId
        ? { createdByRestaurantId: category.restaurantId }
        : {}),
});

const loadCategory = async (id) => (isId(id)
    ? prisma.foodCategory.findUnique({ where: { id: String(id) } })
    : null);

export async function approveCategory(id) {
    const category = await loadCategory(id);
    if (!category) return null;

    return prisma.foodCategory.update({
        where: { id: category.id },
        data: withProposer(category, {
            approvalStatus: 'approved',
            isApproved: true,
            approvedAt: new Date(),
            // Explicit null: `undefined` would leave the old rejection in place.
            rejectedAt: null,
            rejectionReason: '',
        }),
    });
}

export async function rejectCategory(id, reason) {
    const category = await loadCategory(id);
    if (!category) return null;

    // A global category has no proposer to reject; it is the platform's own.
    if (!category.restaurantId && !category.createdByRestaurantId) {
        throw new ValidationError('Only restaurant-created categories can be rejected');
    }

    return prisma.foodCategory.update({
        where: { id: category.id },
        data: withProposer(category, {
            approvalStatus: 'rejected',
            isApproved: false,
            rejectionReason: String(reason || '').trim(),
            rejectedAt: new Date(),
            approvedAt: null,
        }),
    });
}

/** Promote an approved private category so every restaurant can use it. */
export async function makeCategoryGlobal(id) {
    const category = await loadCategory(id);
    if (!category) return null;

    // Already global — nothing to do.
    if (!category.restaurantId && !category.createdByRestaurantId) return category;

    if (category.approvalStatus !== 'approved') {
        throw new ValidationError('Only approved categories can be made global');
    }

    return prisma.foodCategory.update({
        where: { id: category.id },
        data: {
            // Who proposed it survives the promotion; who owns it does not.
            createdByRestaurantId: category.createdByRestaurantId || category.restaurantId,
            restaurantId: null,
            // A global category is not confined to one zone.
            zoneId: null,
            approvalStatus: 'approved',
            isApproved: true,
            rejectionReason: '',
            globalizedAt: new Date(),
            approvedAt: category.approvedAt || new Date(),
        },
    });
}

export async function updateCategory(id, body = {}) {
    const category = await loadCategory(id);
    if (!category) return null;

    const nextFoodTypeScope =
        body.foodTypeScope !== undefined
            ? normalizeCategoryFoodTypeScope(body.foodTypeScope, category.foodTypeScope || 'Both')
            : normalizeCategoryFoodTypeScope(category.foodTypeScope, 'Both');

    if (body.foodTypeScope !== undefined && nextFoodTypeScope !== 'Both') {
        // Narrowing the diet scope must not strand dishes already filed here.
        const incompatibleFoods = await prisma.foodItem.count({
            where: {
                categoryId: category.id,
                foodType: nextFoodTypeScope === 'Veg' ? 'NonVeg' : 'Veg',
            },
        });
        if (incompatibleFoods > 0) {
            throw new ValidationError(
                `This category already has ${incompatibleFoods} food item(s) outside the selected diet scope`
            );
        }
    }

    const data = {};
    if (body.name !== undefined) data.name = String(body.name || '').trim();
    if (body.image !== undefined) data.image = String(body.image || '').trim();
    if (body.type !== undefined) data.type = String(body.type || '').trim();
    if (body.foodTypeScope !== undefined) data.foodTypeScope = nextFoodTypeScope;
    if (body.isActive !== undefined) data.isActive = body.isActive !== false;
    if (body.sortOrder !== undefined) data.sortOrder = Number(body.sortOrder) || 0;

    // A promoted (global) category is never zone-bound, whatever the caller sends.
    if (!category.restaurantId && category.createdByRestaurantId) {
        data.zoneId = null;
    } else if (body.zoneId !== undefined) {
        const raw = String(body.zoneId || '').trim();
        if (!raw || raw === 'global') {
            data.zoneId = null;
        } else {
            if (!isId(raw)) throw new ValidationError('Invalid zoneId');
            data.zoneId = raw;
        }
    }

    return prisma.foodCategory.update({
        where: { id: category.id },
        data: withProposer(category, data),
    });
}

export async function deleteCategory(id) {
    if (!isId(id)) return null;

    // food_items.categoryId is a foreign key, so the dishes have to be detached
    // before the category goes — and in the same transaction, or a failure
    // leaves dishes pointing at a category that is about to disappear.
    const deleted = await prisma.$transaction(async (tx) => {
        const category = await tx.foodCategory.findUnique({ where: { id: String(id) } });
        if (!category) return null;

        await tx.foodItem.updateMany({
            where: { categoryId: category.id },
            data: { categoryId: null, categoryName: '' },
        });
        await tx.foodCategory.delete({ where: { id: category.id } });
        return category;
    });

    return deleted ? { id: String(id) } : null;
}

export async function toggleCategoryStatus(id) {
    const category = await loadCategory(id);
    if (!category) return null;

    return prisma.foodCategory.update({
        where: { id: category.id },
        data: withProposer(category, { isActive: !category.isActive }),
    });
}
