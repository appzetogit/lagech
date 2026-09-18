import { Prisma } from '@prisma/client';
import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { ValidationError } from '../../../../core/auth/errors.js';

/**
 * The reports the previous admin panel had and this one lacked: what the
 * platform spent (expenses), what it earned day by day, and what sold.
 *
 * All three read delivered orders only -- a cancelled order earned and cost
 * nothing -- and are summed in the database.
 */

const num = (value) => Math.round((Number(value) || 0) * 100) / 100;

/** A from/to period, defaulting to the last 30 days; `to` includes its whole day. */
export function parsePeriod({ from, to } = {}) {
    const end = to ? new Date(to) : new Date();
    const start = from ? new Date(from) : new Date(end.getTime() - 29 * 24 * 60 * 60 * 1000);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) throw new ValidationError('Invalid date');
    start.setHours(0, 0, 0, 0);
    end.setHours(23, 59, 59, 999);
    if (end < start) throw new ValidationError('"To" must be on or after "From"');
    return { start, end };
}

const restaurantFilter = (restaurantId) =>
    isId(restaurantId) ? Prisma.sql`AND o."restaurantId" = ${String(restaurantId)}` : Prisma.empty;

/**
 * What the platform paid out of its own pocket, per delivered order:
 *
 *   - discount: its share of a discount (a restaurant's discount also lowers
 *     the commission the platform earns on the food; a platform coupon it
 *     bears in whole or part)
 *   - free delivery: the rider was paid more than the customer was charged
 *     for delivery, and the platform made up the difference
 *   - cashback: credited to the customer's wallet on delivery
 *
 * Rider bonuses are paid per rider, not per order, and are totalled separately.
 */
export async function getExpenseReport(query = {}) {
    const { start, end } = parsePeriod(query);
    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 50, 1), 500);

    const rows = await prisma.$queryRaw`
        WITH per_order AS (
            SELECT o.id, o."orderId", o."createdAt", r."restaurantName" AS restaurant,
                   COALESCE(t."adminDiscountShare", 0) AS discount,
                   GREATEST(0, COALESCE(t."riderShare", o."riderEarning") - o."deliveryFee") AS "freeDelivery",
                   COALESCE((SELECT SUM(x.amount) FROM transactions x
                              WHERE x."orderId" = o.id AND x.category = 'wallet_topup'
                                AND x.description LIKE 'Cashback%'), 0) AS cashback
              FROM food_orders o
              JOIN food_restaurants r ON r.id = o."restaurantId"
              LEFT JOIN food_transactions t ON t."orderId" = o.id
             WHERE o."orderStatus" = 'delivered'
               AND o."createdAt" BETWEEN ${start} AND ${end}
               ${restaurantFilter(query.restaurantId)}
        )
        SELECT *, discount + "freeDelivery" + cashback AS total, COUNT(*) OVER () AS "rowCount",
               SUM(discount) OVER () AS "sumDiscount", SUM("freeDelivery") OVER () AS "sumFreeDelivery",
               SUM(cashback) OVER () AS "sumCashback"
          FROM per_order
         WHERE discount + "freeDelivery" + cashback > 0
         ORDER BY "createdAt" DESC
         LIMIT ${limit} OFFSET ${(page - 1) * limit}`;

    const bonuses = await prisma.deliveryBonusTransaction.aggregate({
        where: { createdAt: { gte: start, lte: end } },
        _sum: { amount: true },
        _count: true,
    });

    const first = rows[0] || {};
    const totals = {
        discount: num(first.sumDiscount),
        freeDelivery: num(first.sumFreeDelivery),
        cashback: num(first.sumCashback),
        riderBonuses: num(bonuses._sum.amount),
    };
    totals.total = num(totals.discount + totals.freeDelivery + totals.cashback + totals.riderBonuses);
    const count = Number(first.rowCount || 0);

    return {
        period: { from: start, to: end },
        totals,
        riderBonusCount: bonuses._count,
        expenses: rows.map((row) => ({
            orderId: row.orderId,
            restaurant: row.restaurant,
            createdAt: row.createdAt,
            discount: num(row.discount),
            freeDelivery: num(row.freeDelivery),
            cashback: num(row.cashback),
            total: num(row.total),
        })),
        pagination: { total: count, page, limit, pages: Math.ceil(count / limit) || 1 },
    };
}

