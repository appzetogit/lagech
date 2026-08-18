import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { NotFoundError, ValidationError } from '../../../../core/auth/errors.js';
import { logger } from '../../../../utils/logger.js';

/**
 * The admin delivery-partner list and its money summary, extracted from
 * admin.service.js.
 *
 * The summary was six Mongo aggregations fanned out per page. They are six
 * groupBy calls now, which is the same shape but typed — and the two that
 * matter (earnings and cash collected) group on dispatchDeliveryPartnerId,
 * which is what the order column is actually called.
 */

const num = (value) => Number(value || 0);
const toFiniteNumber = (value) => {
    const n = typeof value === 'number' ? value : parseFloat(String(value));
    return Number.isFinite(n) ? n : null;
};

const emptyStats = () => ({
    totalEarning: 0,
    cashCollected: 0,
    totalDeposited: 0,
    bonus: 0,
    totalWithdrawn: 0,
    pendingWithdrawal: 0,
    totalOrders: 0,
});

/**
 * Per-partner money summary for a page of riders.
 *
 * Six grouped queries rather than six per rider — the list shows up to a
 * thousand at a time.
 */
export async function getBulkDeliveryPartnerStats(partnerIds) {
    const ids = (partnerIds || []).map(String).filter(Boolean);
    if (!ids.length) return new Map();

    const deliveredByPartner = {
        dispatchDeliveryPartnerId: { in: ids },
        orderStatus: 'delivered',
    };

    const [earnings, cash, deposits, bonuses, withdrawals] = await Promise.all([
        // Earnings and the delivered-order count come from one grouping.
        prisma.foodOrder.groupBy({
            by: ['dispatchDeliveryPartnerId'],
            where: deliveredByPartner,
            _sum: { riderEarning: true },
            _count: { _all: true },
        }),
        // Cash the rider physically holds: COD orders they delivered.
        prisma.foodOrder.groupBy({
            by: ['dispatchDeliveryPartnerId'],
            where: { ...deliveredByPartner, paymentMethod: 'cash' },
            _sum: { total: true },
        }),
        prisma.foodDeliveryCashDeposit.groupBy({
            by: ['deliveryPartnerId'],
            where: { deliveryPartnerId: { in: ids }, status: 'Completed' },
            _sum: { amount: true },
        }),
        prisma.deliveryBonusTransaction.groupBy({
            by: ['deliveryPartnerId'],
            where: { deliveryPartnerId: { in: ids } },
            _sum: { amount: true },
        }),
        // Approved and pending are summed separately, so one grouping by both.
        prisma.foodDeliveryWithdrawal.groupBy({
            by: ['deliveryPartnerId', 'status'],
            where: { deliveryPartnerId: { in: ids }, status: { in: ['approved', 'pending'] } },
            _sum: { amount: true },
        }),
    ]);

    const statsMap = new Map(ids.map((id) => [id, emptyStats()]));
    const at = (id) => statsMap.get(String(id));

    for (const row of earnings) {
        const stats = at(row.dispatchDeliveryPartnerId);
        if (!stats) continue;
        stats.totalEarning = num(row._sum.riderEarning);
        stats.totalOrders = row._count._all;
    }
    for (const row of cash) {
        const stats = at(row.dispatchDeliveryPartnerId);
        if (stats) stats.cashCollected = num(row._sum.total);
    }
    for (const row of deposits) {
        const stats = at(row.deliveryPartnerId);
        if (stats) stats.totalDeposited = num(row._sum.amount);
    }
    for (const row of bonuses) {
        const stats = at(row.deliveryPartnerId);
        if (stats) stats.bonus = num(row._sum.amount);
    }
    for (const row of withdrawals) {
        const stats = at(row.deliveryPartnerId);
        if (!stats) continue;
        if (row.status === 'approved') stats.totalWithdrawn = num(row._sum.amount);
        if (row.status === 'pending') stats.pendingWithdrawal = num(row._sum.amount);
    }

    for (const stats of statsMap.values()) {
        // What the rider can still withdraw: earned plus bonuses, less what has
        // been paid out and what is already claimed.
        stats.pocketBalance =
            stats.totalEarning + stats.bonus - stats.totalWithdrawn - stats.pendingWithdrawal;
        // Cash they collected on our behalf and have not yet handed in.
        stats.cashInHand = stats.cashCollected - stats.totalDeposited;
    }

    return statsMap;
}

