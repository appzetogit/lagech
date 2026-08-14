import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { sendNotificationToOwner } from '../../../../core/notifications/firebase.service.js';

/**
 * The admin support inbox, extracted from admin.service.js.
 *
 * Two separate tables feed it — customer tickets and restaurant tickets — and
 * the admin screen shows them as one list. They have different columns, so they
 * are queried separately and merged into a common shape here, exactly as before.
 */

const USER_TYPES = ['order', 'restaurant', 'other'];
const RESTAURANT_CATEGORIES = ['orders', 'payments', 'menu', 'restaurant', 'technical', 'other'];
const API_STATUSES = ['open', 'in-progress', 'resolved'];

/**
 * The API speaks 'in-progress'; the enum's Prisma name is in_progress and its
 * @map is the hyphenated form. Both directions have to be translated or the
 * query throws at the boundary.
 */
const toStatusColumn = (value) => (String(value) === 'in-progress' ? 'in_progress' : String(value));
const toStatusApi = (value) => (String(value) === 'in_progress' ? 'in-progress' : String(value));

const USER_TICKET_INCLUDE = {
    user: { select: { id: true, name: true, phone: true, email: true } },
    restaurant: { select: { id: true, restaurantName: true, city: true, area: true } },
    order: {
        select: {
            id: true,
            restaurantId: true,
            restaurant: { select: { id: true, restaurantName: true, city: true, area: true } },
        },
    },
};

const RESTAURANT_TICKET_INCLUDE = {
    restaurant: { select: { id: true, restaurantName: true, city: true, area: true } },
};

const toRestaurantSummary = (restaurant) =>
    restaurant
        ? {
            _id: restaurant.id,
            name: restaurant.restaurantName || '',
            city: restaurant.city || '',
            area: restaurant.area || '',
        }
        : null;

const mapUserTicket = (t) => {
    // A customer ticket names a restaurant either directly or through its
    // order; the screen shows whichever is available.
    const restaurant = toRestaurantSummary(t.restaurant || t.order?.restaurant);

    return {
        _id: t.id,
        id: t.id,
        source: 'user',
        userId: t.userId,
        type: t.type,
        orderId: t.orderId || null,
        restaurantId: restaurant?._id || t.restaurantId || t.order?.restaurantId || null,
        issueType: t.issueType,
        description: t.description,
        status: toStatusApi(t.status),
        adminResponse: t.adminResponse,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
        user: t.user
            ? { _id: t.user.id, name: t.user.name || '', phone: t.user.phone || '', email: t.user.email || '' }
            : null,
        restaurant,
        restaurantName: restaurant?.name || '',
    };
};

const mapRestaurantTicket = (t) => {
    const restaurant = toRestaurantSummary(t.restaurant);

    return {
        _id: t.id,
        id: t.id,
        source: 'restaurant',
        userId: null,
        type: 'restaurant-support',
        category: t.category || 'other',
        orderId: null,
        orderRef: t.orderRef || '',
        restaurantId: restaurant?._id || t.restaurantId || null,
        issueType: t.issueType,
        subject: t.subject || '',
        description: t.description,
        priority: t.priority || 'medium',
        status: toStatusApi(t.status),
        adminResponse: t.adminResponse,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
        user: null,
        restaurant,
        restaurantName: restaurant?.name || '',
    };
};

/**
 * A free-text search has to reach names the tickets only reference by id, so
 * the matching restaurants, customers and orders are resolved first and their
 * ids folded into the ticket filter.
 */
const resolveSearchTargets = async (search) => {
    const contains = { contains: search, mode: 'insensitive' };

    const [restaurants, users, orders] = await Promise.all([
        prisma.foodRestaurant.findMany({ where: { restaurantName: contains }, select: { id: true } }),
        prisma.foodUser.findMany({ where: { name: contains }, select: { id: true } }),
        prisma.foodOrder.findMany({
            where: { OR: [{ orderId: contains }, { order_id: contains }] },
            select: { id: true },
        }),
    ]);

    return {
        restaurantIds: restaurants.map((r) => r.id),
        userIds: users.map((u) => u.id),
        orderIds: orders.map((o) => o.id),
    };
};

