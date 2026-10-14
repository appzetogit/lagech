import { prisma } from '../../../../config/prisma.js';
import { describeCashPosition, getCashInHandMap, getCashLimit } from '../../delivery/services/riderCash.service.js';
import { dispatchBoardOrderQueries } from './dispatchBoardQueries.js';

/**
 * The admin dispatch board: what still needs a rider, what is on the road,
 * and who is online to take it -- the old panel's "unassigned" and "ongoing"
 * lists, with the riders beside them so an admin can assign one by hand.
 */

const minutesSince = (date) => (date ? Math.max(0, Math.round((Date.now() - new Date(date).getTime()) / 60000)) : null);

const toCard = (o) => ({
    id: o.id,
    orderId: o.orderId,
    status: o.orderStatus,
    dispatchStatus: o.dispatchStatus,
    paymentMethod: o.paymentMethod,
    total: Number(o.total),
    restaurantId: o.restaurant?.id || null,
    restaurant: o.restaurant?.restaurantName || '',
    restaurantArea: o.restaurant?.area || o.restaurant?.city || '',
    customerId: o.userId || null,
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
    const queries = dispatchBoardOrderQueries();
    const [waiting, onTheWay, riders, limit] = await Promise.all([
        prisma.foodOrder.findMany(queries.waiting),
        prisma.foodOrder.findMany(queries.onTheWay),
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
