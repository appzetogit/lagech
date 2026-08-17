import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { ValidationError } from '../../../../core/auth/errors.js';
import { notifyAdminsSafely } from '../../../../core/notifications/firebase.service.js';
import { logger } from '../../../../utils/logger.js';

/**
 * The restaurant's own side of add-ons.
 *
 * `draft` is what the restaurant edits and `published` is what the customer app
 * serves; the two only converge when an admin approves. Both are Json columns,
 * so any edit is a read-merge-write — Prisma replaces a Json column whole, and
 * writing a partial object would silently drop the other keys.
 */

const ADDON_STATUSES = ['pending', 'approved', 'rejected'];
const MAX_IMAGES = 10;

/** A live add-on: soft-deleted rows are invisible to every path here. */
const live = (extra = {}) => ({ isDeleted: false, ...extra });

/**
 * Drops the cached public add-on responses.
 *
 * `GET /restaurants/:id/addons` is cached for 600s and NOTHING was clearing it, so a
 * newly created, edited, approved or deleted add-on could take ten minutes to appear
 * in the user app. Keyed per foodId as well, so a targeted delete would have to know
 * every item id; wiping the whole prefix is both simpler and complete, and add-on
 * edits are far too rare for the extra misses to matter.
 */
export async function invalidatePublicAddonCache() {
    try {
        const { invalidateCache } = await import('../../../../middleware/cache.js');
        await invalidateCache('restaurant_addons:*');
    } catch (err) {
        logger.warn(`Add-on cache invalidation failed: ${err?.message || err}`);
    }
}

const assertRestaurantId = (restaurantId) => {
    if (!isId(restaurantId)) throw new ValidationError('Invalid restaurant id');
    return String(restaurantId);
};

/**
 * Keeps only ids that are real menu items of THIS restaurant.
 *
 * Without this check a restaurant could attach its add-ons to another restaurant's
 * menu items, and those add-ons would then surface on that restaurant's item sheet
 * at a price its owner never set.
 */
async function sanitizeFoodIds(restaurantId, foodIds) {
    const ids = [...new Set(
        (Array.isArray(foodIds) ? foodIds : []).map((v) => String(v || '').trim())
    )].filter(isId);
    if (!ids.length) return [];

    const owned = await prisma.foodItem.findMany({
        where: { restaurantId, id: { in: ids } },
        select: { id: true },
    });

    if (owned.length !== ids.length) {
        throw new ValidationError('One or more selected menu items do not belong to this restaurant');
    }
    return owned.map((f) => f.id);
}

/**
 * Is this name already taken at this restaurant?
 *
 * Prisma's Json filters can only match a string case-insensitively with
 * `string_contains`, so the exact comparison happens here. The candidate set is
 * one restaurant's add-ons, so it stays small.
 */
async function nameIsTaken(restaurantId, name, exceptId = null) {
    const candidates = await prisma.foodAddon.findMany({
        where: live({
            restaurantId,
            ...(exceptId ? { id: { not: exceptId } } : {}),
            draft: { path: ['name'], string_contains: name, mode: 'insensitive' },
        }),
        select: { draft: true },
    });

    const target = name.toLowerCase();
    return candidates.some((a) => String(a.draft?.name || '').trim().toLowerCase() === target);
}

const cleanImages = (images) =>
    (Array.isArray(images) ? images : []).filter(Boolean).slice(0, MAX_IMAGES);

/** 'veg' unless explicitly non-veg — the same rule the old sub-schema had. */
const normalizeAddonFoodType = (value) => (value === 'non-veg' ? 'non-veg' : 'veg');

const serializeContent = (content) => {
    if (!content) return null;
    return {
        name: content.name || '',
        description: content.description || '',
        foodType: normalizeAddonFoodType(content.foodType),
        isVeg: content.foodType !== 'non-veg',
        price: Number(content.price) || 0,
        image: content.image || '',
        images: Array.isArray(content.images) ? content.images : [],
    };
};

const serializeAddon = (a) => {
    if (!a) return null;
    const draft = a.draft || {};
    const foodIds = Array.isArray(a.foodIds) ? a.foodIds : [];
    return {
        _id: a.id,
        id: a.id,
        restaurantId: a.restaurantId,
        approvalStatus: a.approvalStatus || 'pending',
        rejectionReason: a.rejectionReason || '',
        requestedAt: a.requestedAt,
        approvedAt: a.approvedAt,
        rejectedAt: a.rejectedAt,
        isAvailable: a.isAvailable !== false,
        // Empty => applies to the whole menu.
        foodIds,
        isItemSpecific: foodIds.length > 0,
        group: {
            name: a.groupName || '',
            minSelect: a.groupMinSelect || 0,
            maxSelect: a.groupMaxSelect || 1,
            sortOrder: a.groupSortOrder || 0,
        },
        // Draft fields (what the restaurant edits), flattened for the editor.
        ...serializeContent(draft),
        // Published snapshot (what the user app sees).
        published: serializeContent(a.published),
        createdAt: a.createdAt,
        updatedAt: a.updatedAt,
    };
};