const serializePartner = (doc, stats = {}, sl = 0) => {
    const lastLat = toFiniteNumber(doc.lastLat);
    const lastLng = toFiniteNumber(doc.lastLng);

    return {
        _id: doc.id,
        id: doc.id,
        sl,
        name: doc.name || '',
        email: doc.email || '',
        phone: doc.phone || '',
        deliveryId: doc.id ? `DP-${doc.id.slice(-8).toUpperCase()}` : null,
        zone: doc.city || doc.state || doc.address || '',
        vehicleType: doc.vehicleType || '',
        status: doc.status,
        availabilityStatus: doc.availabilityStatus || 'offline',
        isOnline: doc.availabilityStatus === 'online',
        lastLocation:
            lastLat !== null && lastLng !== null
                ? {
                    lat: lastLat,
                    lng: lastLng,
                    latitude: lastLat,
                    longitude: lastLng,
                    timestamp: doc.lastLocationAt ? new Date(doc.lastLocationAt).getTime() : null,
                }
                : null,
        lastLat,
        lastLng,
        lastLocationAt: doc.lastLocationAt || null,
        // Whether this rider can actually be sent an order offer.
        //
        // A rider with no push token is invisible to dispatch no matter how
        // online they look, and nothing surfaced that: five of six online riders
        // sat unreachable for hours while the list showed them green.
        hasPushToken:
            (doc.fcmTokenMobile || []).length > 0 || (doc.fcmTokens || []).length > 0,
        profilePhoto: doc.profilePhoto || null,
        profileImage: doc.profilePhoto ? { url: doc.profilePhoto } : null,
        totalOrders: stats.totalOrders || 0,
        pocketBalance: stats.pocketBalance || 0,
        cashInHand: stats.cashInHand || 0,
        totalEarning: stats.totalEarning || 0,
        bonus: stats.bonus || 0,
        totalWithdrawn: stats.totalWithdrawn || 0,
        pendingWithdrawal: stats.pendingWithdrawal || 0,
    };
};

const searchWhere = (search) => {
    const term = typeof search === 'string' ? search.trim() : '';
    if (!term) return {};
    const contains = { contains: term, mode: 'insensitive' };
    return {
        OR: [
            { name: contains }, { phone: contains }, { email: contains },
            { city: contains }, { state: contains },
        ],
    };
};

export async function getDeliveryPartners(query = {}) {
    const limit = Math.max(1, Math.min(1000, Number(query.limit) || 100));
    const page = Math.max(1, Number(query.page) || 1);
    const skip = (page - 1) * limit;

    const where = { status: 'approved', ...searchWhere(query.search) };

    const [list, total] = await Promise.all([
        prisma.foodDeliveryPartner.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            skip,
            take: limit,
        }),
        prisma.foodDeliveryPartner.count({ where }),
    ]);

    const statsMap = await getBulkDeliveryPartnerStats(list.map((p) => p.id));

    return {
        deliveryPartners: list.map((doc, index) =>
            serializePartner(doc, statsMap.get(doc.id) || {}, skip + index + 1)
        ),
        pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 },
    };
}

export async function getDeliveryPartnerById(id) {
    if (!isId(id)) return null;

    const doc = await prisma.foodDeliveryPartner.findUnique({ where: { id: String(id) } });
    if (!doc) return null;

    const stats = (await getBulkDeliveryPartnerStats([doc.id])).get(doc.id) || {};
    return serializePartner(doc, stats, 1);
}

/**
 * Applications that are not yet approved.
 *
 * Returns `{ requests }` with no pagination wrapper, and reports a rejected
 * application as 'denied' — both are what the admin screen reads.
 */
