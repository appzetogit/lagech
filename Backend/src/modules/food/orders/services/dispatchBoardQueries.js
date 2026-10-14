/**
 * The order queries behind the admin dispatch board, kept apart from the
 * service so they can be checked without a database.
 */

/** The restaurant has the order and it has no rider who accepted it yet. */
const WAITING_STATUSES = ['confirmed', 'preparing', 'ready_for_pickup'];
/** A rider has it and it has not been delivered. */
const ON_THE_WAY_STATUSES = ['confirmed', 'preparing', 'ready_for_pickup', 'reached_pickup', 'picked_up', 'reached_drop'];

const ORDER_SELECT = {
    id: true, orderId: true, orderStatus: true, dispatchStatus: true, paymentMethod: true, total: true,
    createdAt: true, dispatchAssignedAt: true, dispatchAcceptedAt: true, pickedUpAt: true,
    userId: true, customerName: true, customerPhone: true, addrStreet: true, addrCity: true, distanceKm: true,
    restaurant: { select: { id: true, restaurantName: true, area: true, city: true } },
    deliveryPartner: { select: { id: true, name: true, phone: true } },
};

/**
 * The two order queries of the board. Both read newest first, like every other
 * order list (and the old panel): a new order lands on top, and the take never
 * drops the newest ones.
 */
export function dispatchBoardOrderQueries(now = new Date()) {
    return {
        waiting: {
            // Never a takeaway (no rider), nor a scheduled order before its release time.
            where: {
                orderStatus: { in: WAITING_STATUSES }, dispatchStatus: { not: 'accepted' },
                orderType: { not: 'takeaway' },
                OR: [{ releaseAt: null }, { releaseAt: { lte: now } }],
            },
            orderBy: { createdAt: 'desc' },
            select: ORDER_SELECT,
            take: 200,
        },
        onTheWay: {
            where: { orderStatus: { in: ON_THE_WAY_STATUSES }, dispatchStatus: 'accepted' },
            orderBy: { createdAt: 'desc' },
            select: ORDER_SELECT,
            take: 200,
        },
    };
}
