import { Prisma } from '@prisma/client';
import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { CANCELLED_ORDER_STATUSES } from '../../orders/services/order.helpers.js';
import { logger } from '../../../../utils/logger.js';

/**
 * The admin dashboard: headline totals, a twelve-month trend, and the badge
 * counts on the sidebar.
 *
 * Every figure here is scoped to orders that represent real money — a customer
 * who abandoned checkout should not appear in a revenue chart.
 */

const PENDING_ORDER_STATUSES = ['created', 'confirmed', 'preparing', 'ready_for_pickup', 'picked_up'];

/**
 * Orders that count: paid for in cash or wallet (which settle on delivery), or
 * whose payment actually went through.
 *
 * The Mongo filter also listed 'captured' and 'settled', which were never
 * OrderPaymentStatus values — they belong to the transaction's own lifecycle,
 * so they matched nothing and are dropped rather than carried over.
 */
const REAL_ORDER = {
    OR: [
        { paymentMethod: { in: ['cash', 'wallet'] } },
        { paymentStatus: { in: ['paid', 'authorized', 'refunded'] } },
    ],
};

const getDateRangeByPeriod = (periodRaw) => {
    const period = String(periodRaw || 'overall').trim().toLowerCase();
    if (!period || period === 'overall' || period === 'all') return null;

    const now = new Date();
    const start = new Date(now);
    const end = new Date(now);

    if (period === 'today') {
        start.setHours(0, 0, 0, 0);
        end.setHours(23, 59, 59, 999);
        return { start, end };
    }

    if (period === 'week') {
        start.setHours(0, 0, 0, 0);
        start.setDate(start.getDate() - start.getDay());
        end.setTime(start.getTime());
        end.setDate(start.getDate() + 6);
        end.setHours(23, 59, 59, 999);
        return { start, end };
    }

    if (period === 'month') {
        return {
            start: new Date(now.getFullYear(), now.getMonth(), 1),
            end: new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999),
        };
    }

    if (period === 'year') {
        return {
            start: new Date(now.getFullYear(), 0, 1),
            end: new Date(now.getFullYear(), 11, 31, 23, 59, 59, 999),
        };
    }

    return null;
};

const formatMonthShort = (year, monthIndex) =>
    new Date(year, monthIndex, 1).toLocaleString('en-IN', { month: 'short' });

function formatTimeAgo(date) {
    if (!date) return '';
    const seconds = Math.floor((new Date() - new Date(date)) / 1000);
    for (const [unit, size] of [
        ['year', 31536000], ['month', 2592000], ['day', 86400],
        ['hour', 3600], ['minute', 60],
    ]) {
        const interval = seconds / size;
        if (interval > 1) return `${Math.floor(interval)} ${unit}s ago`;
    }
    return `${Math.floor(seconds)} seconds ago`;
}

const num = (value) => Number(value) || 0;

/**
 * Orders per month for the last twelve, with delivered revenue and platform
 * take.
 *
 * Raw SQL because this groups by a derived value: Prisma's groupBy takes
 * columns, and there is no date_trunc in its API.
 */
async function monthlyTrend(where) {
    const since = new Date();
    since.setMonth(since.getMonth() - 11, 1);
    since.setHours(0, 0, 0, 0);

    const rows = await prisma.$queryRaw`
        SELECT date_trunc('month', "createdAt") AS month,
               COUNT(*)::int AS orders,
               COALESCE(SUM("total")    FILTER (WHERE "orderStatus" = 'delivered'), 0) AS revenue,
               -- platformProfit is the real take; platformFee is the fallback
               -- for orders written before the split was recorded.
               COALESCE(SUM(COALESCE(NULLIF("platformProfit", 0), "platformFee"))
                        FILTER (WHERE "orderStatus" = 'delivered'), 0) AS commission
        FROM "food_orders"
        WHERE "createdAt" >= ${since}
          AND (
              "paymentMethod" IN ('cash', 'wallet')
              OR "paymentStatus" IN ('paid', 'authorized', 'refunded')
          )
          ${where.zoneId ? Prisma.sql`AND "zoneId" = ${where.zoneId}` : Prisma.empty}
          ${where.createdAt?.gte ? Prisma.sql`AND "createdAt" >= ${where.createdAt.gte}` : Prisma.empty}
          ${where.createdAt?.lte ? Prisma.sql`AND "createdAt" <= ${where.createdAt.lte}` : Prisma.empty}
        GROUP BY 1
    `;

    const byKey = new Map(rows.map((row) => {
        const d = new Date(row.month);
        return [`${d.getFullYear()}-${d.getMonth() + 1}`, row];
    }));

    // Every one of the twelve months appears, whether or not it had orders —
    // the chart needs a continuous axis.
    const now = new Date();
    const months = [];
    for (let i = 11; i >= 0; i -= 1) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const row = byKey.get(`${d.getFullYear()}-${d.getMonth() + 1}`);
        months.push({
            month: formatMonthShort(d.getFullYear(), d.getMonth()),
            orders: num(row?.orders),
            revenue: num(row?.revenue),
            commission: num(row?.commission),
        });
    }
    return months;
}