/**
 * The platform's earnings per day: commission on food, its cut of the delivery
 * fee, the platform fee and GST it collected, less the expenses above.
 */
export async function getAdminEarningReport(query = {}) {
    const { start, end } = parsePeriod(query);
    const days = await prisma.$queryRaw`
        SELECT to_char((o."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS day,
               COUNT(*)::int AS orders,
               SUM(o.total) AS sales,
               SUM(COALESCE(t."commissionAmount", o."restaurantCommission")) AS commission,
               SUM(o."deliveryFee" - LEAST(o."deliveryFee", COALESCE(t."riderShare", o."riderEarning"))) AS "deliveryCut",
               SUM(o."platformFee") AS "platformFee",
               SUM(o.tax + o."deliveryFeeGst") AS gst,
               SUM(COALESCE(t."adminDiscountShare", 0)
                   + GREATEST(0, COALESCE(t."riderShare", o."riderEarning") - o."deliveryFee")) AS expenses
          FROM food_orders o
          LEFT JOIN food_transactions t ON t."orderId" = o.id
         WHERE o."orderStatus" = 'delivered'
           AND o."createdAt" BETWEEN ${start} AND ${end}
           ${restaurantFilter(query.restaurantId)}
         GROUP BY 1
         ORDER BY 1 DESC`;

    const rows = days.map((d) => {
        const earned = num(num(d.commission) + num(d.deliveryCut) + num(d.platformFee));
        return {
            day: d.day,
            orders: d.orders,
            sales: num(d.sales),
            commission: num(d.commission),
            deliveryCut: num(d.deliveryCut),
            platformFee: num(d.platformFee),
            gst: num(d.gst),
            earned,
            expenses: num(d.expenses),
            net: num(earned - num(d.expenses)),
        };
    });
    const sum = (key) => num(rows.reduce((total, row) => total + row[key], 0));
    return {
        period: { from: start, to: end },
        totals: {
            orders: rows.reduce((total, row) => total + row.orders, 0),
            sales: sum('sales'),
            commission: sum('commission'),
            deliveryCut: sum('deliveryCut'),
            platformFee: sum('platformFee'),
            gst: sum('gst'),
            earned: sum('earned'),
            expenses: sum('expenses'),
            net: sum('net'),
        },
        days: rows,
    };
}

/** What sold: every dish (by name within its restaurant), quantity and takings. */
export async function getItemReport(query = {}) {
    const { start, end } = parsePeriod(query);
    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 50, 1), 500);
    const search = String(query.search || '').trim();
    const sort = query.sort === 'quantity' ? Prisma.sql`quantity DESC` : Prisma.sql`sales DESC`;

    const rows = await prisma.$queryRaw`
        SELECT i.name, r."restaurantName" AS restaurant,
               SUM(i.quantity)::int AS quantity,
               COUNT(DISTINCT o.id)::int AS orders,
               SUM(i.price * i.quantity) AS sales,
               COUNT(*) OVER () AS "rowCount",
               SUM(SUM(i.price * i.quantity)) OVER () AS "allSales",
               SUM(SUM(i.quantity)) OVER () AS "allQuantity"
          FROM food_order_items i
          JOIN food_orders o ON o.id = i."orderId"
          JOIN food_restaurants r ON r.id = o."restaurantId"
         WHERE o."orderStatus" = 'delivered'
           AND o."createdAt" BETWEEN ${start} AND ${end}
           ${restaurantFilter(query.restaurantId)}
           ${search ? Prisma.sql`AND i.name ILIKE ${`%${search}%`}` : Prisma.empty}
         GROUP BY i.name, r."restaurantName"
         ORDER BY ${sort}
         LIMIT ${limit} OFFSET ${(page - 1) * limit}`;

    const first = rows[0] || {};
    const count = Number(first.rowCount || 0);
    return {
        period: { from: start, to: end },
        totals: { items: count, quantity: Number(first.allQuantity || 0), sales: num(first.allSales) },
        items: rows.map((row) => ({
            name: row.name,
            restaurant: row.restaurant,
            quantity: row.quantity,
            orders: row.orders,
            sales: num(row.sales),
            averagePrice: row.quantity ? num(num(row.sales) / row.quantity) : 0,
        })),
        pagination: { total: count, page, limit, pages: Math.ceil(count / limit) || 1 },
    };
}
