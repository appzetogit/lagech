import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { ValidationError } from '../../../../core/auth/errors.js';
import { fromRestaurantLocation, toRestaurant } from '../../restaurant/restaurant.mapper.js';
import { logger } from '../../../../utils/logger.js';

/**
 * Restaurant approval and lifecycle, extracted from admin.service.js.
 *
 * The approval queue carries two different kinds of request. A restaurant that
 * has never been approved is waiting on its registration; one that is already
 * approved may be waiting on a *location change*, which is held in the pending*
 * columns while the live location keeps serving orders.
 *
 * approve/reject therefore act on whichever is outstanding: approving publishes
 * a pending location if there is one, and rejecting an already-approved
 * restaurant rejects only the move, not the restaurant.
 */

const parseBooleanLike = (value, fieldName) => {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (['true', '1', 'yes', 'y', 'on', 'active'].includes(normalized)) return true;
        if (['false', '0', 'no', 'n', 'off', 'inactive'].includes(normalized)) return false;
    }
    throw new ValidationError(`${fieldName} must be a boolean`);
};

const toFiniteNumber = (value) => {
    if (value === null || value === undefined || value === '') return null;
    const num = typeof value === 'number' ? value : Number(String(value).trim());
    return Number.isFinite(num) ? num : null;
};

const ZONE_SUMMARY = { select: { id: true, name: true, zoneName: true } };

/** The zone names the approval queue shows beside each row. */
const withZoneNames = (r, index) => ({
    ...toRestaurant(r),
    sl: index + 1,
    zone: r.zone?.zoneName || r.zone?.name || null,
    pendingZone: r.pendingZone?.zoneName || r.pendingZone?.name || null,
});

export async function getPendingRestaurants() {
    const restaurants = await prisma.foodRestaurant.findMany({
        where: {
            OR: [
                { status: { in: ['pending', 'rejected'] } },
                // An approved restaurant asking to move is also waiting on an
                // admin, and belongs in the same queue.
                { locationUpdateStatus: 'pending' },
            ],
        },
        include: { zone: ZONE_SUMMARY, pendingZone: ZONE_SUMMARY },
        orderBy: { createdAt: 'desc' },
    });

    return restaurants.map(withZoneNames);
}

export async function getUnregisteredRestaurants() {
    const list = await prisma.foodUnregisteredRestaurant.findMany({
        orderBy: { createdAt: 'desc' },
    });
    return list.map((item, index) => ({ ...item, sl: index + 1 }));
}

export async function deleteUnregisteredRestaurant(id) {
    if (!isId(id)) throw new ValidationError('Invalid unregistered restaurant id');

    const row = await prisma.foodUnregisteredRestaurant.findUnique({ where: { id: String(id) } });
    if (!row) return null;

    await prisma.foodUnregisteredRestaurant.delete({ where: { id: row.id } });
    return row;
}

export async function updateRestaurantStatus(id, body = {}) {
    if (!isId(id)) return null;

    const raw = body.status !== undefined ? body.status : body.isActive;
    let status = null;

    if (typeof raw === 'string') {
        const normalized = raw.trim().toLowerCase();
        if (['approved', 'pending', 'rejected'].includes(normalized)) status = normalized;
    }

    // The same endpoint serves a status dropdown and an on/off toggle.
    if (!status) status = parseBooleanLike(raw, 'status') ? 'approved' : 'rejected';

    const data = { status };
    if (status === 'approved') data.approvedAt = new Date();
    if (status === 'rejected') {
        data.rejectedAt = new Date();
        data.rejectionReason = 'Disabled by admin';
    }

    const { count } = await prisma.foodRestaurant.updateMany({ where: { id: String(id) }, data });
    if (!count) return null;

    return toRestaurant(await prisma.foodRestaurant.findUnique({ where: { id: String(id) } }));
}

/**
 * Admin edits a restaurant's address directly.
 *
 * Unlike the restaurant's own edit, this is applied at once — an admin moving a
 * pin does not need their own approval.
 */
