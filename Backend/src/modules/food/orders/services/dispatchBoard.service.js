import { prisma } from '../../../../config/prisma.js';
import { describeCashPosition, getCashInHandMap, getCashLimit } from '../../delivery/services/riderCash.service.js';

/**
 * The admin dispatch board: what still needs a rider, what is on the road,
 * and who is online to take it -- the old panel's "unassigned" and "ongoing"
 * lists, with the riders beside them so an admin can assign one by hand.
 */

/** The restaurant has the order and it has no rider who accepted it yet. */
const WAITING_STATUSES = ['confirmed', 'preparing', 'ready_for_pickup'];
/** A rider has it and it has not been delivered. */
const ON_THE_WAY_STATUSES = ['confirmed', 'preparing', 'ready_for_pickup', 'reached_pickup', 'picked_up', 'reached_drop'];

const minutesSince = (date) => (date ? Math.max(0, Math.round((Date.now() - new Date(date).getTime()) / 60000)) : null);

const ORDER_SELECT = {
    id: true, orderId: true, orderStatus: true, dispatchStatus: true, paymentMethod: true, total: true,
    createdAt: true, dispatchAssignedAt: true, dispatchAcceptedAt: true, pickedUpAt: true,
    customerName: true, customerPhone: true, addrStreet: true, addrCity: true, distanceKm: true,
    restaurant: { select: { id: true, restaurantName: true, area: true, city: true } },
    deliveryPartner: { select: { id: true, name: true, phone: true } },
};

const toCard = (o) => ({
    id: o.id,
    orderId: o.orderId,
    status: o.orderStatus,
    dispatchStatus: o.dispatchStatus,
    paymentMethod: o.paymentMethod,
    total: Number(o.total),
    restaurant: o.restaurant?.restaurantName || '',
    restaurantArea: o.restaurant?.area || o.restaurant?.city || '',
    customer: o.customerName,
    customerPhone: o.customerPhone,
    address: [o.addrStreet, o.addrCity].filter(Boolean).join(', '),
    distanceKm: o.distanceKm != null ? Number(o.distanceKm) : null,
    rider: o.deliveryPartner ? { id: o.deliveryPartner.id, name: o.deliveryPartner.name, phone: o.deliveryPartner.phone } : null,
    placedMinutesAgo: minutesSince(o.createdAt),
    assignedMinutesAgo: minutesSince(o.dispatchAssignedAt),
    pickedUpMinutesAgo: minutesSince(o.pickedUpAt),
});

export async function getDispatchBoard() {
    const [waiting, onTheWay, riders, limit] = await Promise.all([
        prisma.foodOrder.findMany({
            where: { orderStatus: { in: WAITING_STATUSES }, dispatchStatus: { not: 'accepted' } },
            orderBy: { createdAt: 'asc' },
            select: ORDER_SELECT,
            take: 200,
        }),
        prisma.foodOrder.findMany({
            where: { orderStatus: { in: ON_THE_WAY_STATUSES }, dispatchStatus: 'accepted' },
            orderBy: { dispatchAcceptedAt: 'asc' },
            select: ORDER_SELECT,
            take: 200,
        }),
        prisma.foodDeliveryPartner.findMany({
            where: { status: 'approved', availabilityStatus: 'online' },
            select: { id: true, name: true, phone: true, lastLocationAt: true },
            orderBy: { name: 'asc' },
        }),
        getCashLimit(),
    ]);

    const busy = new Map();
    for (const order of onTheWay) {
        const id = order.deliveryPartner?.id;
        if (id) busy.set(id, (busy.get(id) || 0) + 1);
    }
    const cash = await getCashInHandMap(riders.map((r) => r.id));

    return {
        waiting: waiting.map(toCard),
        onTheWay: onTheWay.map(toCard),
        riders: riders.map((r) => {
            const position = describeCashPosition(cash.get(r.id) || 0, limit);
            return {
                id: r.id,
                name: r.name,
                phone: r.phone,
                activeOrders: busy.get(r.id) || 0,
                cashInHand: position.cashInHand,
                cashSuspended: position.cashSuspended,
                cashLimitWarning: position.cashLimitWarning,
                lastSeenMinutesAgo: minutesSince(r.lastLocationAt),
            };
        }),
        generatedAt: new Date(),
    };
}
