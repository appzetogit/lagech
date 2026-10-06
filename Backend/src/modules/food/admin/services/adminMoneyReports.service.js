import { Prisma } from '@prisma/client';
import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { parsePeriod } from './adminReports.service.js';
import { getWalletSummaries } from '../../restaurant/services/restaurantFinance.service.js';
import {
    EARNED_ORDER,
    RESTAURANT_SHARE,
    shareOverCountByRestaurant,
} from '../../shared/restaurantPayout.sql.js';

/**
 * Money reports the previous panel had: what was disbursed to restaurants,
 * what each restaurant earned, and the tax collected on each restaurant's
 * orders. All from real rows -- payout lines, orders and their transactions.
 */

const num = (value) => Math.round((Number(value) || 0) * 100) / 100;

const pageOf = (query, fallback = 50) => ({
    page: Math.max(parseInt(query.page, 10) || 1, 1),
    limit: Math.min(Math.max(parseInt(query.limit, 10) || fallback, 1), 500),
});

const restaurantSql = (restaurantId) =>
    isId(restaurantId) ? Prisma.sql`AND o."restaurantId" = ${String(restaurantId)}` : Prisma.empty;

// ─── Disbursement report ─────────────────────────────────────────────────────

/** Payout line status -> what the report calls it. */
export const DISBURSEMENT_STATUS = { pending: 'pending', approved: 'paid', rejected: 'cancelled' };

/**
 * Fold grouped payout lines ({ restaurantId, status, amount, count }) into one
 * row per restaurant. Pure, so the arithmetic is tested without a database.
 */
export function foldDisbursementLines(groups = [], names = new Map()) {
    const rows = new Map();
    for (const group of groups) {
        const key = group.restaurantId;
        const row = rows.get(key) || {
            restaurantId: key,
            restaurantName: names.get(key) || 'Unknown restaurant',
            payouts: 0,
            total: 0,
            paid: 0,
            pending: 0,
            cancelled: 0,
        };
        const bucket = DISBURSEMENT_STATUS[group.status];
        const amount = num(group.amount);
        row.payouts += Number(group.count) || 0;
        row.total = num(row.total + amount);
        if (bucket) row[bucket] = num(row[bucket] + amount);
        rows.set(key, row);
    }
    return [...rows.values()].sort((a, b) => b.total - a.total);
}

const emptyDisbursementTotals = () => ({ batches: 0, restaurants: 0, payouts: 0, total: 0, paid: 0, pending: 0, cancelled: 0 });

/**
 * What the daily payout runs disbursed to restaurants in a period: totals by
 * status, one row per restaurant, and each run. Riders are not paid by payout
 * runs in this system, so asking for them says so rather than showing zeros.
 */
export async function getDisbursementReport(query = {}) {
    const { start, end } = parsePeriod(query);
    const period = { from: start, to: end };
    const { page, limit } = pageOf(query);

    if (query.entityType === 'rider') {
        return {
            entityType: 'rider',
            supported: false,
            message: 'Riders are paid through their withdrawal requests; there are no rider payout runs yet.',
            period,
            totals: emptyDisbursementTotals(),
            rows: [],
            batches: [],
            pagination: { total: 0, page, limit, pages: 1 },
        };
    }

    const status = Object.entries(DISBURSEMENT_STATUS).find(([, label]) => label === query.status)?.[0];
    const where = {
        source: 'disbursement',
        createdAt: { gte: start, lte: end },
        ...(isId(query.restaurantId) ? { restaurantId: String(query.restaurantId) } : {}),
        ...(status ? { status } : {}),
    };

    const [grouped, batches] = await Promise.all([
        prisma.foodRestaurantWithdrawal.groupBy({
            by: ['restaurantId', 'status'],
            where,
            _sum: { amount: true },
            _count: { _all: true },
        }),
        prisma.foodRestaurantPayoutBatch.findMany({
            where: { createdAt: { gte: start, lte: end }, restaurantCount: { gt: 0 } },
            orderBy: { createdAt: 'desc' },
            take: 200,
        }),
    ]);

    const restaurantIds = [...new Set(grouped.map((g) => g.restaurantId))];
    const [restaurants, batchLines] = await Promise.all([
        restaurantIds.length
            ? prisma.foodRestaurant.findMany({ where: { id: { in: restaurantIds } }, select: { id: true, restaurantName: true } })
            : [],
        batches.length
            ? prisma.foodRestaurantWithdrawal.groupBy({
                by: ['batchId', 'status'],
                where: { batchId: { in: batches.map((b) => b.id) } },
                _sum: { amount: true },
            })
            : [],
    ]);

    let rows = foldDisbursementLines(
        grouped.map((g) => ({ restaurantId: g.restaurantId, status: g.status, amount: g._sum.amount, count: g._count._all })),
        new Map(restaurants.map((r) => [r.id, r.restaurantName])),
    );
    const search = String(query.search || '').trim().toLowerCase();
    if (search) rows = rows.filter((row) => row.restaurantName.toLowerCase().includes(search));

    const sum = (key) => num(rows.reduce((total, row) => total + row[key], 0));
    const totals = {
        batches: batches.length,
        restaurants: rows.length,
        payouts: rows.reduce((total, row) => total + row.payouts, 0),
        total: sum('total'),
        paid: sum('paid'),
        pending: sum('pending'),
        cancelled: sum('cancelled'),
    };

    const byBatch = new Map();
    for (const line of batchLines) {
        const entry = byBatch.get(line.batchId) || { paid: 0, pending: 0, cancelled: 0 };
        const bucket = DISBURSEMENT_STATUS[line.status];
        if (bucket) entry[bucket] = num(entry[bucket] + num(line._sum.amount));
        byBatch.set(line.batchId, entry);
    }

    return {
        entityType: 'restaurant',
        supported: true,
        period,
        totals,
        rows: rows.slice((page - 1) * limit, page * limit),
        batches: batches.map((b) => ({
            id: b.id,
            title: `Payout #${b.number}`,
            runDate: b.runDate,
            status: b.status,
            restaurantCount: b.restaurantCount,
            totalAmount: num(b.totalAmount),
            ...(byBatch.get(b.id) || { paid: 0, pending: 0, cancelled: 0 }),
            createdAt: b.createdAt,
        })),
        pagination: { total: rows.length, page, limit, pages: Math.ceil(rows.length / limit) || 1 },
    };
}

