import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { ValidationError } from '../../../../core/auth/errors.js';
import { logger } from '../../../../utils/logger.js';

/**
 * Add-on approval, extracted from admin.service.js.
 *
 * An add-on carries two copies of its content: `draft` is what the restaurant
 * edits, `published` is what the customer app serves. Approving copies draft
 * over published, so an edit to an already-live add-on stays invisible until an
 * admin accepts it.
 *
 * Both are Json columns, which is deliberate — they are always read and written
 * whole, never filtered on in SQL.
 */

const ADDON_STATUSES = ['pending', 'approved', 'rejected'];

/** A live add-on: soft-deleted rows are invisible to every path here. */
const liveAddon = (extra = {}) => ({ isDeleted: false, ...extra });

const serializeAddon = (a) => ({
    id: a.id,
    _id: a.id,
    restaurantId: a.restaurantId,
    restaurant: a.restaurant
        ? {
            _id: a.restaurant.id,
            name: a.restaurant.restaurantName || '',
            ownerName: a.restaurant.ownerName || '',
            ownerPhone: a.restaurant.ownerPhone || '',
        }
        : null,
    approvalStatus: a.approvalStatus || 'pending',
    rejectionReason: a.rejectionReason || '',
    requestedAt: a.requestedAt,
    approvedAt: a.approvedAt,
    rejectedAt: a.rejectedAt,
    isAvailable: a.isAvailable !== false,
    draft: a.draft || null,
    published: a.published || null,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
});

const WITH_RESTAURANT = {
    restaurant: { select: { id: true, restaurantName: true, ownerName: true, ownerPhone: true } },
};

/** Approving flips draft → published, which is what the public feed serves. */
const dropPublicAddonCache = async () => {
    const { invalidatePublicAddonCache } = await import(
        '../../restaurant/services/restaurantAddon.service.js'
    );
    await invalidatePublicAddonCache();
};

export async function getRestaurantAddonsAdmin(query = {}) {
    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 50, 1), 200);
    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    const skip = (page - 1) * limit;

    const where = liveAddon();

    const approvalStatus = String(query.approvalStatus || '').trim();
    if (ADDON_STATUSES.includes(approvalStatus)) where.approvalStatus = approvalStatus;
    if (isId(query.restaurantId)) where.restaurantId = String(query.restaurantId);

    if (query.search && String(query.search).trim()) {
        const term = String(query.search).trim().slice(0, 80);
        where.OR = [
            // draft is Json, so the name is matched with a JSON path filter
            // rather than a column comparison.
            { draft: { path: ['name'], string_contains: term } },
            { restaurant: { restaurantName: { contains: term, mode: 'insensitive' } } },
        ];
    }

    const [list, total] = await Promise.all([
        prisma.foodAddon.findMany({
            where,
            orderBy: [{ requestedAt: 'desc' }, { createdAt: 'desc' }],
            skip,
            take: limit,
            include: WITH_RESTAURANT,
        }),
        prisma.foodAddon.count({ where }),
    ]);

    return { addons: list.map(serializeAddon), total, page, limit };
}

export async function updateRestaurantAddonAdmin(addonId, body = {}) {
    if (!isId(addonId)) return null;

    const addon = await prisma.foodAddon.findFirst({
        where: liveAddon({ id: String(addonId) }),
    });
    if (!addon) return null;

    const patch = {};
    if (body.name !== undefined) patch.name = String(body.name || '').trim();
    if (body.description !== undefined) patch.description = String(body.description || '').trim();

    if (body.foodType !== undefined) {
        const foodType = String(body.foodType || '').trim().toLowerCase();
        if (!['veg', 'non-veg'].includes(foodType)) {
            throw new ValidationError('Food type must be veg or non-veg');
        }
        patch.foodType = foodType;
    }

    if (body.price !== undefined) {
        const price = Number(body.price);
        if (!Number.isFinite(price) || price < 0) {
            throw new ValidationError('Price must be a valid positive number');
        }
        patch.price = price;
    }

    if (body.image !== undefined) patch.image = String(body.image || '').trim();
    if (Array.isArray(body.images)) {
        patch.images = body.images
            .map((img) => (typeof img === 'string' ? img : img?.url))
            .filter(Boolean);
    } else if (patch.image) {
        patch.images = [patch.image];
    }

    const data = {
        // Json columns are replaced whole, so the merge happens here.
        draft: { ...(addon.draft || {}), ...patch },
    };

    // An add-on that is already live has its published copy edited too —
    // otherwise an admin's own correction would sit unapplied behind an
    // approval it already has.
    if (addon.approvalStatus === 'approved') {
        data.published = { ...(addon.published || {}), ...patch };
    }

    if (body.isAvailable !== undefined) data.isAvailable = body.isAvailable === true;

    const updated = await prisma.foodAddon.update({ where: { id: addon.id }, data });
    await dropPublicAddonCache();
    return serializeAddon(updated);
}

