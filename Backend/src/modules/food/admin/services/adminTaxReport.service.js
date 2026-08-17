import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { ValidationError } from '../../../../core/auth/errors.js';
import {
    isRestaurantEarnedOrder,
    computeRestaurantOrderShare,
    orderMoney,
} from '../../shared/restaurantPayout.util.js';

/**
 * Tax owed per restaurant, and the orders behind each figure.
 *
 * `taxRate` and `calculateTax` let an accountant re-run the report at a rate
 * other than the one charged at checkout — useful when a rate changes and the
 * question is what would have been owed.
 */

const rupees = (value) => `₹${(Number(value) || 0).toFixed(2)}`;

/** The order columns both reports read: earned-status, money, identity. */
const TAX_ORDER_SELECT = {
    id: true, orderId: true, restaurantId: true, createdAt: true,
    orderStatus: true, deliveryPhase: true,
    subtotal: true, packagingFee: true, restaurantCommission: true,
    discount: true, couponCode: true, tax: true,
};

function buildTaxReportDateMatch(fromDate, toDate) {
    const createdAt = {};
    if (fromDate) createdAt.gte = new Date(fromDate);
    if (toDate) {
        const end = new Date(toDate);
        if (!Number.isNaN(end.getTime())) {
            // Inclusive of the whole closing day.
            end.setHours(23, 59, 59, 999);
            createdAt.lte = end;
        }
    }
    return Object.keys(createdAt).length > 0 ? createdAt : null;
}

function shouldRecalculateTaxAtRate(taxRate, calculateTax) {
    const rate = Number(taxRate);
    const mode = String(calculateTax || 'percentage').toLowerCase().replace(/\s+/g, '_');
    return Number.isFinite(rate) && rate > 0 && mode === 'percentage';
}

/** What was charged, or what the requested rate would have charged. */
function computeOrderTaxAmount(money = {}, taxRate, calculateTax) {
    if (shouldRecalculateTaxAtRate(taxRate, calculateTax)) {
        const taxable = Math.max(0, (Number(money.subtotal) || 0) - (Number(money.discount) || 0));
        return Math.round(taxable * (Number(taxRate) / 100));
    }
    return Number(money.tax) || 0;
}

/**
 * Offers each restaurant's orders could have used, keyed by restaurant.
 *
 * One query for the whole batch: a platform-wide offer applies to everyone, so
 * asking per restaurant would fetch the same rows over and over.
 */
async function loadOffersByRestaurantIds(restaurantIds = []) {
    const uniqueIds = [...new Set((restaurantIds || []).map(String))].filter(isId);
    if (!uniqueIds.length) return new Map();

    const offers = await prisma.foodOffer.findMany({
        where: {
            OR: [
                { restaurantScope: { not: 'selected' } },
                { restaurantId: { in: uniqueIds } },
                { restaurantIds: { hasSome: uniqueIds } },
            ],
        },
    });

    const byRestaurantId = new Map();
    for (const restaurantId of uniqueIds) {
        byRestaurantId.set(restaurantId, offers.filter((offer) => {
            if (offer.restaurantScope !== 'selected') return true;
            const selected = offer.restaurantIds?.length
                ? offer.restaurantIds
                : [offer.restaurantId].filter(Boolean);
            return selected.some((id) => String(id) === restaurantId);
        }));
    }
    return byRestaurantId;
}

/** The transaction snapshot for each order, where one exists. */
const loadTransactions = async (orderIds) => {
    if (!orderIds.length) return new Map();
    const rows = await prisma.foodTransaction.findMany({ where: { orderId: { in: orderIds } } });
    return new Map(rows.map((tx) => [tx.orderId, tx]));
};

