import { prisma } from '../../../../config/prisma.js';
import { NotFoundError, ValidationError } from '../../../../core/auth/errors.js';
import { buildOrderIdentityFilter } from './order.helpers.js';

/**
 * The extras the admin Order Details page shows around an order, as the old
 * panel's /admin/order/details/{id} did: the previous/next order for its
 * arrows, how many orders the customer and the store have, how many the
 * deliveryman has delivered, and where the deliveryman was last seen.
 *
 * Kept apart from getOrderById so the customer, restaurant and rider reads of
 * an order stay exactly as they are.
 */

/** Unpaid online checkouts are not orders to the admin; the "All" list hides them too. */
const LISTED = { OR: [{ orderStatus: { not: 'pending_payment' } }, { paymentMethod: 'offline' }] };

const point = (lat, lng, at, source) => {
    const la = Number(lat);
    const ln = Number(lng);
    if (lat == null || lng == null || !Number.isFinite(la) || !Number.isFinite(ln)) return null;
    return { lat: la, lng: ln, at: at || null, source };
};

/**
 * The rider's last known position: their own last ping (it keeps moving after
 * the order is done), else the last one written onto this order.
 */
export function pickLastLocation(partner, orderRow) {
    return (
        point(partner?.lastLat, partner?.lastLng, partner?.lastLocationAt, 'partner')
        || point(orderRow?.riderLat, orderRow?.riderLng, null, 'order')
    );
}

const restaurantAddress = (r) => {
    if (!r) return '';
    if (r.formattedAddress) return r.formattedAddress;
    return [r.addressLine1, r.addressLine2, r.area, r.city].map((v) => String(v || '').trim()).filter(Boolean).join(', ');
};

/** Newest-first neighbours of the order in the admin list: previous = older, next = newer. */
async function neighbours(row) {
    const sameTime = (op) => ({ createdAt: row.createdAt, id: { [op]: row.id } });
    const pick = { id: true, order_id: true };
    const [older, newer] = await Promise.all([
        prisma.foodOrder.findFirst({
            where: { AND: [LISTED, { OR: [{ createdAt: { lt: row.createdAt } }, sameTime('lt')] }] },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            select: pick,
        }),
        prisma.foodOrder.findFirst({
            where: { AND: [LISTED, { OR: [{ createdAt: { gt: row.createdAt } }, sameTime('gt')] }] },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            select: pick,
        }),
    ]);
    const ref = (o) => (o ? { id: o.id, orderId: o.order_id || o.id } : null);
    return { previous: ref(older), next: ref(newer) };
}

export async function getAdminOrderDetailsExtras(orderId) {
    const identity = buildOrderIdentityFilter(orderId);
    if (!identity) throw new ValidationError('Order id required');
    const row = await prisma.foodOrder.findFirst({
        where: identity,
        select: {
            id: true, createdAt: true, userId: true, restaurantId: true,
            dispatchDeliveryPartnerId: true, riderLat: true, riderLng: true,
        },
    });
    if (!row) throw new NotFoundError('Order not found');

    const partnerId = row.dispatchDeliveryPartnerId;
    const [nav, user, userOrders, restaurant, restaurantOrders, partner, partnerDelivered, history] = await Promise.all([
        neighbours(row),
        prisma.foodUser.findUnique({
            where: { id: row.userId },
            select: { id: true, name: true, phone: true, email: true, profileImage: true },
        }),
        prisma.foodOrder.count({ where: { AND: [LISTED, { userId: row.userId }] } }),
        prisma.foodRestaurant.findUnique({
            where: { id: row.restaurantId },
            select: {
                id: true, restaurantName: true, profileImage: true, ownerPhone: true, primaryContactNumber: true,
                ownerEmail: true, addressLine1: true, addressLine2: true, area: true, city: true,
                formattedAddress: true, latitude: true, longitude: true,
            },
        }),
        prisma.foodOrder.count({ where: { AND: [LISTED, { restaurantId: row.restaurantId }] } }),
        partnerId
            ? prisma.foodDeliveryPartner.findUnique({
                where: { id: partnerId },
                select: {
                    id: true, name: true, phone: true, email: true, profilePhoto: true,
                    lastLat: true, lastLng: true, lastLocationAt: true,
                },
            })
            : null,
        partnerId
            ? prisma.foodOrder.count({ where: { dispatchDeliveryPartnerId: partnerId, orderStatus: 'delivered' } })
            : 0,
        // Every step with its time, as the customer's order screen shows it.
        prisma.orderStatusHistory.findMany({
            where: { orderId: row.id },
            orderBy: { at: 'asc' },
            select: { at: true, byRole: true, from: true, to: true, note: true },
        }),
    ]);

    return {
        previousOrder: nav.previous,
        nextOrder: nav.next,
        customer: user
            ? { id: user.id, name: user.name || '', phone: user.phone, email: user.email || '', image: user.profileImage || '', orderCount: userOrders }
            : null,
        restaurant: restaurant
            ? {
                id: restaurant.id,
                name: restaurant.restaurantName,
                logo: restaurant.profileImage || '',
                phone: restaurant.primaryContactNumber || restaurant.ownerPhone || '',
                email: restaurant.ownerEmail || '',
                address: restaurantAddress(restaurant),
                location: point(restaurant.latitude, restaurant.longitude, null, 'restaurant'),
                orderCount: restaurantOrders,
            }
            : null,
        deliveryPartner: partner
            ? {
                id: partner.id,
                name: partner.name,
                phone: partner.phone,
                email: partner.email || '',
                image: partner.profilePhoto || '',
                deliveredCount: partnerDelivered,
            }
            : null,
        lastLocation: partner ? pickLastLocation(partner, row) : null,
        timeline: history.map((h) => ({ at: h.at, by: h.byRole || 'SYSTEM', from: h.from || '', to: h.to || '', note: h.note || '' })),
    };
}