export async function updateRestaurantLocation(id, body = {}) {
    if (!isId(id)) return null;

    const existing = await prisma.foodRestaurant.findUnique({ where: { id: String(id) } });
    if (!existing) return null;

    const source = body.location && typeof body.location === 'object' ? body.location : body;
    const toStr = (v) => (v != null ? String(v).trim() : '');

    const coordinates = Array.isArray(source.coordinates) ? source.coordinates : [];
    const latitude = toFiniteNumber(source.latitude ?? toFiniteNumber(coordinates[1]));
    const longitude = toFiniteNumber(source.longitude ?? toFiniteNumber(coordinates[0]));

    const addressLine1 = toStr(source.addressLine1 || source.formattedAddress || source.address);
    const formattedAddress = toStr(source.formattedAddress || source.address || addressLine1);

    // The nested location subdocument and the flat columns beside it used to be
    // written twice and kept in step by hand; there is one copy now, and the
    // PostGIS point is derived from it by a trigger.
    const data = fromRestaurantLocation({
        latitude,
        longitude,
        formattedAddress,
        addressLine1,
        addressLine2: toStr(source.addressLine2),
        area: toStr(source.area),
        city: toStr(source.city),
        state: toStr(source.state),
        pincode: toStr(source.pincode || source.zipCode || source.postalCode),
        landmark: toStr(source.landmark),
    });

    if (body.zoneId !== undefined) {
        const zoneId = String(body.zoneId || '').trim();
        if (!zoneId) {
            data.zoneId = null;
        } else if (!isId(zoneId)) {
            throw new ValidationError('Invalid zoneId');
        } else {
            data.zoneId = zoneId;
        }
    }

    await prisma.foodRestaurant.update({ where: { id: existing.id }, data });

    const updated = await prisma.foodRestaurant.findUnique({
        where: { id: existing.id },
        include: {
            zone: { select: { id: true, name: true, zoneName: true, serviceLocation: true, isActive: true } },
        },
    });
    return toRestaurant(updated);
}

export async function approveRestaurant(id) {
    if (!isId(id)) return null;

    const existing = await prisma.foodRestaurant.findUnique({ where: { id: String(id) } });
    if (!existing) return null;

    const data = {
        status: 'approved',
        approvedAt: new Date(),
        // Explicit, so an approval after a rejection does not keep the reason.
        rejectedAt: null,
        rejectionReason: '',
    };

    // A pending move is published by the same approval.
    //
    // Only the coordinates and the zone are held pending — the address columns
    // are not captured when the request is made, so there is nothing to copy
    // for them. See updateRestaurantProfile in restaurant.service.js.
    if (existing.locationUpdateStatus === 'pending' && existing.pendingLatitude !== null) {
        data.latitude = existing.pendingLatitude;
        data.longitude = existing.pendingLongitude;
        if (existing.pendingZoneId) data.zoneId = existing.pendingZoneId;

        data.locationUpdateStatus = 'approved';
        data.locationUpdateReviewedAt = new Date();
        data.pendingLatitude = null;
        data.pendingLongitude = null;
        data.pendingZoneId = null;
        data.locationUpdateRequestedAt = null;
        data.locationRejectionReason = '';
    }

    const updated = await prisma.foodRestaurant.update({ where: { id: existing.id }, data });

    try {
        const { notifyOwnersSafely } = await import('../../../../core/notifications/firebase.service.js');
        await notifyOwnersSafely(
            [{ ownerType: 'RESTAURANT', ownerId: updated.id }],
            {
                title: 'Congratulations!',
                body: `Your restaurant "${updated.restaurantName}" has been approved.`,
                image: updated.profileImage || 'https://i.ibb.co/5GzXz7r/Switcheats-Brand-Image.png',
                data: { type: 'restaurant_approved', restaurantId: updated.id },
            },
        );
    } catch (e) {
        logger.error('Failed to send restaurant approval notification:', e);
    }

    return toRestaurant(updated);
}

