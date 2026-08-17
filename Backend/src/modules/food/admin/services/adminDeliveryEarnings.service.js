import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';

/**
 * What every rider earned, order by order.
 *
 * `riderEarning` is what the split actually credited. Orders written before it
 * was recorded fall back to the delivery fee, which is what the rider would
 * have been paid. (A `deliveryPartnerSettlement` fallback sat between the two
 * in the Mongo version; no such field exists on any schema, so it is gone.)
 */

const num = (value) => Number(value) || 0;

/** An explicit date range, or one of the period shortcuts. */
function buildDateRange(query = {}) {
    const range = {};

    if (query.fromDate) {
        const from = new Date(query.fromDate);
        if (!Number.isNaN(from.getTime())) {
            from.setHours(0, 0, 0, 0);
            range.gte = from;
        }
    }
    if (query.toDate) {
        const to = new Date(query.toDate);
        if (!Number.isNaN(to.getTime())) {
            to.setHours(23, 59, 59, 999);
            range.lte = to;
        }
    }
    if (range.gte || range.lte) return range;

    const now = new Date();
    const period = String(query.period || 'all').trim().toLowerCase();

    if (period === 'today') {
        const start = new Date(now);
        start.setHours(0, 0, 0, 0);
        const end = new Date(now);
        end.setHours(23, 59, 59, 999);
        return { gte: start, lte: end };
    }
    if (period === 'week') {
        const start = new Date(now);
        start.setHours(0, 0, 0, 0);
        start.setDate(start.getDate() - start.getDay()); // Sunday
        const end = new Date(start);
        end.setDate(start.getDate() + 6);
        end.setHours(23, 59, 59, 999);
        return { gte: start, lte: end };
    }
    if (period === 'month') {
        return {
            gte: new Date(now.getFullYear(), now.getMonth(), 1),
            lte: new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999),
        };
    }

    return null;
}

export async function getDeliveryEarnings(query = {}) {
    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    const limit = Math.max(1, Math.min(1000, parseInt(query.limit, 10) || 50));
    const skip = (page - 1) * limit;

    // Only dispatched orders have a rider to pay.
    const where = { dispatchDeliveryPartnerId: { not: null } };

    const createdAt = buildDateRange(query);
    if (createdAt) where.createdAt = createdAt;

    if (isId(query.deliveryPartnerId)) {
        where.dispatchDeliveryPartnerId = String(query.deliveryPartnerId);
    }

    const search = String(query.search || '').trim();
    if (search) {
        const contains = { contains: search, mode: 'insensitive' };
        // Reached through the relations rather than pre-resolving id lists.
        where.OR = [
            { orderId: contains },
            { deliveryPartner: { OR: [{ name: contains }, { phone: contains }, { email: contains }] } },
            { restaurant: { restaurantName: contains } },
        ];
    }

    const [orders, total, totals, partners] = await Promise.all([
        prisma.foodOrder.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            skip,
            take: limit,
            select: {
                id: true, orderId: true, orderStatus: true, createdAt: true,
                riderEarning: true, deliveryFee: true, total: true,
                deliveryPartner: { select: { id: true, name: true, phone: true } },
                restaurant: { select: { restaurantName: true } },
            },
        }),
        prisma.foodOrder.count({ where }),
        // Split in two so the per-order fallback is applied exactly: summing
        // both columns over all rows would double-count an order that has a
        // recorded earning, and applying the fallback to the totals would be
        // wrong for any page mixing the two.
        Promise.all([
            prisma.foodOrder.aggregate({
                where: { ...where, riderEarning: { gt: 0 } },
                _sum: { riderEarning: true },
            }),
            prisma.foodOrder.aggregate({
                where: { ...where, riderEarning: { lte: 0 } },
                _sum: { deliveryFee: true },
            }),
        ]),
        prisma.foodOrder.findMany({
            where,
            distinct: ['dispatchDeliveryPartnerId'],
            select: { dispatchDeliveryPartnerId: true },
        }),
    ]);

    const earnings = orders.map((order) => ({
        transactionId: order.id,
        orderId: order.orderId || 'N/A',
        deliveryPartnerId: order.deliveryPartner?.id || null,
        deliveryPartnerName: order.deliveryPartner?.name || 'N/A',
        deliveryPartnerPhone: order.deliveryPartner?.phone || 'N/A',
        restaurantName: order.restaurant?.restaurantName || 'N/A',
        amount: num(order.riderEarning) || num(order.deliveryFee),
        orderTotal: num(order.total),
        deliveryFee: num(order.deliveryFee),
        orderStatus: order.orderStatus || 'N/A',
        createdAt: order.createdAt,
    }));

    return {
        earnings,
        summary: {
            totalDeliveryPartners: partners.filter((p) => p.dispatchDeliveryPartnerId).length,
            totalEarnings: num(totals[0]._sum.riderEarning) + num(totals[1]._sum.deliveryFee),
            totalOrders: total,
        },
        pagination: {
            page,
            limit,
            total,
            pages: Math.ceil(total / limit) || 1,
        },
    };
}