async function summarizeRestaurantEarningsForTaxReport(orders = [], { taxRate, calculateTax } = {}) {
    const earnedOrders = orders.filter(isRestaurantEarnedOrder);
    if (!earnedOrders.length) return { grouped: new Map(), totalEarnings: 0, totalTax: 0 };

    const [txByOrderId, offersByRestaurantId] = await Promise.all([
        loadTransactions(earnedOrders.map((order) => order.id)),
        loadOffersByRestaurantIds(earnedOrders.map((order) => order.restaurantId)),
    ]);

    const grouped = new Map();
    let totalEarnings = 0;
    let totalTax = 0;

    for (const order of earnedOrders) {
        const { restaurantId } = order;
        const money = orderMoney(order, txByOrderId.get(order.id));
        const offers = offersByRestaurantId.get(restaurantId) || [];

        const earnings = computeRestaurantOrderShare(money, offers, restaurantId);
        const taxAmount = computeOrderTaxAmount(money, taxRate, calculateTax);

        if (!grouped.has(restaurantId)) {
            grouped.set(restaurantId, { totalEarnings: 0, totalTax: 0, orderCount: 0 });
        }
        const bucket = grouped.get(restaurantId);
        bucket.totalEarnings += earnings;
        bucket.totalTax += taxAmount;
        bucket.orderCount += 1;

        totalEarnings += earnings;
        totalTax += taxAmount;
    }

    return { grouped, totalEarnings, totalTax };
}

export async function getTaxReport(query = {}) {
    const { fromDate, toDate, search, taxRate, calculateTax } = query;

    const where = { orderStatus: { not: 'pending_payment' } };
    const createdAt = buildTaxReportDateMatch(fromDate, toDate);
    if (createdAt) where.createdAt = createdAt;
    if (search && String(search).trim()) {
        where.orderId = { contains: String(search).trim(), mode: 'insensitive' };
    }

    const orders = await prisma.foodOrder.findMany({ where, select: TAX_ORDER_SELECT });
    const { grouped, totalEarnings, totalTax } = await summarizeRestaurantEarningsForTaxReport(
        orders,
        { taxRate, calculateTax },
    );

    const restaurants = grouped.size
        ? await prisma.foodRestaurant.findMany({
            where: { id: { in: [...grouped.keys()] } },
            select: { id: true, restaurantName: true },
        })
        : [];
    const nameById = new Map(restaurants.map((row) => [row.id, row.restaurantName]));

    const reports = [...grouped.entries()]
        .map(([restaurantId, item]) => ({
            id: restaurantId,
            incomeSource: nameById.get(restaurantId) || 'Unknown Restaurant',
            totalIncome: item.totalEarnings,
            totalTax: item.totalTax,
            orderCount: item.orderCount,
        }))
        // Biggest tax bill first — that is the row an accountant looks at.
        .sort((a, b) => b.totalTax - a.totalTax)
        .map((item, index) => ({
            sl: index + 1,
            id: item.id,
            incomeSource: item.incomeSource,
            totalIncome: rupees(item.totalIncome),
            totalTax: rupees(item.totalTax),
            orderCount: item.orderCount,
        }));

    return {
        reports,
        stats: { totalIncome: rupees(totalEarnings), totalTax: rupees(totalTax) },
    };
}

export async function getTaxReportDetail(restaurantId, query = {}) {
    if (!isId(restaurantId)) throw new ValidationError('Invalid restaurant ID');
    const rid = String(restaurantId);

    const { fromDate, toDate, taxRate, calculateTax } = query;
    const where = { restaurantId: rid, orderStatus: { not: 'pending_payment' } };
    const createdAt = buildTaxReportDateMatch(fromDate, toDate);
    if (createdAt) where.createdAt = createdAt;

    const orders = await prisma.foodOrder.findMany({
        where,
        select: TAX_ORDER_SELECT,
        orderBy: { createdAt: 'desc' },
    });
    const earnedOrders = orders.filter(isRestaurantEarnedOrder);

    const [txByOrderId, offersByRestaurantId, restaurant] = await Promise.all([
        loadTransactions(earnedOrders.map((order) => order.id)),
        loadOffersByRestaurantIds([rid]),
        prisma.foodRestaurant.findUnique({
            where: { id: rid },
            select: { restaurantName: true },
        }),
    ]);
    const offers = offersByRestaurantId.get(rid) || [];

    return {
        restaurantName: restaurant?.restaurantName || 'Unknown Restaurant',
        orders: earnedOrders.map((order) => {
            const money = orderMoney(order, txByOrderId.get(order.id));
            return {
                id: order.id,
                orderId: order.orderId,
                totalAmount: rupees(computeRestaurantOrderShare(money, offers, rid)),
                taxAmount: rupees(computeOrderTaxAmount(money, taxRate, calculateTax)),
                date: order.createdAt,
            };
        }),
    };
}