export async function getDeliveryJoinRequests(query = {}) {
    const { status = 'pending', zone, vehicleType } = query;
    const limit = Math.max(1, Math.min(1000, Number(query.limit) || 100));
    const page = Math.max(1, Number(query.page) || 1);
    const skip = (page - 1) * limit;

    // The screen says 'denied'; the column says 'rejected'.
    const where = { status: status === 'denied' ? 'rejected' : String(status) };

    const AND = [];
    const search = typeof query.search === 'string' ? query.search.trim() : '';
    if (search) {
        const contains = { contains: search, mode: 'insensitive' };
        AND.push({ OR: [{ name: contains }, { phone: contains }] });
    }
    if (zone && String(zone).trim()) {
        const contains = { contains: String(zone).trim(), mode: 'insensitive' };
        AND.push({ OR: [{ city: contains }, { state: contains }, { address: contains }] });
    }
    if (AND.length) where.AND = AND;
    if (vehicleType && String(vehicleType).trim()) {
        where.vehicleType = { contains: String(vehicleType).trim(), mode: 'insensitive' };
    }

    const list = await prisma.foodDeliveryPartner.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
    });

    const requests = list.map((doc, index) => ({
        _id: doc.id,
        id: doc.id,
        sl: skip + index + 1,
        name: doc.name || '',
        email: doc.email || '',
        phone: doc.phone || '',
        zone: doc.city || doc.state || doc.address || '',
        // ponytail: Mongo carried a jobType on the application and the schema
        // has no column for it, so this is always ''. Left in place because the
        // admin table renders the key; drop both together, or add the column.
        jobType: '',
        vehicleType: doc.vehicleType || '',
        status: doc.status === 'rejected' ? 'denied' : doc.status,
        rejectionReason: doc.rejectionReason || undefined,
        profilePhoto: doc.profilePhoto || null,
        profileImage: doc.profilePhoto ? { url: doc.profilePhoto } : null,
    }));

    return { requests };
}

/**
 * Apply a decision to an application.
 *
 * Deliberately not restricted to pending applications: a rejected applicant who
 * sends better documents can be approved afterwards, and that is a real
 * workflow rather than an accident.
 */
const decidePartner = async (id, data) => {
    if (!isId(id)) return null;

    const { count } = await prisma.foodDeliveryPartner.updateMany({
        where: { id: String(id) },
        data,
    });
    if (!count) return null;

    return prisma.foodDeliveryPartner.findUnique({ where: { id: String(id) } });
};

export async function approveDeliveryPartner(id) {
    const partner = await decidePartner(id, {
        status: 'approved',
        approvedAt: new Date(),
        // Explicit nulls: `undefined` means "leave alone" to Prisma, so a
        // previously rejected application would keep its rejection reason.
        rejectedAt: null,
        rejectionReason: '',
    });
    if (!partner) return null;

    try {
        const { notifyOwnerSafely } = await import('../../../../core/notifications/firebase.service.js');
        await notifyOwnerSafely(
            { ownerType: 'DELIVERY_PARTNER', ownerId: partner.id },
            {
                title: 'Welcome Aboard!',
                body: 'Your delivery partner application has been approved. You can now go online and start earning!',
                image: 'https://i.ibb.co/5GzXz7r/Switcheats-Brand-Image.png',
                data: {
                    type: 'delivery_partner_approved',
                    eventType: 'delivery_partner_approved',
                    partnerId: partner.id,
                    targetUrl: '/delivery',
                },
            },
        );
    } catch (e) {
        logger.error('Failed to send delivery partner approval notification:', e);
    }

    // Referral crediting deliberately does NOT happen here. Approval alone does
    // not earn the bonus — the referred rider must also complete one delivery.
    // It is credited by creditDeliveryReferralOnFirstDelivery(), called from
    // completeDelivery in orders/services/order-delivery.service.js.
    return partner;
}