export async function listRestaurantAddons(restaurantId, query = {}) {
    const rid = assertRestaurantId(restaurantId);

    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 100, 1), 100);
    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    const skip = (page - 1) * limit;

    const where = { restaurantId: rid };
    if (query.includeDeleted !== true) where.isDeleted = false;
    if (ADDON_STATUSES.includes(String(query.status || '').trim())) {
        where.approvalStatus = String(query.status).trim();
    }

    const search = typeof query.search === 'string' ? query.search.trim().slice(0, 80) : '';
    if (search) {
        where.draft = { path: ['name'], string_contains: search, mode: 'insensitive' };
    }

    const [list, total] = await Promise.all([
        prisma.foodAddon.findMany({
            where,
            orderBy: [{ requestedAt: 'desc' }, { createdAt: 'desc' }],
            skip,
            take: limit,
        }),
        prisma.foodAddon.count({ where }),
    ]);

    return { addons: list.map(serializeAddon), total, page, limit };
}

export async function createRestaurantAddon(restaurantId, body = {}) {
    const rid = assertRestaurantId(restaurantId);

    const name = String(body?.name || '').trim();
    if (!name) throw new ValidationError('Add-on name is required');
    if (await nameIsTaken(rid, name)) throw new ValidationError('Add-on already exists');

    const foodIds = await sanitizeFoodIds(rid, body?.foodIds);

    const addon = await prisma.foodAddon.create({
        data: {
            restaurantId: rid,
            draft: {
                name,
                description: String(body.description || '').trim(),
                foodType: normalizeAddonFoodType(body?.foodType),
                price: Number(body.price) || 0,
                image: String(body.image || '').trim(),
                images: cleanImages(body.images),
            },
            published: undefined,
            foodIds,
            groupName: String(body?.group?.name || '').trim(),
            groupMinSelect: Number(body?.group?.minSelect) || 0,
            groupMaxSelect: Number(body?.group?.maxSelect) || 1,
            groupSortOrder: Number(body?.group?.sortOrder) || 0,
            approvalStatus: 'pending',
            requestedAt: new Date(),
        },
    });

    void notifyAdminsSafely({
        title: 'New Addon Approval Request 🍟',
        body: `Restaurant has submitted a new addon "${name}" for approval.`,
        data: { type: 'approval_request', subType: 'addon', id: addon.id },
    }).catch((err) => logger.warn(`Addon approval notification failed: ${err?.message || err}`));

    await invalidatePublicAddonCache();
    return serializeAddon(addon);
}

export async function updateRestaurantAddon(restaurantId, addonId, updateDto = {}) {
    const rid = assertRestaurantId(restaurantId);
    if (!isId(addonId)) throw new ValidationError('Invalid add-on id');
    const id = String(addonId);

    const existing = await prisma.foodAddon.findFirst({ where: live({ id, restaurantId: rid }) });
    if (!existing) return null;

    const data = {};

    if (updateDto?.isAvailable !== undefined) data.isAvailable = updateDto.isAvailable !== false;

    // Re-linking to menu items is not a content change, so this deliberately does
    // NOT reset approvalStatus the way a draft edit below does.
    if (updateDto?.foodIds !== undefined) {
        data.foodIds = await sanitizeFoodIds(rid, updateDto.foodIds);
    }

    // Also presentation, not content — no re-approval.
    if (updateDto?.group !== undefined) {
        const g = updateDto.group || {};
        data.groupName = String(g.name || '').trim();
        data.groupMinSelect = Number(g.minSelect) || 0;
        data.groupMaxSelect = Number(g.maxSelect) || 1;
        data.groupSortOrder = Number(g.sortOrder) || 0;
    }

    if (updateDto?.draft) {
        const d = updateDto.draft;
        // Merged onto what is already stored: Json columns are replaced whole,
        // so writing only the edited keys would erase the rest.
        const draft = { ...(existing.draft || {}) };

        if (d.name !== undefined) {
            const name = String(d.name || '').trim();
            if (!name) throw new ValidationError('Add-on name is required');
            if (name.length > 200) throw new ValidationError('Add-on name is too long');
            if (await nameIsTaken(rid, name, id)) throw new ValidationError('Add-on already exists');
            draft.name = name;
        }
        if (d.description !== undefined) draft.description = String(d.description || '').trim();
        if (d.foodType !== undefined) {
            const ft = String(d.foodType || '').trim().toLowerCase();
            if (ft !== 'veg' && ft !== 'non-veg') {
                throw new ValidationError('Food type must be veg or non-veg');
            }
            draft.foodType = ft;
        }
        if (d.price !== undefined) {
            const price = Number(d.price);
            if (!Number.isFinite(price) || price < 0) throw new ValidationError('Price must be >= 0');
            draft.price = price;
        }
        if (d.image !== undefined) draft.image = String(d.image || '').trim();
        if (d.images !== undefined) draft.images = cleanImages(d.images);

        data.draft = draft;

        // Any draft content change must go through admin approval again.
        data.approvalStatus = 'pending';
        data.rejectionReason = '';
        data.requestedAt = new Date();
        data.approvedAt = null;
        data.rejectedAt = null;
    }

    if (Object.keys(data).length === 0) return serializeAddon(existing);

    const updated = await prisma.foodAddon.update({ where: { id }, data });
    await invalidatePublicAddonCache();
    return serializeAddon(updated);
}

export async function deleteRestaurantAddon(restaurantId, addonId) {
    const rid = assertRestaurantId(restaurantId);
    if (!isId(addonId)) throw new ValidationError('Invalid add-on id');

    // Soft delete, and only if it is still live — deleting twice must not
    // report success the second time.
    const { count } = await prisma.foodAddon.updateMany({
        where: live({ id: String(addonId), restaurantId: rid }),
        data: { isDeleted: true },
    });
    if (!count) return null;

    await invalidatePublicAddonCache();
    return { id: String(addonId) };
}
