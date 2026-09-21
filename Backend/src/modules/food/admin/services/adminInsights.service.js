import { Prisma } from '@prisma/client';
import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';

/**
 * The "who and what" half of the admin dashboard, as the previous admin panel
 * had it: top dishes, top rated dishes, most favourited and busiest
 * restaurants, top riders and customers, the user split, earnings by month and
 * a count per order state.
 *
 * Sales and "top" lists read delivered orders only. `zoneId` narrows to the
 * restaurants of one zone; `period` is all | year | month | week.
 */

const LIMIT = 6;
const num = (value) => Math.round((Number(value) || 0) * 100) / 100;
const int = (value) => Number(value) || 0;

export function periodStart(period, now = new Date()) {
    const d = new Date(now);
    if (period === 'week') return new Date(d.getTime() - 6 * 24 * 60 * 60 * 1000);
    if (period === 'month') return new Date(d.getFullYear(), d.getMonth(), 1);
    if (period === 'year') return new Date(d.getFullYear(), 0, 1);
    return null;
}

export async function getDashboardInsights(query = {}) {
    const zoneId = isId(query.zoneId) ? String(query.zoneId) : null;
    const start = periodStart(String(query.period || 'all'));

    const zone = zoneId ? Prisma.sql`AND r."zoneId" = ${zoneId}` : Prisma.empty;
    const since = start ? Prisma.sql`AND o."createdAt" >= ${start}` : Prisma.empty;
    const delivered = Prisma.sql`o."orderStatus" = 'delivered' ${since} ${zone}`;

    const [
        topSellingFoods,
        topRatedFoods,
        popularRestaurants,
        topRestaurants,
        topRiders,
        topCustomers,
        statusRows,
        scheduledRows,
        splitRows,
        monthRows,
    ] = await Promise.all([
        prisma.$queryRaw`
            SELECT i."itemId" AS id, MAX(i.name) AS name,
                   COALESCE(NULLIF(MAX(f.image), ''), MAX(i.image)) AS image,
                   MAX(r."restaurantName") AS "restaurantName",
                   SUM(i.quantity)::int AS sold, SUM(i.price * i.quantity) AS sales
            FROM food_order_items i
            JOIN food_orders o ON o.id = i."orderId"
            JOIN food_restaurants r ON r.id = o."restaurantId"
            LEFT JOIN food_items f ON f.id = i."itemId"
            WHERE ${delivered}
            GROUP BY i."itemId"
            ORDER BY sold DESC, sales DESC
            LIMIT ${LIMIT}`,
        prisma.$queryRaw`
            SELECT f.id, f.name, f.image, r."restaurantName", f.rating, f."totalRatings"
            FROM food_items f
            JOIN food_restaurants r ON r.id = f."restaurantId"
            WHERE f."totalRatings" > 0 ${zone}
            ORDER BY f.rating DESC, f."totalRatings" DESC
            LIMIT ${LIMIT}`,
        prisma.$queryRaw`
            SELECT r.id, r."restaurantName" AS name, r."profileImage" AS image, r.rating,
                   COUNT(*)::int AS favourites
            FROM food_user_favorites fav
            JOIN food_restaurants r ON r.id = fav."entityId"
            WHERE fav."entityType" = 'restaurant' ${zone}
            GROUP BY r.id
            ORDER BY favourites DESC
            LIMIT ${LIMIT}`,
        prisma.$queryRaw`
            SELECT r.id, MAX(r."restaurantName") AS name, MAX(r."profileImage") AS image,
                   MAX(r.rating) AS rating, COUNT(*)::int AS orders, SUM(o.total) AS sales
            FROM food_orders o
            JOIN food_restaurants r ON r.id = o."restaurantId"
            WHERE ${delivered}
            GROUP BY r.id
            ORDER BY orders DESC
            LIMIT ${LIMIT}`,
        prisma.$queryRaw`
            SELECT p.id, MAX(p.name) AS name, MAX(p."profilePhoto") AS image, MAX(p.phone) AS phone,
                   MAX(p.rating) AS rating, COUNT(*)::int AS orders
            FROM food_orders o
            JOIN food_restaurants r ON r.id = o."restaurantId"
            JOIN food_delivery_partners p ON p.id = o."dispatchDeliveryPartnerId"
            WHERE ${delivered}
            GROUP BY p.id
            ORDER BY orders DESC
            LIMIT ${LIMIT}`,
        prisma.$queryRaw`
            SELECT u.id, COALESCE(MAX(u.name), MAX(o."customerName")) AS name, MAX(u."profileImage") AS image,
                   MAX(u.phone) AS phone, COUNT(*)::int AS orders, SUM(o.total) AS spent
            FROM food_orders o
            JOIN food_restaurants r ON r.id = o."restaurantId"
            JOIN food_users u ON u.id = o."userId"
            WHERE ${delivered}
            GROUP BY u.id
            ORDER BY orders DESC, spent DESC
            LIMIT ${LIMIT}`,
        prisma.$queryRaw`
            SELECT o."orderStatus"::text AS status, COUNT(*)::int AS count
            FROM food_orders o
            JOIN food_restaurants r ON r.id = o."restaurantId"
            WHERE TRUE ${since} ${zone}
            GROUP BY o."orderStatus"`,
        prisma.$queryRaw`
            SELECT COUNT(*)::int AS count
            FROM food_orders o
            JOIN food_restaurants r ON r.id = o."restaurantId"
            WHERE o."scheduledAt" IS NOT NULL AND o."scheduledAt" > NOW()
              AND o."orderStatus" NOT IN ('delivered', 'cancelled_by_user', 'cancelled_by_restaurant', 'cancelled_by_admin')
              ${zone}`,
        prisma.$queryRaw`
            SELECT
              (SELECT COUNT(*)::int FROM food_users) AS customers,
              (SELECT COUNT(*)::int FROM food_restaurants r WHERE r.status = 'approved' ${zone}) AS restaurants,
              (SELECT COUNT(*)::int FROM food_delivery_partners WHERE status = 'approved') AS riders`,
        prisma.$queryRaw`
            SELECT to_char(date_trunc('month', o."createdAt"), 'YYYY-MM') AS month,
                   SUM(o."restaurantCommission") AS commission,
                   SUM(o."deliveryFee" - o."riderEarning") AS "deliveryMargin",
                   SUM(o."platformFee") AS "platformFee",
                   COUNT(*)::int AS orders
            FROM food_orders o
            JOIN food_restaurants r ON r.id = o."restaurantId"
            WHERE o."orderStatus" = 'delivered'
              AND o."createdAt" >= date_trunc('month', NOW()) - INTERVAL '11 months'
              ${zone}
            GROUP BY 1
            ORDER BY 1`,
    ]);

    const byStatus = Object.fromEntries(statusRows.map((row) => [row.status, int(row.count)]));
    const count = (...keys) => keys.reduce((sum, key) => sum + (byStatus[key] || 0), 0);

    // Twelve months, oldest first, with empty months filled in.
    const months = new Map(monthRows.map((row) => [row.month, row]));
    const earnings = [];
    const now = new Date();
    for (let back = 11; back >= 0; back -= 1) {
        const d = new Date(now.getFullYear(), now.getMonth() - back, 1);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        const row = months.get(key) || {};
        earnings.push({
            month: key,
            commission: num(row.commission),
            deliveryMargin: num(row.deliveryMargin),
            platformFee: num(row.platformFee),
            orders: int(row.orders),
        });
    }

    const split = splitRows[0] || {};
    return {
        filters: { zoneId, period: start ? String(query.period) : 'all', since: start },
        orderStatus: {
            pending: count('pending_payment', 'created'),
            confirmed: count('confirmed'),
            preparing: count('preparing'),
            readyForPickup: count('ready_for_pickup', 'reached_pickup'),
            onTheWay: count('picked_up', 'reached_drop'),
            delivered: count('delivered'),
            cancelled: count('cancelled_by_user', 'cancelled_by_restaurant', 'cancelled_by_admin'),
            scheduled: int(scheduledRows[0]?.count),
        },
        userSplit: {
            customers: int(split.customers),
            restaurants: int(split.restaurants),
            riders: int(split.riders),
        },
        earnings,
        topSellingFoods: topSellingFoods.map((row) => ({ ...row, sold: int(row.sold), sales: num(row.sales) })),
        topRatedFoods: topRatedFoods.map((row) => ({ ...row, rating: num(row.rating), totalRatings: int(row.totalRatings) })),
        popularRestaurants: popularRestaurants.map((row) => ({ ...row, rating: num(row.rating), favourites: int(row.favourites) })),
        topRestaurants: topRestaurants.map((row) => ({ ...row, rating: num(row.rating), orders: int(row.orders), sales: num(row.sales) })),
        topRiders: topRiders.map((row) => ({ ...row, rating: num(row.rating), orders: int(row.orders) })),
        topCustomers: topCustomers.map((row) => ({ ...row, orders: int(row.orders), spent: num(row.spent) })),
    };
}
