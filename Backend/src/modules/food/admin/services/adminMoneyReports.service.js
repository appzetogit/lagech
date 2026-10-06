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

/** Rider payout line status -> what the rider tab calls it (Delivery Man Disbursement says "failed"). */
export const RIDER_DISBURSEMENT_STATUS = { pending: 'pending', approved: 'paid', rejected: 'failed' };

/** 'pending' | 'paid' | 'failed' (or the restaurant tab's 'cancelled') -> the stored status, or null for all. */
export function riderLineStatusFilter(value) {
    const wanted = String(value || '').trim().toLowerCase();
    if (wanted === 'cancelled') return 'rejected';
    return Object.entries(RIDER_DISBURSEMENT_STATUS).find(([, label]) => label === wanted)?.[0] || null;
}

/**
 * Sum payout lines grouped by status ({ status, amount, count }) into the
 * report totals. Pure. `cancelled` repeats `failed` so a page written for the
 * restaurant tab still reads the right figure.
 */
export function foldRiderDisbursementTotals(groups = []) {
    const totals = { payouts: 0, total: 0, paid: 0, pending: 0, failed: 0 };
    for (const group of groups) {
        const amount = num(group.amount);
        totals.payouts += Number(group.count) || 0;
        totals.total = num(totals.total + amount);
        const bucket = RIDER_DISBURSEMENT_STATUS[group.status];
        if (bucket) totals[bucket] = num(totals[bucket] + amount);
    }
    return { ...totals, cancelled: totals.failed };
}

/**
 * The Delivery men tab: every rider payout line made by a Delivery Man
 * Disbursement (food_delivery_withdrawals with source 'disbursement') in the
 * period -- the old panel's columns: id, delivery man, created at, amount,
 * payment method, status, and a link to its disbursement. Filters: period
 * (line created), status, rider (deliveryPartnerId) and a name/phone search.
 * A rider's own withdrawal requests and recorded payments are not
 * disbursements and are left out, as in the old panel.
 */
export async function getRiderDisbursementReport(query = {}) {
    const { start, end } = parsePeriod(query);
    const { page, limit } = pageOf(query);
    const status = riderLineStatusFilter(query.status);
    const riderId = query.deliveryPartnerId || query.riderId;
    const search = String(query.search || '').trim();

    const where = {
        source: 'disbursement',
        createdAt: { gte: start, lte: end },
        ...(isId(riderId) ? { deliveryPartnerId: String(riderId) } : {}),
        ...(status ? { status } : {}),
        ...(search
            ? {
                deliveryPartner: {
                    OR: [
                        { name: { contains: search, mode: 'insensitive' } },
                        { phone: { contains: search } },
                    ],
                },
            }
            : {}),
    };

    const [lines, grouped, riderGroups, total] = await Promise.all([
        prisma.foodDeliveryWithdrawal.findMany({
            where,
            orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
            skip: (page - 1) * limit,
            take: limit,
            include: {
                deliveryPartner: { select: { id: true, name: true, phone: true, email: true } },
                batch: { select: { id: true, number: true } },
            },
        }),
        prisma.foodDeliveryWithdrawal.groupBy({
            by: ['status'],
            where,
            _sum: { amount: true },
            _count: { _all: true },
        }),
        prisma.foodDeliveryWithdrawal.groupBy({ by: ['deliveryPartnerId'], where }),
        prisma.foodDeliveryWithdrawal.count({ where }),
    ]);

    const batchIds = [...new Set(lines.map((l) => l.batchId).filter(Boolean))];
    const batches = batchIds.length
        ? await prisma.foodDeliveryPayoutBatch.findMany({ where: { id: { in: batchIds } }, orderBy: { createdAt: 'desc' } })
        : [];
    const batchLines = batchIds.length
        ? await prisma.foodDeliveryWithdrawal.groupBy({
            by: ['batchId', 'status'],
            where: { batchId: { in: batchIds } },
            _sum: { amount: true },
        })
        : [];
    const byBatch = new Map();
    for (const line of batchLines) {
        const entry = byBatch.get(line.batchId) || { paid: 0, pending: 0, failed: 0 };
        const bucket = RIDER_DISBURSEMENT_STATUS[line.status];
        if (bucket) entry[bucket] = num(entry[bucket] + num(line._sum.amount));
        byBatch.set(line.batchId, entry);
    }

    const folded = foldRiderDisbursementTotals(
        grouped.map((g) => ({ status: g.status, amount: g._sum.amount, count: g._count._all })),
    );

    return {
        entityType: 'rider',
        supported: true,
        period: { from: start, to: end },
        totals: { ...folded, riders: riderGroups.length, batches: batches.length },
        rows: lines.map((line) => ({
            id: line.id,
            batchId: line.batchId,
            batchTitle: line.batch ? `Disbursement #${line.batch.number}` : '',
            deliveryPartnerId: line.deliveryPartnerId,
            deliveryName: line.deliveryPartner?.name || 'Deleted delivery man',
            deliveryPhone: line.deliveryPartner?.phone || '',
            deliveryEmail: line.deliveryPartner?.email || '',
            createdAt: line.createdAt,
            amount: num(line.amount),
            paymentMethod: line.paymentMethod,
            status: RIDER_DISBURSEMENT_STATUS[line.status] || line.status,
            reference: line.transactionId || '',
            note: line.adminNote || line.rejectionReason || '',
            processedAt: line.processedAt,
        })),
        batches: batches.map((b) => {
            const parts = byBatch.get(b.id) || { paid: 0, pending: 0, failed: 0 };
            return {
                id: b.id,
                title: `Disbursement #${b.number}`,
                riderCount: b.riderCount,
                totalAmount: num(b.totalAmount),
                ...parts,
                cancelled: parts.failed,
                createdAt: b.createdAt,
            };
        }),
        pagination: { total, page, limit, pages: Math.ceil(total / limit) || 1 },
    };
}

/**
 * What the payout runs disbursed in a period. Restaurants: totals by status,
 * one row per restaurant, and each daily run. Riders (entityType 'rider'):
 * one row per payout line of the Delivery Man Disbursements, see
 * getRiderDisbursementReport.
 */
export async function getDisbursementReport(query = {}) {
    const { start, end } = parsePeriod(query);
    const period = { from: start, to: end };
    const { page, limit } = pageOf(query);

    if (query.entityType === 'rider') return getRiderDisbursementReport(query);

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