export async function rejectRestaurant(id, reason) {
    if (!isId(id)) return null;

    const existing = await prisma.foodRestaurant.findUnique({ where: { id: String(id) } });
    if (!existing) return null;

    const rejectionReason = typeof reason === 'string' ? reason.trim() : '';

    // An approved restaurant with a move outstanding is rejecting the move, not
    // itself — it keeps trading from where it already is.
    if (existing.status === 'approved' && existing.locationUpdateStatus === 'pending') {
        const updated = await prisma.foodRestaurant.update({
            where: { id: existing.id },
            data: {
                locationUpdateStatus: 'rejected',
                locationUpdateReviewedAt: new Date(),
                locationRejectionReason: rejectionReason,
                pendingLatitude: null,
                pendingLongitude: null,
                pendingZoneId: null,
                locationUpdateRequestedAt: null,
            },
        });
        return toRestaurant(updated);
    }

    const updated = await prisma.foodRestaurant.update({
        where: { id: existing.id },
        data: {
            status: 'rejected',
            rejectedAt: new Date(),
            rejectionReason,
            approvedAt: null,
        },
    });

    try {
        const { notifyOwnersSafely } = await import('../../../../core/notifications/firebase.service.js');
        await notifyOwnersSafely(
            [{ ownerType: 'RESTAURANT', ownerId: updated.id }],
            {
                title: 'Update on Registration',
                body: `Your restaurant registration for "${updated.restaurantName}" has been rejected. Reason: ${rejectionReason || 'Incomplete documents'}.`,
                image: 'https://i.ibb.co/5GzXz7r/Switcheats-Brand-Image.png',
                data: {
                    type: 'restaurant_rejected',
                    restaurantId: updated.id,
                    reason: rejectionReason,
                },
            },
        );
    } catch (e) {
        logger.error('Failed to send restaurant rejection notification:', e);
    }

    return toRestaurant(updated);
}

/**
 * Permanently delete a restaurant from the admin panel.
 *
 * Same rule as the restaurant's own account deletion: orders, transactions and
 * invoices are the platform's books, and a restaurant that has traded cannot be
 * erased. Mongo deleted the row and left all of it pointing at nothing.
 */
export async function deleteRestaurant(id) {
    if (!isId(id)) throw new ValidationError('Invalid restaurant ID');

    const restaurant = await prisma.foodRestaurant.findUnique({ where: { id: String(id) } });
    if (!restaurant) return null;

    const [orders, transactions, invoices] = await Promise.all([
        prisma.foodOrder.count({ where: { restaurantId: restaurant.id } }),
        prisma.foodTransaction.count({ where: { restaurantId: restaurant.id } }),
        prisma.foodSubscriptionInvoice.count({ where: { restaurantId: restaurant.id } }),
    ]);

    if (orders || transactions || invoices) {
        throw new ValidationError(
            'This restaurant has order or billing history and cannot be deleted. Deactivate it instead.',
        );
    }

    await prisma.$transaction(async (tx) => {
        // Categories it owns go; ones it merely proposed are kept and detached,
        // because a promoted global category must not vanish with it.
        await tx.foodCategory.deleteMany({ where: { restaurantId: restaurant.id } });
        await tx.foodCategory.updateMany({
            where: { createdByRestaurantId: restaurant.id },
            data: { createdByRestaurantId: null },
        });

        await tx.foodOffer.deleteMany({ where: { restaurantId: restaurant.id } });
        await tx.foodSupportTicket.deleteMany({ where: { restaurantId: restaurant.id } });
        await tx.foodRestaurantSupportTicket.deleteMany({ where: { restaurantId: restaurant.id } });
        await tx.feedbackExperience.deleteMany({ where: { restaurantId: restaurant.id } });
        await tx.foodRestaurantWithdrawal.deleteMany({ where: { restaurantId: restaurant.id } });
        await tx.foodSubscriptionTransaction.deleteMany({ where: { restaurantId: restaurant.id } });
        await tx.foodRestaurantSubscriptionHistory.deleteMany({ where: { restaurantId: restaurant.id } });

        // Dishes, add-ons, timings and banners cascade from this.
        await tx.foodRestaurant.delete({ where: { id: restaurant.id } });

        // The owner's login is only removed if it exists solely for this
        // restaurant.
        if (restaurant.ownerPhone) {
            await tx.foodUser.deleteMany({
                where: { phone: restaurant.ownerPhone, role: 'RESTAURANT' },
            });
        }
    });

    return toRestaurant(restaurant);
}
