import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';

/**
 * The two money reports the admin panel exports: every transaction, and a
 * per-restaurant roll-up.
 *
 * Both are scoped to orders that represent real money — a customer who
 * abandoned checkout must not appear in either.
 */

/**
 * Orders that count. The Mongo filter also listed the payment statuses
 * 'captured' and 'settled', which belong to the transaction's own lifecycle
 * and were never order statuses, so they matched nothing.
 */
const REAL_ORDER_SQL = {
    OR: [
        { paymentMethod: { in: ['cash', 'wallet'] } },
        { paymentStatus: { in: ['paid', 'authorized', 'refunded'] } },
    ],
};

const num = (value) => Number(value) || 0;
const formatCurrency = (value) => `₹${num(value).toFixed(2)}`;

/** A zone named by id, or by either of its two name columns. */
async function resolveZoneId(zoneRaw) {
    const value = String(zoneRaw || '').trim();
    if (!value) return undefined;
    if (isId(value)) return value;

    const zone = await prisma.foodZone.findFirst({
        where: { OR: [{ name: value }, { zoneName: value }] },
        select: { id: true },
    });
    return zone?.id ?? null; // null = named a zone that does not exist
}

export async function getTransactionReport(query = {}) {
    const { fromDate, toDate, zone, restaurant, search } = query;
    const where = {};

    if (fromDate && toDate) {
        where.createdAt = { gte: new Date(fromDate), lte: new Date(toDate) };
    }

    if (search && String(search).trim()) {
        // The readable id lives on the order, not the transaction. The Mongo
        // version also looked for `orderReadableId` on the transaction, which
        // is not a field there, so that half of the search never matched.
        where.order = { orderId: { contains: String(search).trim(), mode: 'insensitive' } };
    }

    if (zone || restaurant) {
        const restaurantWhere = {};
        let impossible = false;

        if (zone) {
            const zoneId = await resolveZoneId(zone);
            if (zoneId === null) impossible = true;
            else if (zoneId) restaurantWhere.zoneId = zoneId;
        }

        if (!impossible && restaurant && restaurant !== 'All restaurants') {
            const value = String(restaurant).trim();
            if (value) {
                const match = isId(value)
                    ? await prisma.foodRestaurant.findUnique({ where: { id: value }, select: { id: true } })
                    : await prisma.foodRestaurant.findFirst({
                        where: { restaurantName: value },
                        select: { id: true },
                    });
                if (match) restaurantWhere.id = match.id;
                else impossible = true;
            }
        }

        // A filter that names something that does not exist returns nothing,
        // rather than quietly returning everything.
        if (impossible) where.restaurantId = { in: [] };
        else if (Object.keys(restaurantWhere).length) where.restaurant = restaurantWhere;
    }

    // A page, not the table. This used to fetch and return every transaction
    // ever recorded — the response grew without bound and the summing below ran
    // over all of it in Node.
    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 100, 1), 500);

    // Which rows count as money in, and which as money back out. Expressed once
    // so the summary and any later filter cannot drift apart.
    const COMPLETED = {
        OR: [
            // 'settled' was in this list too, but it is not a FoodTxnStatus —
            // settleRestaurant() writes 'captured' and records the settlement
            // as a history entry, so the extra value matched nothing in Mongo
            // and throws outright here.
            { status: 'captured' },
            { order: { orderStatus: 'delivered' } },
        ],
    };
    const REFUNDED = {
        OR: [
            { status: 'refunded' },
            { order: { orderStatus: 'cancelled_by_admin' } },
        ],
    };

    const [transactionRows, total, completed, refunded] = await Promise.all([
        prisma.foodTransaction.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            skip: (page - 1) * limit,
            take: limit,
            include: {
                order: { select: { orderId: true, orderStatus: true } },
                restaurant: { select: { restaurantName: true } },
            },
        }),
        prisma.foodTransaction.count({ where }),
        // Summed by the database over the whole filter, not over the page.
        prisma.foodTransaction.aggregate({
            where: { AND: [where, COMPLETED] },
            _sum: {
                totalCustomerPaid: true, platformNetProfit: true,
                restaurantShare: true, riderShare: true,
            },
        }),
        prisma.foodTransaction.aggregate({
            where: { AND: [where, REFUNDED] },
            _sum: { totalCustomerPaid: true },
        }),
    ]);

    // The user is not a relation on the transaction, so the names come from one
    // extra query rather than one per row.
    const users = transactionRows.length
        ? await prisma.foodUser.findMany({
            where: { id: { in: [...new Set(transactionRows.map((tx) => tx.userId))] } },
            select: { id: true, name: true },
        })
        : [];
    const nameByUserId = new Map(users.map((u) => [u.id, u.name]));

    const transactions = transactionRows.map((tx) => {
        const subtotal = num(tx.subtotal);
        const packagingFee = num(tx.packagingFee);
        const deliveryFee = num(tx.deliveryFee);
        const tax = num(tx.tax);
        const discount = num(tx.discount);
        const total = num(tx.total);

        // The column is non-nullable and defaults to 0, so an order written
        // before the fee was recorded is indistinguishable from a genuinely
        // free one. Both are handled by the pricing equation:
        //   total = subtotal + packaging + delivery + platformFee + tax − discount
        // which returns 0 when the fee really was zero, and the missing amount
        // when the totals do not add up without one.
        const platformFee = num(tx.platformFee)
            || Math.max(0, total - subtotal - packagingFee - deliveryFee - tax + discount);

        return {
            id: tx.id,
            orderId: tx.order?.orderId || 'N/A',
            restaurant: tx.restaurant?.restaurantName || 'N/A',
            customerName: nameByUserId.get(tx.userId) || 'Guest',
            totalItemAmount: subtotal,
            itemDiscount: discount,
            couponDiscount: discount,
            adminDiscountShare: num(tx.adminDiscountShare),
            restaurantDiscountShare: num(tx.restaurantDiscountShare),
            referralDiscount: 0, // Placeholder
            discountedAmount: Math.max(0, subtotal - discount),
            vatTax: num(tx.taxAmount) || tax,
            deliveryCharge: deliveryFee,
            platformFee,
            orderAmount: num(tx.totalCustomerPaid) || total,
            status: tx.status,
        };
    });

    const summary = {
        completedTransaction: num(completed._sum.totalCustomerPaid),
        refundedTransaction: num(refunded._sum.totalCustomerPaid),
        adminEarning: num(completed._sum.platformNetProfit),
        restaurantEarning: num(completed._sum.restaurantShare),
        deliverymanEarning: num(completed._sum.riderShare),
    };

    return {
        transactions,
        summary,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 },
    };
}