// ─── Restaurant earning report ───────────────────────────────────────────────

/**
 * Per restaurant, over a period: earned orders, food sales, the platform's
 * commission, what the restaurant keeps, what it was paid in the period and
 * what is waiting to be paid, plus its balance today.
 *
 * Orders are the ones that count toward a restaurant's earnings anywhere else
 * (EARNED_ORDER), and its share is the same RESTAURANT_SHARE the balance uses,
 * so this report and the restaurant's wallet cannot disagree.
 */
export async function getRestaurantEarningReport(query = {}) {
    const { start, end } = parsePeriod(query);
    const { page, limit } = pageOf(query);
    const search = String(query.search || '').trim();

    const rows = await prisma.$queryRaw`
        SELECT o."restaurantId" AS "restaurantId",
               r."restaurantName" AS restaurant,
               COUNT(*)::int AS orders,
               SUM(o."subtotal" + o."packagingFee") AS "grossSales",
               SUM(COALESCE(t."commissionAmount", o."restaurantCommission")) AS commission,
               SUM(${RESTAURANT_SHARE}) AS net,
               COUNT(*) OVER () AS "rowCount",
               SUM(COUNT(*)) OVER () AS "allOrders",
               SUM(SUM(o."subtotal" + o."packagingFee")) OVER () AS "allGross",
               SUM(SUM(COALESCE(t."commissionAmount", o."restaurantCommission"))) OVER () AS "allCommission",
               SUM(SUM(${RESTAURANT_SHARE})) OVER () AS "allNet"
          FROM food_orders o
          JOIN food_restaurants r ON r.id = o."restaurantId"
          LEFT JOIN food_transactions t ON t."orderId" = o.id
         WHERE o."orderStatus" <> 'pending_payment'
           AND ${EARNED_ORDER}
           AND o."createdAt" BETWEEN ${start} AND ${end}
           ${restaurantSql(query.restaurantId)}
           ${search ? Prisma.sql`AND r."restaurantName" ILIKE ${`%${search}%`}` : Prisma.empty}
         GROUP BY o."restaurantId", r."restaurantName"
         ORDER BY net DESC
         LIMIT ${limit} OFFSET ${(page - 1) * limit}`;

    const ids = rows.map((row) => row.restaurantId);
    const [overCount, paid, pending, wallets] = await Promise.all([
        // Orders with a discount and no transaction are over-counted by the
        // SQL share; the same correction the wallet applies.
        shareOverCountByRestaurant(
            {
                orderStatus: { not: 'pending_payment' },
                createdAt: { gte: start, lte: end },
                ...(isId(query.restaurantId) ? { restaurantId: String(query.restaurantId) } : {}),
            },
            new Map(),
        ),
        ids.length
            ? prisma.foodRestaurantWithdrawal.groupBy({
                by: ['restaurantId'],
                where: { restaurantId: { in: ids }, status: 'approved', processedAt: { gte: start, lte: end } },
                _sum: { amount: true },
            })
            : [],
        ids.length
            ? prisma.foodRestaurantWithdrawal.groupBy({
                by: ['restaurantId'],
                where: { restaurantId: { in: ids }, status: 'pending' },
                _sum: { amount: true },
            })
            : [],
        getWalletSummaries(ids),
    ]);
    const paidBy = new Map(paid.map((p) => [p.restaurantId, num(p._sum.amount)]));
    const pendingBy = new Map(pending.map((p) => [p.restaurantId, num(p._sum.amount)]));
    const overTotal = [...overCount.values()].reduce((total, value) => total + num(value), 0);

    const first = rows[0] || {};
    const count = Number(first.rowCount || 0);
    return {
        period: { from: start, to: end },
        totals: {
            restaurants: count,
            orders: Number(first.allOrders || 0),
            grossSales: num(first.allGross),
            commission: num(first.allCommission),
            net: num(num(first.allNet) - overTotal),
        },
        restaurants: rows.map((row) => ({
            restaurantId: row.restaurantId,
            restaurant: row.restaurant,
            orders: row.orders,
            grossSales: num(row.grossSales),
            commission: num(row.commission),
            net: num(Math.max(0, num(row.net) - num(overCount.get(row.restaurantId)))),
            paidOut: paidBy.get(row.restaurantId) || 0,
            pendingPayout: pendingBy.get(row.restaurantId) || 0,
            balance: num(wallets.get(row.restaurantId)?.walletBalance),
        })),
        pagination: { total: count, page, limit, pages: Math.ceil(count / limit) || 1 },
    };
}