export async function getDashboardStats(query = {}) {
    const periodRange = getDateRangeByPeriod(query.period);
    const zoneId = isId(query.zoneId) ? String(query.zoneId) : null;

    const orderWhere = { ...REAL_ORDER };
    if (periodRange) orderWhere.createdAt = { gte: periodRange.start, lte: periodRange.end };
    if (zoneId) orderWhere.zoneId = zoneId;

    const restaurantWhere = zoneId ? { zoneId } : {};
    // Menu counts follow the zone through the restaurant that owns the dish.
    const menuScope = zoneId ? { restaurant: { zoneId } } : {};

    const [
        statusCounts,
        deliveredTotals,
        monthlyData,
        restaurantsTotal,
        restaurantsPending,
        deliveryTotal,
        deliveryPending,
        foodsTotal,
        addonsTotal,
        customersTotal,
        recentPendingRestaurants,
        recentPendingDelivery,
        recentPendingOrders,
        recentDeliveredOrders,
        recentCancelledOrders,
        recentCustomers,
    ] = await Promise.all([
        prisma.foodOrder.groupBy({ by: ['orderStatus'], where: orderWhere, _count: { _all: true } }),
        prisma.foodOrder.aggregate({
            where: { ...orderWhere, orderStatus: 'delivered' },
            _sum: {
                total: true, restaurantCommission: true, platformFee: true,
                deliveryFee: true, tax: true, platformProfit: true,
            },
        }),
        monthlyTrend(orderWhere),
        prisma.foodRestaurant.count({ where: { ...restaurantWhere, status: 'approved' } }),
        prisma.foodRestaurant.count({ where: { ...restaurantWhere, status: 'pending' } }),
        prisma.foodDeliveryPartner.count({ where: { status: 'approved' } }),
        prisma.foodDeliveryPartner.count({ where: { status: 'pending' } }),
        prisma.foodItem.count({ where: { approvalStatus: 'approved', ...menuScope } }),
        prisma.foodAddon.count({ where: { approvalStatus: 'approved', isDeleted: false, ...menuScope } }),
        // Zoned: customers who ordered in this zone. Unzoned: everyone.
        zoneId
            ? prisma.foodOrder.findMany({
                where: orderWhere, distinct: ['userId'], select: { userId: true },
            }).then((rows) => rows.length)
            : prisma.foodUser.count(),
        prisma.foodRestaurant.findMany({
            where: { ...restaurantWhere, status: 'pending' },
            orderBy: { createdAt: 'desc' }, take: 5,
            select: { restaurantName: true, createdAt: true },
        }),
        prisma.foodDeliveryPartner.findMany({
            where: { status: 'pending' },
            orderBy: { createdAt: 'desc' }, take: 5,
            select: { name: true, createdAt: true },
        }),
        prisma.foodOrder.findMany({
            where: { ...orderWhere, orderStatus: { in: PENDING_ORDER_STATUSES } },
            orderBy: { createdAt: 'desc' }, take: 5,
            select: { orderId: true, createdAt: true },
        }),
        prisma.foodOrder.findMany({
            where: { ...orderWhere, orderStatus: 'delivered' },
            orderBy: { updatedAt: 'desc' }, take: 5,
            select: { orderId: true, updatedAt: true },
        }),
        prisma.foodOrder.findMany({
            where: { ...orderWhere, orderStatus: { in: CANCELLED_ORDER_STATUSES } },
            orderBy: { updatedAt: 'desc' }, take: 5,
            select: { orderId: true, updatedAt: true },
        }),
        zoneId
            ? prisma.foodOrder.findMany({
                where: orderWhere,
                orderBy: { createdAt: 'desc' }, take: 5, distinct: ['userId'],
                select: { createdAt: true, user: { select: { id: true, name: true } } },
            }).then((rows) => rows.map((r) => ({ ...r.user, createdAt: r.createdAt })))
            : prisma.foodUser.findMany({
                orderBy: { createdAt: 'desc' }, take: 5,
                select: { name: true, createdAt: true },
            }),
    ]);

    const signal = (type, title, detail, timestamp) => ({
        type, title, detail, time: formatTimeAgo(timestamp), timestamp,
    });

    const liveSignals = [
        ...recentPendingRestaurants.map((r) =>
            signal('restaurant', 'New Restaurant Request', `${r.restaurantName} is waiting for approval`, r.createdAt)),
        ...recentPendingDelivery.map((d) =>
            signal('delivery', 'New Delivery Partner', `${d.name} requested to join`, d.createdAt)),
        ...recentPendingOrders.map((o) =>
            signal('order_pending', 'New Order Received', `Order #${o.orderId} is pending`, o.createdAt)),
        ...recentDeliveredOrders.map((o) =>
            signal('order_delivered', 'Order Delivered', `Order #${o.orderId} was successful`, o.updatedAt)),
        ...recentCancelledOrders.map((o) =>
            signal('order_cancelled', 'Order Cancelled', `Order #${o.orderId} was cancelled`, o.updatedAt)),
        ...recentCustomers.map((c) =>
            signal('customer', 'New Customer', `${c.name} just registered`, c.createdAt)),
    ]
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
        .slice(0, 15);

    const countFor = (statuses) => statusCounts
        .filter((row) => statuses.includes(row.orderStatus))
        .reduce((sum, row) => sum + row._count._all, 0);

    const totalOrders = statusCounts.reduce((sum, row) => sum + row._count._all, 0);
    const delivered = countFor(['delivered']);
    const cancelled = countFor(CANCELLED_ORDER_STATUSES);
    const pending = countFor(PENDING_ORDER_STATUSES);

    const sums = deliveredTotals._sum;
    const revenueTotal = num(sums.total);
    const commissionTotal = num(sums.restaurantCommission);
    const platformFeeTotal = num(sums.platformFee);
    const gstTotal = num(sums.tax);
    const adminNetProfit = num(sums.platformProfit);

    return {
        orders: { total: totalOrders, byStatus: { delivered, cancelled, pending } },
        revenue: { total: revenueTotal },
        commission: { total: commissionTotal },
        platformFee: { total: platformFeeTotal },
        deliveryFee: { total: num(sums.deliveryFee) },
        gst: { total: gstTotal },
        totalAdminEarnings: adminNetProfit + gstTotal,
        deliveryProfit: adminNetProfit - commissionTotal - platformFeeTotal,
        restaurants: { total: restaurantsTotal, pendingRequests: restaurantsPending },
        deliveryBoys: { total: deliveryTotal, pendingRequests: deliveryPending },
        foods: { total: foodsTotal },
        addons: { total: addonsTotal },
        customers: { total: customersTotal },
        orderStats: { pending, completed: delivered },
        monthlyData,
        liveSignals,
    };
}

