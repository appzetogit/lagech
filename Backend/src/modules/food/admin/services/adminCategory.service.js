import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { ValidationError } from '../../../../core/auth/errors.js';
import {
    getCategoryStats,
    normalizeCategoryFoodTypeScope,
    serializeCategoryForResponse,
    toPrismaFoodTypeScope,
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
    parent: { select: { id: true, name: true } },
    _count: { select: { children: true } },
};

/**
 * Sub-categories: one level, under a global top-level parent.
 *
 * The previous system nested categories this way ("Hotel VEG" -> "Starter") and
 * never used a third level, so neither does this. Global-only because a
 * sub-category is shared structure: a global child under a restaurant's private
 * parent would be visible to everyone while its parent was not.
 *
 * A child takes its parent's zone, and its diet scope must fit inside the
 * parent's -- a Non-Veg sub-category under a Veg parent would put meat on a veg
 * customer's category page.
 */
const scopeFitsParent = (parentScope, childScope) =>
    parentScope === 'Both' || parentScope === childScope;

/**
 * Reads a parentId from a request body.
 *
 * Returns `undefined` when the body does not mention a parent (leave it alone),
 * `null` when it asks for a top-level category, or the validated parent row.
 */
const resolveParent = async (raw, { selfId = null } = {}) => {
    if (raw === undefined) return undefined;
    const value = raw === null ? '' : String(raw).trim();
    if (!value || value === 'root') return null;

    if (!isId(value)) throw new ValidationError('Invalid parentId');
    if (selfId && value === String(selfId)) {
        throw new ValidationError('A category cannot be its own parent');
    }

    const parent = await prisma.foodCategory.findUnique({ where: { id: value } });
    if (!parent) throw new ValidationError('Parent category not found');
    if (parent.parentId) {
        throw new ValidationError('Sub-categories can only be one level deep');
    }
    if (parent.restaurantId) {
        throw new ValidationError('A sub-category needs a global parent category');
    }
    if (parent.approvalStatus !== 'approved') {
        throw new ValidationError('The parent category must be approved');
    }
    return parent;
};

const assertScopeFitsParent = (parent, scope) => {
    if (!parent) return;
    // The parent row comes from Prisma ('NonVeg'); `scope` is already API form.
    const parentScope = normalizeCategoryFoodTypeScope(parent.foodTypeScope, 'Both');
    if (!scopeFitsParent(parentScope, scope)) {
        throw new ValidationError(
            `A ${scope} sub-category cannot sit under a ${parentScope} category`
        );
    }
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

    // 'root' = top-level only; 'sub' = every sub-category; an id = that
    // category's sub-categories.
    const parentRaw = String(query.parentId || '').trim();
    if (parentRaw === 'root') where.parentId = null;
    else if (parentRaw === 'sub') where.parentId = { not: null };
    else if (isId(parentRaw)) where.parentId = parentRaw;

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

    const parent = await resolveParent(body.parentId);
    const foodTypeScope = normalizeCategoryFoodTypeScope(
        body.foodTypeScope,
        // The fallback is returned as-is, so it must already be API form.
        parent ? normalizeCategoryFoodTypeScope(parent.foodTypeScope, 'Both') : 'Both'
    );
    assertScopeFitsParent(parent, foodTypeScope);

    return prisma.foodCategory.create({
        data: {
            name,
            image: typeof body.image === 'string' ? body.image.trim() : '',
            type: typeof body.type === 'string' ? body.type.trim() : '',
            foodTypeScope: toPrismaFoodTypeScope(foodTypeScope),
            // A sub-category is visible exactly where its parent is.
            zoneId: parent ? parent.zoneId : zoneId,
            parentId: parent ? parent.id : null,
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

    const currentScope = normalizeCategoryFoodTypeScope(category.foodTypeScope, 'Both');
    const nextFoodTypeScope = body.foodTypeScope !== undefined
        ? normalizeCategoryFoodTypeScope(body.foodTypeScope, currentScope)
        : currentScope;

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

    // ── tree position ──
    const requestedParent = await resolveParent(body.parentId, { selfId: category.id });
    const childCount = await prisma.foodCategory.count({ where: { parentId: category.id } });

    if (requestedParent) {
        if (category.restaurantId) {
            throw new ValidationError('Only global categories can be sub-categories');
        }
        if (childCount > 0) {
            throw new ValidationError(
                'A category with sub-categories cannot itself become a sub-category'
            );
        }
    }

    // The parent this category will have once the update lands.
    const effectiveParent = requestedParent !== undefined
        ? requestedParent
        : (category.parentId
            ? await prisma.foodCategory.findUnique({ where: { id: category.parentId } })
            : null);

    assertScopeFitsParent(effectiveParent, nextFoodTypeScope);

    // Narrowing a parent's scope must not leave a sub-category outside it.
    if (body.foodTypeScope !== undefined && childCount > 0 && nextFoodTypeScope !== 'Both') {
        const misfits = await prisma.foodCategory.count({
            where: { parentId: category.id, foodTypeScope: { not: toPrismaFoodTypeScope(nextFoodTypeScope) } },
        });
        if (misfits > 0) {
            throw new ValidationError(
                `${misfits} sub-categor${misfits === 1 ? 'y is' : 'ies are'} outside the selected diet scope`
            );
        }
    }

    const data = {};
    if (body.name !== undefined) data.name = String(body.name || '').trim();
    if (body.image !== undefined) data.image = String(body.image || '').trim();
    if (body.type !== undefined) data.type = String(body.type || '').trim();
    if (body.foodTypeScope !== undefined) data.foodTypeScope = toPrismaFoodTypeScope(nextFoodTypeScope);
    if (body.isActive !== undefined) data.isActive = body.isActive !== false;
    if (body.sortOrder !== undefined) data.sortOrder = Number(body.sortOrder) || 0;
    if (requestedParent !== undefined) data.parentId = requestedParent ? requestedParent.id : null;

    // A promoted (global) category is never zone-bound, whatever the caller sends.
    if (!category.restaurantId && category.createdByRestaurantId) {
        data.zoneId = null;
    } else if (effectiveParent) {
        // A sub-category follows its parent's zone, whatever the caller sends.
        data.zoneId = effectiveParent.zoneId;
    } else if (body.zoneId !== undefined) {
        const raw = String(body.zoneId || '').trim();
        if (!raw || raw === 'global') {
            data.zoneId = null;
        } else {
            if (!isId(raw)) throw new ValidationError('Invalid zoneId');
            data.zoneId = raw;
        }
    }

    // A parent's zone change carries its sub-categories with it, in the same
    // transaction, so a child is never briefly visible where its parent is not.
    return prisma.$transaction(async (tx) => {
        const updated = await tx.foodCategory.update({
            where: { id: category.id },
            data: withProposer(category, data),
        });
        if (childCount > 0 && data.zoneId !== undefined && data.zoneId !== category.zoneId) {
            await tx.foodCategory.updateMany({
                where: { parentId: category.id },
                data: { zoneId: data.zoneId },
            });
        }
        return updated;
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

        // The foreign key would refuse this anyway; checking first turns an
        // opaque constraint error into an instruction.
        const children = await tx.foodCategory.count({ where: { parentId: category.id } });
        if (children > 0) {
            throw new ValidationError(
                `Delete or move its ${children} sub-categor${children === 1 ? 'y' : 'ies'} first`
            );
        }

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