// ─── Restaurant VAT / GST report ─────────────────────────────────────────────

/**
 * Tax collected on each restaurant's earned orders: GST on the food (the
 * order's tax) and GST on the delivery fee, with the taxable value and the
 * restaurant's GSTIN for filing.
 */
export async function getRestaurantVatReport(query = {}) {
    const { start, end } = parsePeriod(query);
    const { page, limit } = pageOf(query);
    const search = String(query.search || '').trim();

    const rows = await prisma.$queryRaw`
        SELECT o."restaurantId" AS "restaurantId",
               r."restaurantName" AS restaurant,
               r."gstNumber" AS "gstNumber",
               COUNT(*)::int AS orders,
               SUM(GREATEST(0, o."subtotal" - o."discount")) AS taxable,
               SUM(o."tax") AS "foodTax",
               SUM(o."deliveryFeeGst") AS "deliveryTax",
               COUNT(*) OVER () AS "rowCount",
               SUM(COUNT(*)) OVER () AS "allOrders",
               SUM(SUM(GREATEST(0, o."subtotal" - o."discount"))) OVER () AS "allTaxable",
               SUM(SUM(o."tax")) OVER () AS "allFoodTax",
               SUM(SUM(o."deliveryFeeGst")) OVER () AS "allDeliveryTax"
          FROM food_orders o
          JOIN food_restaurants r ON r.id = o."restaurantId"
         WHERE o."orderStatus" <> 'pending_payment'
           AND ${EARNED_ORDER}
           AND o."createdAt" BETWEEN ${start} AND ${end}
           ${restaurantSql(query.restaurantId)}
           ${search ? Prisma.sql`AND r."restaurantName" ILIKE ${`%${search}%`}` : Prisma.empty}
         GROUP BY o."restaurantId", r."restaurantName", r."gstNumber"
         ORDER BY SUM(o."tax" + o."deliveryFeeGst") DESC
         LIMIT ${limit} OFFSET ${(page - 1) * limit}`;

    const first = rows[0] || {};
    const count = Number(first.rowCount || 0);
    const foodTax = num(first.allFoodTax);
    const deliveryTax = num(first.allDeliveryTax);
    return {
        period: { from: start, to: end },
        totals: {
            restaurants: count,
            orders: Number(first.allOrders || 0),
            taxable: num(first.allTaxable),
            foodTax,
            deliveryTax,
            totalTax: num(foodTax + deliveryTax),
        },
        restaurants: rows.map((row) => ({
            restaurantId: row.restaurantId,
            restaurant: row.restaurant,
            gstNumber: row.gstNumber || '',
            orders: row.orders,
            taxable: num(row.taxable),
            foodTax: num(row.foodTax),
            deliveryTax: num(row.deliveryTax),
            totalTax: num(num(row.foodTax) + num(row.deliveryTax)),
        })),
        pagination: { total: count, page, limit, pages: Math.ceil(count / limit) || 1 },
    };
}
