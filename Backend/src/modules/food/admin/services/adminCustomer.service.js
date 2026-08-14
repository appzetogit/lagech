import { Prisma } from '@prisma/client';
import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';

/**
 * The admin customer list, extracted from admin.service.js.
 *
 * Every row shows a lifetime order count and spend, which in Mongo meant a
 * $lookup pipeline when sorting by order count and a separate $group when not.
 * Postgres does both with one grouped query over food_orders, so the two paths
 * share it.
 */

const CUSTOMER_SELECT = {
    id: true, name: true, email: true, phone: true, countryCode: true,
    isVerified: true, isActive: true, profileImage: true,
    createdAt: true, updatedAt: true,
};

/**
 * Some profile image urls were stored wrapped in backticks by an old client.
 * Stripped on the way out rather than rewritten in place, because the raw value
 * is what that client still sends.
 */
const sanitizeUrl = (value) => String(value || '').trim().replace(/^`+|`+$/g, '').trim();

/** Delivered orders only: a cancelled order is not a customer's spend. */
const deliveredStatsFor = async (userIds) => {
    if (!userIds.length) return new Map();

    const rows = await prisma.foodOrder.groupBy({
        by: ['userId'],
        where: { userId: { in: userIds }, orderStatus: 'delivered' },
        _count: { _all: true },
        _sum: { total: true },
    });

    return new Map(
        rows.map((row) => [
            row.userId,
            {
                totalOrder: row._count._all,
                // total is Decimal; the admin table sums and formats these.
                totalOrderAmount: Number(row._sum.total || 0),
            },
        ])
    );
};

const serializeCustomer = (user, stats) => ({
    id: user.id,
    _id: user.id,
    name: user.name || 'Unnamed',
    email: user.email || '',
    phone: user.phone || '',
    profileImage: sanitizeUrl(user.profileImage),
    countryCode: user.countryCode || '+91',
    status: user.isActive !== false,
    isActive: user.isActive !== false,
    isVerified: user.isVerified === true,
    totalOrder: stats?.totalOrder || 0,
    totalOrderAmount: stats?.totalOrderAmount || 0,
    joiningDate: user.createdAt,
    createdAt: user.createdAt,
});

export async function getCustomers(query = {}) {
    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 50, 1), 1000);
    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    const skip = (page - 1) * limit;

    const where = { role: 'USER' };

    if (String(query.status) === 'active') where.isActive = true;
    if (String(query.status) === 'inactive') where.isActive = false;

    if (query.joiningDate && String(query.joiningDate).trim()) {
        const day = new Date(String(query.joiningDate));
        if (!Number.isNaN(day.getTime())) {
            const start = new Date(day);
            start.setHours(0, 0, 0, 0);
            const end = new Date(day);
            end.setHours(23, 59, 59, 999);
            where.createdAt = { gte: start, lte: end };
        }
    }

    if (query.search && String(query.search).trim()) {
        const contains = { contains: String(query.search).trim().slice(0, 80), mode: 'insensitive' };
        where.OR = [{ name: contains }, { email: contains }, { phone: contains }];
    }

    const sortBy = String(query.sortBy || '').trim();
    const byOrderCount = sortBy === 'orders-asc' || sortBy === 'orders-desc';

    let users;
    let total;

    if (byOrderCount) {
        // Ordering by a *filtered* relation count is beyond Prisma's
        // orderBy — its relation counts cannot be filtered to delivered
        // orders — so the page of ids is resolved in SQL. Was a $lookup
        // pipeline that loaded every matching order into the sort.
        const direction = sortBy === 'orders-asc' ? Prisma.sql`ASC` : Prisma.sql`DESC`;

        const scoped = await prisma.foodUser.findMany({ where, select: { id: true } });
        total = scoped.length;

        if (!total) return { customers: [], total: 0, page, limit };

        const ordered = await prisma.$queryRaw`
            SELECT u."id"
            FROM "food_users" u
            LEFT JOIN "food_orders" o
              ON o."userId" = u."id" AND o."orderStatus" = 'delivered'
            WHERE u."id" = ANY(${scoped.map((u) => u.id)})
            GROUP BY u."id", u."createdAt"
            ORDER BY COUNT(o."id") ${direction}, u."createdAt" DESC
            LIMIT ${limit} OFFSET ${skip}
        `;

        const pageIds = ordered.map((row) => row.id);
        const rows = await prisma.foodUser.findMany({
            where: { id: { in: pageIds } },
            select: CUSTOMER_SELECT,
        });
        // findMany does not preserve the id order, so the SQL ordering is
        // reapplied here rather than lost.
        const byId = new Map(rows.map((u) => [u.id, u]));
        users = pageIds.map((id) => byId.get(id)).filter(Boolean);
    } else {
        const orderBy =
            { 'name-asc': { name: 'asc' }, 'name-desc': { name: 'desc' } }[sortBy] ||
            { createdAt: 'desc' };

        [users, total] = await Promise.all([
            prisma.foodUser.findMany({ where, orderBy, skip, take: limit, select: CUSTOMER_SELECT }),
            prisma.foodUser.count({ where }),
        ]);
    }

    const stats = await deliveredStatsFor(users.map((u) => u.id));
    let customers = users.map((user) => serializeCustomer(user, stats.get(user.id)));

    const chooseFirst = parseInt(query.chooseFirst, 10);
    if (Number.isFinite(chooseFirst) && chooseFirst > 0) {
        customers = customers.slice(0, chooseFirst);
    }

    return { customers, total, page, limit };
}

export async function getCustomerById(id) {
    if (!isId(id)) return null;

    const user = await prisma.foodUser.findUnique({
        where: { id: String(id) },
        select: CUSTOMER_SELECT,
    });
    if (!user) return null;

    const stats = (await deliveredStatsFor([user.id])).get(user.id);

    return {
        ...serializeCustomer(user, stats),
        // The detail screen reads totalOrders; the list reads totalOrder.
        totalOrders: stats?.totalOrder || 0,
        updatedAt: user.updatedAt,
    };
}

export async function updateCustomerStatus(id, isActive) {
    if (!isId(id)) return null;
    const active = Boolean(isActive);

    const updated = await prisma.$transaction(async (tx) => {
        const { count } = await tx.foodUser.updateMany({
            where: { id: String(id) },
            data: { isActive: active },
        });
        if (!count) return null;

        // Deactivating has to end the sessions too. Leaving the refresh tokens
        // alive let a blocked customer keep using the app until their token
        // expired — and the delete now shares the transaction, so a failure
        // cannot leave an account marked blocked but still signed in.
        if (!active) {
            await tx.foodRefreshToken.deleteMany({ where: { userId: String(id) } });
        }

        return tx.foodUser.findUnique({ where: { id: String(id) } });
    });

    return updated;
}