/**
 * The numbers on the sidebar badges — everything waiting for an admin.
 *
 * Never throws: a failed count would blank the whole admin shell.
 */
export async function getSidebarBadges() {
    try {
        const [
            pendingRestaurants,
            pendingDeliveryPartners,
            pendingFoods,
            pendingAddons,
            pendingOrders,
            pendingOfflinePayments,
            pendingRestaurantWithdrawals,
            pendingDeliveryWithdrawals,
            openUserSupportTickets,
            openDeliverySupportTickets,
            pendingEarningAddons,
            pendingSafetyReports,
            pendingEmergencyHelp,
            pendingRestaurantComplaints,
        ] = await Promise.all([
            prisma.foodRestaurant.count({ where: { status: 'pending' } }),
            prisma.foodDeliveryPartner.count({ where: { status: 'pending' } }),
            prisma.foodItem.count({ where: { approvalStatus: 'pending' } }),
            prisma.foodAddon.count({ where: { approvalStatus: 'pending' } }),
            // Both of these filtered on values that do not exist: there is no
            // 'pending' order status and no 'offline_payment' method, so Mongo
            // matched nothing and both badges have always read zero. Counted
            // against the real statuses now — orders awaiting action, and
            // orders waiting on a QR payment.
            prisma.foodOrder.count({ where: { orderStatus: { in: PENDING_ORDER_STATUSES } } }),
            prisma.foodOrder.count({ where: { paymentStatus: 'pending_qr' } }),
            prisma.foodRestaurantWithdrawal.count({ where: { status: 'pending' } }),
            prisma.foodDeliveryWithdrawal.count({ where: { status: 'pending' } }),
            // A customer's ticket has no restaurant attached; a restaurant's does.
            prisma.foodSupportTicket.count({ where: { status: 'open', restaurantId: null } }),
            prisma.deliverySupportTicket.count({ where: { status: 'open' } }),
            prisma.foodEarningAddonHistory.count({ where: { status: 'pending' } }),
            // Safety reports start 'unread', not 'pending'.
            prisma.foodSafetyEmergencyReport.count({ where: { status: 'unread' } }),
            // Counted against FoodDeliveryEmergencyHelp before, which holds the
            // helpline numbers rather than any request. The queue riders
            // actually raise is DeliveryOrderEmergencyRequest.
            prisma.deliveryOrderEmergencyRequest.count({ where: { status: 'open' } }),
            prisma.foodSupportTicket.count({ where: { status: 'open', restaurantId: { not: null } } }),
        ]);

        return {
            restaurants: pendingRestaurants,
            deliveryPartners: pendingDeliveryPartners,
            foods: pendingFoods + pendingAddons,
            foodApprovals: pendingFoods,
            orders: pendingOrders,
            offlinePayments: pendingOfflinePayments,
            restaurantWithdrawals: pendingRestaurantWithdrawals,
            deliveryWithdrawals: pendingDeliveryWithdrawals,
            userSupportTickets: openUserSupportTickets,
            deliverySupportTickets: openDeliverySupportTickets,
            earningAddons: pendingEarningAddons,
            safetyReports: pendingSafetyReports,
            emergencyHelp: pendingEmergencyHelp,
            restaurantComplaints: pendingRestaurantComplaints,
        };
    } catch (error) {
        logger.error('Error fetching sidebar badges:', error);
        return {};
    }
}