/** The labelled ranges the report's dropdown offers. */
const parseTimeRange = (timeLabel) => {
    const value = String(timeLabel || '').trim().toLowerCase();
    if (!value || value === 'all time') return null;

    const now = new Date();
    const start = new Date(now);
    const end = new Date(now);
    end.setHours(23, 59, 59, 999);

    if (value === 'today') {
        start.setHours(0, 0, 0, 0);
    } else if (value === 'this week') {
        // Weeks start on Monday here, unlike the dashboard's Sunday.
        const day = start.getDay();
        start.setDate(start.getDate() - (day === 0 ? 6 : day - 1));
        start.setHours(0, 0, 0, 0);
    } else if (value === 'this month') {
        start.setDate(1);
        start.setHours(0, 0, 0, 0);
    } else if (value === 'this year') {
        start.setMonth(0, 1);
        start.setHours(0, 0, 0, 0);
    } else {
        return null;
    }

    return { gte: start, lte: end };
};

export async function getRestaurantReport(query = {}) {
    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 1000, 1), 5000);
    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    const skip = (page - 1) * limit;

    const empty = { restaurants: [], total: 0, page, limit };
    const where = {};

    const allFilter = String(query.all || '').trim().toLowerCase();
    if (allFilter === 'active') where.status = 'approved';
    else if (allFilter === 'inactive') where.status = { not: 'approved' };

    if (String(query.zone || '').trim()) {
        const zoneId = await resolveZoneId(query.zone);
        if (zoneId === null) return empty;
        where.zoneId = zoneId;
    }

    if (String(query.type || '').trim().toLowerCase() === 'commission') {
        const rows = await prisma.foodRestaurantCommission.findMany({
            where: { status: true },
            select: { restaurantId: true },
        });
        if (!rows.length) return empty;
        where.id = { in: rows.map((row) => row.restaurantId).filter(Boolean) };
    }

    const search = String(query.search || '').trim();
    if (search) {
        const contains = { contains: search, mode: 'insensitive' };
        where.OR = [
            { restaurantName: contains },
            { ownerName: contains },
            { ownerPhone: contains },
            { city: contains },
            { area: contains },
        ];
    }

    const [restaurants, total] = await Promise.all([
        prisma.foodRestaurant.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            skip,
            take: limit,
            select: {
                id: true, restaurantName: true, profileImage: true,
                rating: true, totalRatings: true, status: true,
                zone: { select: { name: true, zoneName: true } },
            },
        }),
        prisma.foodRestaurant.count({ where }),
    ]);

    if (!restaurants.length) return { ...empty, total };

    const restaurantIds = restaurants.map((r) => r.id);

    // An explicit date range wins over the labelled dropdown.
    const createdAt = (() => {
        if (query.fromDate || query.toDate) {
            const range = {};
            if (query.fromDate) range.gte = new Date(query.fromDate);
            if (query.toDate) range.lte = new Date(query.toDate);
            return Object.keys(range).length ? range : null;
        }
        return parseTimeRange(query.time);
    })();

    const orderWhere = { restaurantId: { in: restaurantIds }, ...REAL_ORDER_SQL };
    if (createdAt) orderWhere.createdAt = createdAt;

    const [foodCounts, orderTotals] = await Promise.all([
        prisma.foodItem.groupBy({
            by: ['restaurantId'],
            where: { restaurantId: { in: restaurantIds }, approvalStatus: 'approved' },
            _count: { _all: true },
        }),
        prisma.foodOrder.groupBy({
            by: ['restaurantId'],
            where: orderWhere,
            _count: { _all: true },
            _sum: { total: true, discount: true, tax: true, platformProfit: true, platformFee: true },
        }),
    ]);

    const foodByRestaurant = new Map(foodCounts.map((row) => [row.restaurantId, row._count._all]));
    const ordersByRestaurant = new Map(orderTotals.map((row) => [row.restaurantId, {
        totalOrder: row._count._all,
        totalOrderAmount: num(row._sum.total),
        totalDiscountGiven: num(row._sum.discount),
        totalVATTAX: num(row._sum.tax),
        // The recorded profit where there is one; the flat fee is the fallback
        // for orders written before the split was stored.
        totalAdminCommission: num(row._sum.platformProfit) > 0
            ? num(row._sum.platformProfit)
            : num(row._sum.platformFee),
    }]));

    return {
        restaurants: restaurants.map((restaurant, index) => {
            const counts = ordersByRestaurant.get(restaurant.id) || {
                totalOrder: 0, totalOrderAmount: 0, totalDiscountGiven: 0,
                totalVATTAX: 0, totalAdminCommission: 0,
            };

            return {
                _id: restaurant.id,
                sl: skip + index + 1,
                icon: restaurant.profileImage || '',
                restaurantName: restaurant.restaurantName || '',
                totalFood: foodByRestaurant.get(restaurant.id) || 0,
                totalOrder: counts.totalOrder,
                totalOrderAmount: formatCurrency(counts.totalOrderAmount),
                totalDiscountGiven: formatCurrency(counts.totalDiscountGiven),
                totalAdminCommission: formatCurrency(counts.totalAdminCommission),
                totalVATTAX: formatCurrency(counts.totalVATTAX),
                averageRatings: num(restaurant.rating),
                reviews: num(restaurant.totalRatings),
                status: restaurant.status || 'pending',
                zoneName: restaurant.zone?.name || restaurant.zone?.zoneName || '',
            };
        }),
        total,
        page,
        limit,
    };
}