export async function approveRestaurantAddon(addonId) {
    if (!isId(addonId)) return null;

    const addon = await prisma.foodAddon.findFirst({
        where: liveAddon({ id: String(addonId) }),
    });
    if (!addon) return null;

    // Mongo did this with an aggregation-pipeline update so `published: '$draft'`
    // was one atomic statement. Prisma cannot express a column-to-column copy,
    // so the draft is read first and written back — safe here because a draft
    // only changes when the restaurant edits it, and an edit puts the add-on
    // back into pending anyway.
    const updated = await prisma.foodAddon.update({
        where: { id: addon.id },
        data: {
            published: addon.draft,
            approvalStatus: 'approved',
            approvedAt: new Date(),
            // Explicit, so an add-on approved after a rejection does not keep
            // carrying the old reason.
            rejectedAt: null,
            rejectionReason: '',
        },
    });

    // Without this the add-on stayed invisible to customers for up to 600s.
    await dropPublicAddonCache();

    try {
        const { notifyOwnersSafely } = await import('../../../../core/notifications/firebase.service.js');
        await notifyOwnersSafely(
            [{ ownerType: 'RESTAURANT', ownerId: updated.restaurantId }],
            {
                title: 'Addon Approved!',
                body: `Your addon "${updated.published?.name || 'New Addon'}" has been approved and is now live.`,
                image: 'https://i.ibb.co/5GzXz7r/Switcheats-Brand-Image.png',
                data: {
                    type: 'addon_approved',
                    addonId: updated.id,
                    restaurantId: updated.restaurantId,
                },
            },
        );
    } catch (e) {
        logger.error('Failed to send addon approval notification:', e);
    }

    return serializeAddon(updated);
}

export async function rejectRestaurantAddon(addonId, reason) {
    if (!isId(addonId)) return null;

    const rejectionReason = String(reason || '').trim();
    // A rejection the restaurant cannot act on is worse than none.
    if (!rejectionReason) throw new ValidationError('Rejection reason is required');

    const { count } = await prisma.foodAddon.updateMany({
        where: liveAddon({ id: String(addonId) }),
        data: { approvalStatus: 'rejected', rejectionReason, rejectedAt: new Date() },
    });
    if (!count) return null;

    const updated = await prisma.foodAddon.findUnique({
        where: { id: String(addonId) },
        include: WITH_RESTAURANT,
    });

    try {
        const { notifyOwnersSafely } = await import('../../../../core/notifications/firebase.service.js');
        await notifyOwnersSafely(
            [{ ownerType: 'RESTAURANT', ownerId: updated.restaurantId }],
            {
                title: 'Addon Rejected',
                body: `Your addon request for "${updated.draft?.name || 'New Addon'}" was rejected. Reason: ${rejectionReason}`,
                image: 'https://i.ibb.co/5GzXz7r/Switcheats-Brand-Image.png',
                data: {
                    type: 'addon_rejected',
                    addonId: updated.id,
                    restaurantId: updated.restaurantId,
                    reason: rejectionReason,
                },
            },
        );
    } catch (e) {
        logger.error('Failed to send addon rejection notification:', e);
    }

    return serializeAddon(updated);
}
