import { Prisma } from '@prisma/client';
import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { ValidationError } from '../../../../core/auth/errors.js';
import {
    computeRestaurantOrderShare,
    orderMoney,
} from '../../shared/restaurantPayout.util.js';
import {
    EARNED_ORDER,
    RESTAURANT_SHARE,
    ORDERS_JOINED,
    shareOverCountByRestaurant,
} from '../../shared/restaurantPayout.sql.js';

/**
 * Tax owed per restaurant, and the orders behind each figure.
 *
 * `taxRate` and `calculateTax` let an accountant re-run the report at a rate
 * other than the one charged at checkout — useful when a rate changes and the
 * question is what would have been owed.
 */

const num = (value) => Number(value) || 0;
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

/**
 * The tax on one order, as SQL — twin of computeOrderTaxAmount() below.
 *
 * When a rate override is asked for the figure is recomputed from the taxable
 * base; otherwise it is whatever was charged at checkout.
 */
const taxAmountSql = (taxRate, calculateTax) => (
    shouldRecalculateTaxAtRate(taxRate, calculateTax)
        ? Prisma.sql`ROUND(GREATEST(0, COALESCE(t."subtotal", o."subtotal") - COALESCE(t."discount", o."discount")) * ${Number(taxRate) / 100})`
        : Prisma.sql`COALESCE(t."tax", o."tax")`
);

/** The shared filter: real orders, in the window, optionally one restaurant. */
const taxScopeSql = ({ restaurantId = null, createdAt = null, search = null }) => Prisma.sql`
    WHERE o."orderStatus" <> 'pending_payment'
      AND ${EARNED_ORDER}
      ${restaurantId ? Prisma.sql`AND o."restaurantId" = ${restaurantId}` : Prisma.empty}
      ${createdAt?.gte ? Prisma.sql`AND o."createdAt" >= ${createdAt.gte}` : Prisma.empty}
      ${createdAt?.lte ? Prisma.sql`AND o."createdAt" <= ${createdAt.lte}` : Prisma.empty}
      ${search ? Prisma.sql`AND o."orderId" ILIKE ${`%${search}%`}` : Prisma.empty}
`;

/** The Prisma-side twin of taxScopeSql, for the row queries and the correction. */
const taxScopeWhere = ({ restaurantId = null, createdAt = null, search = null }) => ({
    orderStatus: { not: 'pending_payment' },
    NOT: { orderStatus: { in: ['cancelled_by_user', 'cancelled_by_restaurant', 'cancelled_by_admin'] } },
    OR: [{ orderStatus: 'delivered' }, { deliveryPhase: { in: ['delivered', 'completed'] } }],
    ...(restaurantId ? { restaurantId } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(search ? { orderId: { contains: search, mode: 'insensitive' } } : {}),
});

export async function getTaxReport(query = {}) {
    const { fromDate, toDate, taxRate, calculateTax } = query;
    const search = query.search && String(query.search).trim() ? String(query.search).trim() : null;
    const createdAt = buildTaxReportDateMatch(fromDate, toDate);

    const scope = { createdAt, search };

    // Grouped by the database. This used to read every order on the platform
    // for the window into Node and bucket them there.
    const rows = await prisma.$queryRaw`
        SELECT o."restaurantId"                        AS "restaurantId",
               COUNT(*)::int                           AS "orderCount",
               COALESCE(SUM(${RESTAURANT_SHARE}), 0)   AS "earnings",
               COALESCE(SUM(${taxAmountSql(taxRate, calculateTax)}), 0) AS "tax"
        ${ORDERS_JOINED}
        ${taxScopeSql(scope)}
        GROUP BY o."restaurantId"
    `;

    if (!rows.length) {
        return { reports: [], stats: { totalIncome: rupees(0), totalTax: rupees(0) } };
    }

    const restaurantIds = rows.map((row) => row.restaurantId);
    const [restaurants, overCount] = await Promise.all([
        prisma.foodRestaurant.findMany({
            where: { id: { in: restaurantIds } },
            select: { id: true, restaurantName: true },
        }),
        shareOverCountByRestaurant(
            taxScopeWhere(scope),
            await loadOffersByRestaurantIds(restaurantIds),
        ),
    ]);
    const nameById = new Map(restaurants.map((row) => [row.id, row.restaurantName]));

    let totalEarnings = 0;
    let totalTax = 0;

    const reports = rows
        .map((row) => {
            const earnings = Math.max(0, num(row.earnings) - num(overCount.get(row.restaurantId)));
            const tax = num(row.tax);
            totalEarnings += earnings;
            totalTax += tax;
            return {
                id: row.restaurantId,
                incomeSource: nameById.get(row.restaurantId) || 'Unknown Restaurant',
                totalIncome: earnings,
                totalTax: tax,
                orderCount: row.orderCount,
            };
        })
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
    const createdAt = buildTaxReportDateMatch(fromDate, toDate);
    const where = taxScopeWhere({ restaurantId: rid, createdAt });

    // A page of orders, not the restaurant's whole history.
    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 200, 1), 1000);
    const page = Math.max(parseInt(query.page, 10) || 1, 1);

    const [orders, total, offersByRestaurantId, restaurant] = await Promise.all([
        prisma.foodOrder.findMany({
            where,
            select: TAX_ORDER_SELECT,
            orderBy: { createdAt: 'desc' },
            skip: (page - 1) * limit,
            take: limit,
        }),
        prisma.foodOrder.count({ where }),
        loadOffersByRestaurantIds([rid]),
        prisma.foodRestaurant.findUnique({ where: { id: rid }, select: { restaurantName: true } }),
    ]);

    const txByOrderId = await loadTransactions(orders.map((order) => order.id));
    const offers = offersByRestaurantId.get(rid) || [];

    return {
        restaurantName: restaurant?.restaurantName || 'Unknown Restaurant',
        orders: orders.map((order) => {
            const money = orderMoney(order, txByOrderId.get(order.id));
            return {
                id: order.id,
                orderId: order.orderId,
                totalAmount: rupees(computeRestaurantOrderShare(money, offers, rid)),
                taxAmount: rupees(computeOrderTaxAmount(money, taxRate, calculateTax)),
                date: order.createdAt,
            };
        }),
        pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 },
    };
}