export async function getSupportTickets(query = {}) {
    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 50, 1), 1000);
    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    const skip = (page - 1) * limit;

    const source = String(query.source || 'all').toLowerCase();
    const search = String(query.search || '').trim().slice(0, 80);
    const type = query.type ? String(query.type) : '';
    const category = query.category ? String(query.category) : '';

    const userWhere = {};
    const restaurantWhere = {};

    if (API_STATUSES.includes(String(query.status))) {
        userWhere.status = toStatusColumn(query.status);
        restaurantWhere.status = toStatusColumn(query.status);
    }
    if (USER_TYPES.includes(type)) userWhere.type = type;
    if (RESTAURANT_CATEGORIES.includes(category)) restaurantWhere.category = category;

    if (search) {
        const contains = { contains: search, mode: 'insensitive' };
        const { restaurantIds, userIds, orderIds } = await resolveSearchTargets(search);

        const userOr = [{ issueType: contains }, { description: contains }];
        const restaurantOr = [
            { issueType: contains },
            { subject: contains },
            { description: contains },
            { orderRef: contains },
        ];

        if (restaurantIds.length) {
            userOr.push({ restaurantId: { in: restaurantIds } });
            restaurantOr.push({ restaurantId: { in: restaurantIds } });
        }
        if (userIds.length) userOr.push({ userId: { in: userIds } });
        if (orderIds.length) userOr.push({ orderId: { in: orderIds } });
        if (isId(search)) {
            userOr.push({ id: search });
            restaurantOr.push({ id: search });
        }

        userWhere.OR = userOr;
        restaurantWhere.OR = restaurantOr;
    }

    const wantUser = source === 'all' || source === 'user';
    // A type filter is a customer-ticket concept, so asking for one excludes
    // restaurant tickets entirely.
    const wantRestaurant = (source === 'all' || source === 'restaurant') && !type;

    // ponytail: for the merged view both tables are read up to skip+limit and
    // paginated in memory, because one page can interleave rows from two tables.
    // A UNION ALL view would push it down if these ever grow large.
    const fetchCap = source === 'all' ? skip + limit : limit;
    const fetchSkip = source === 'all' ? 0 : skip;

    const [userList, userTotal, restaurantList, restaurantTotal] = await Promise.all([
        wantUser
            ? prisma.foodSupportTicket.findMany({
                where: userWhere,
                orderBy: { createdAt: 'desc' },
                skip: fetchSkip,
                take: fetchCap,
                include: USER_TICKET_INCLUDE,
            })
            : [],
        wantUser ? prisma.foodSupportTicket.count({ where: userWhere }) : 0,
        wantRestaurant
            ? prisma.foodRestaurantSupportTicket.findMany({
                where: restaurantWhere,
                orderBy: { createdAt: 'desc' },
                skip: fetchSkip,
                take: fetchCap,
                include: RESTAURANT_TICKET_INCLUDE,
            })
            : [],
        wantRestaurant ? prisma.foodRestaurantSupportTicket.count({ where: restaurantWhere }) : 0,
    ]);

    if (source === 'user') {
        return { tickets: userList.map(mapUserTicket), total: userTotal, page, limit };
    }
    if (source === 'restaurant') {
        return {
            tickets: restaurantList.map(mapRestaurantTicket),
            total: restaurantTotal,
            page,
            limit,
        };
    }

    const merged = [...userList.map(mapUserTicket), ...restaurantList.map(mapRestaurantTicket)].sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );

    return {
        tickets: merged.slice(skip, skip + limit),
        total: userTotal + restaurantTotal,
        page,
        limit,
    };
}

export async function getFoodSupportTicketStats(query = {}) {
    const source = String(query.source || 'all').toLowerCase();
    const type = query.type ? String(query.type) : '';
    const category = query.category ? String(query.category) : '';

    const userWhere = USER_TYPES.includes(type) ? { type } : {};
    const restaurantWhere = RESTAURANT_CATEGORIES.includes(category) ? { category } : {};

    const wantUser = source === 'all' || source === 'user';
    const wantRestaurant = (source === 'all' || source === 'restaurant') && !type;

    /** One grouped query per table, rather than four counts each. */
    const countByStatus = async (delegate, where) => {
        const rows = await delegate.groupBy({ by: ['status'], where, _count: { _all: true } });
        const counts = { open: 0, inProgress: 0, resolved: 0, total: 0 };

        for (const row of rows) {
            const n = row._count._all;
            counts.total += n;
            if (row.status === 'open') counts.open = n;
            if (row.status === 'in_progress') counts.inProgress = n;
            if (row.status === 'resolved') counts.resolved = n;
        }
        return counts;
    };

    const empty = { open: 0, inProgress: 0, resolved: 0, total: 0 };
    const [userCounts, restaurantCounts] = await Promise.all([
        wantUser ? countByStatus(prisma.foodSupportTicket, userWhere) : empty,
        wantRestaurant ? countByStatus(prisma.foodRestaurantSupportTicket, restaurantWhere) : empty,
    ]);

    return {
        total: userCounts.total + restaurantCounts.total,
        open: userCounts.open + restaurantCounts.open,
        inProgress: userCounts.inProgress + restaurantCounts.inProgress,
        resolved: userCounts.resolved + restaurantCounts.resolved,
    };
}

export async function updateSupportTicket(id, body = {}) {
    if (!isId(id)) return null;

    const source = String(body.source || 'user').toLowerCase();
    const isRestaurant = source === 'restaurant';

    const data = {};
    if (API_STATUSES.includes(String(body.status))) data.status = toStatusColumn(body.status);
    if (typeof body.adminResponse === 'string') data.adminResponse = body.adminResponse;
    if (!Object.keys(data).length) return null;

    const delegate = isRestaurant ? prisma.foodRestaurantSupportTicket : prisma.foodSupportTicket;

    const { count } = await delegate.updateMany({ where: { id: String(id) }, data });
    if (!count) return null;

    const updated = await delegate.findUnique({ where: { id: String(id) } });

    if (data.adminResponse) {
        const ownerType = isRestaurant ? 'RESTAURANT' : 'USER';
        const ownerId = isRestaurant ? updated.restaurantId : updated.userId;

        // Customer tickets have no `subject` column — only restaurant ones do —
        // so the old message rendered as 'your ticket: "undefined"' for every
        // customer reply. issueType is the field a customer actually filled in.
        const label = (isRestaurant ? updated.subject : updated.issueType) || 'your ticket';
        const message = `Admin has responded to your ticket: "${label}"`;

        if (ownerId) {
            await prisma.foodNotification
                .create({
                    data: {
                        ownerType,
                        ownerId,
                        title: 'Support Ticket Response',
                        message,
                        source: 'SUPPORT_RESPONSE',
                        category: 'support',
                        metadata: { ticketId: updated.id, source },
                    },
                })
                .catch((err) => console.error('Error creating support notification:', err));

            await sendNotificationToOwner({
                ownerType,
                ownerId,
                payload: {
                    title: 'Support Ticket Response',
                    body: message,
                    data: { type: 'SUPPORT_RESPONSE', ticketId: String(updated.id), source },
                },
            }).catch((err) => console.error('Error sending support push notification:', err));
        }
    }

    return isRestaurant ? mapRestaurantTicket(updated) : mapUserTicket(updated);
}