export async function rejectDeliveryPartner(id, reason) {
    const rejectionReason = typeof reason === 'string' ? reason.trim() : '';

    const partner = await decidePartner(id, {
        status: 'rejected',
        rejectedAt: new Date(),
        rejectionReason,
        approvedAt: null,
    });
    if (!partner) return null;

    try {
        const { notifyOwnerSafely } = await import('../../../../core/notifications/firebase.service.js');
        await notifyOwnerSafely(
            { ownerType: 'DELIVERY_PARTNER', ownerId: partner.id },
            {
                title: 'Onboarding Update',
                body: `Your application to join as a delivery partner was rejected. Reason: ${rejectionReason || 'Incomplete documents'}.`,
                image: 'https://i.ibb.co/5GzXz7r/Switcheats-Brand-Image.png',
                data: {
                    type: 'onboarding_rejected',
                    partnerId: partner.id,
                    reason: rejectionReason,
                },
            },
        );
    } catch (e) {
        logger.error('Failed to send delivery partner rejection notification:', e);
    }

    return partner;
}

/**
 * Edits a delivery partner's name and phone from the admin panel.
 *
 * Phone is not just a display field — it is how the rider logs in, and it
 * carries a unique index. Two things follow:
 *
 *  - A number already used by another partner has to be rejected with a
 *    readable message. A deactivated partner still holds its number, so the
 *    collision is not always visible in the list, and the message says so.
 *  - Changing the number changes who can sign in, so the rider's existing
 *    sessions are invalidated: the old handset must not keep acting on an
 *    identity that has moved.
 */
export async function updateDeliveryPartnerProfile(id, { name, phone } = {}) {
    if (!isId(id)) throw new NotFoundError('Delivery partner not found');

    const partner = await prisma.foodDeliveryPartner.findUnique({ where: { id: String(id) } });
    if (!partner) throw new NotFoundError('Delivery partner not found');

    const nextName = typeof name === 'string' ? name.trim() : undefined;
    const nextPhone = typeof phone === 'string' ? phone.trim() : undefined;

    const data = {};

    if (nextName !== undefined) {
        if (!nextName) throw new ValidationError('Name cannot be empty');
        data.name = nextName;
    }

    if (nextPhone !== undefined && nextPhone !== partner.phone) {
        if (!/^\d{10}$/.test(nextPhone)) {
            throw new ValidationError('Phone must be a 10 digit number');
        }

        const clash = await prisma.foodDeliveryPartner.findFirst({
            where: { phone: nextPhone, id: { not: partner.id } },
            select: { name: true, status: true },
        });
        if (clash) {
            throw new ValidationError(
                `That number already belongs to ${clash.name || 'another delivery partner'}` +
                    (clash.status === 'deactivated' ? ' (a deactivated account)' : ''),
            );
        }

        data.phone = nextPhone;
        // Moving the number moves the login. Bump the token version so sessions
        // issued against the old identity stop being accepted on their next
        // request.
        data.tokenVersion = { increment: 1 };
    }

    if (!Object.keys(data).length) return partner;

    try {
        return await prisma.foodDeliveryPartner.update({ where: { id: partner.id }, data });
    } catch (error) {
        // The unique index is the last word, in case the clash appeared between
        // the check above and this write.
        if (error?.code === 'P2002') {
            throw new ValidationError('Another delivery partner already uses this phone number');
        }
        throw error;
    }
}

/**
 * Deactivate a delivery partner.
 *
 * A soft state, not a delete: their orders, wallet and payout history all
 * reference them, and 'deactivated' still holds the phone number so it cannot
 * be reissued to someone else.
 */
export async function deleteDeliveryPartner(id) {
    if (!isId(id)) throw new NotFoundError('Delivery partner not found');

    const { count } = await prisma.foodDeliveryPartner.updateMany({
        where: { id: String(id) },
        data: {
            status: 'deactivated',
            // Sessions end with the account, and a deactivated rider must stop
            // receiving dispatch offers.
            tokenVersion: { increment: 1 },
            availabilityStatus: 'offline',
        },
    });
    if (!count) throw new NotFoundError('Delivery partner not found');

    return prisma.foodDeliveryPartner.findUnique({ where: { id: String(id) } });
}
