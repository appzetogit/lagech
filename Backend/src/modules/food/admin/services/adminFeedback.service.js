import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { ValidationError } from '../../../../core/auth/errors.js';

/**
 * Complaints, reviews, feedback and the global search box — the admin panel's
 * read surfaces, extracted from admin.service.js.
 */

const API_STATUSES = ['open', 'in-progress', 'resolved'];

/** The API says 'in-progress'; the enum's Prisma name is in_progress. */
const toStatusColumn = (v) => (String(v) === 'in-progress' ? 'in_progress' : String(v));
const toStatusApi = (v) => (String(v) === 'in_progress' ? 'in-progress' : String(v));

const COMPLAINT_INCLUDE = {
    user: { select: { id: true, name: true, phone: true, profileImage: true } },
    restaurant: { select: { id: true, restaurantName: true, profileImage: true, area: true, city: true } },
    order: { select: { id: true, orderId: true, order_id: true, orderStatus: true, total: true, createdAt: true } },
};

const serializeComplaint = (t) => ({
    ...t,
    _id: t.id,
    status: toStatusApi(t.status),
});

export async function getRestaurantComplaints(query = {}) {
    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 50, 1), 500);
    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    const skip = (page - 1) * limit;

    // A complaint is a customer ticket raised against an order.
    const where = { type: 'order' };

    if (query.status && query.status !== 'all' && API_STATUSES.includes(String(query.status))) {
        where.status = toStatusColumn(query.status);
    }
    if (query.complaintType && query.complaintType !== 'all') {
        where.issueType = String(query.complaintType);
    }
    if (isId(query.restaurantId)) where.restaurantId = String(query.restaurantId);

    if (query.search && String(query.search).trim()) {
        const contains = { contains: String(query.search).trim(), mode: 'insensitive' };
        // The names live on other tables, so the filter reaches through the
        // relations rather than pre-resolving three id lists.
        where.OR = [
            { description: contains },
            { issueType: contains },
            { restaurant: { restaurantName: contains } },
            { user: { name: contains } },
            { order: { OR: [{ orderId: contains }, { order_id: contains }] } },
        ];
    }

    const fromDate = query.fromDate || query.startDate;
    const toDate = query.toDate || query.endDate;
    if (fromDate && toDate) {
        where.createdAt = { gte: new Date(fromDate), lte: new Date(toDate) };
    }

    const [complaints, total] = await Promise.all([
        prisma.foodSupportTicket.findMany({
            where,
            include: COMPLAINT_INCLUDE,
            orderBy: { createdAt: 'desc' },
            skip,
            take: limit,
        }),
        prisma.foodSupportTicket.count({ where }),
    ]);

    return { complaints: complaints.map(serializeComplaint), total, page, limit };
}

export async function getRestaurantComplaintStats(query = {}) {
    const where = { type: 'order' };
    if (query.complaintType && query.complaintType !== 'all') {
        where.issueType = String(query.complaintType);
    }

    // One grouped query rather than four counts.
    const rows = await prisma.foodSupportTicket.groupBy({
        by: ['status'],
        where,
        _count: { _all: true },
    });

    const counts = { total: 0, open: 0, inProgress: 0, resolved: 0 };
    for (const row of rows) {
        counts.total += row._count._all;
        if (row.status === 'open') counts.open = row._count._all;
        if (row.status === 'in_progress') counts.inProgress = row._count._all;
        if (row.status === 'resolved') counts.resolved = row._count._all;
    }
    return counts;
}

export async function updateRestaurantComplaint(id, updateData = {}) {
    if (!isId(id)) throw new ValidationError('Invalid complaint ID');

    const data = {};
    if (API_STATUSES.includes(String(updateData.status))) {
        data.status = toStatusColumn(updateData.status);
    }
    if (updateData.adminResponse !== undefined) data.adminResponse = updateData.adminResponse;

    const { count } = await prisma.foodSupportTicket.updateMany({
        where: { id: String(id) },
        data,
    });
    if (!count) throw new ValidationError('Complaint not found');

    const updated = await prisma.foodSupportTicket.findUnique({ where: { id: String(id) } });
    return serializeComplaint(updated);
}

/**
 * Restaurant ratings left on orders.
 *
 * Mongo held these in a `ratings.restaurant` subdocument and filtered on its
 * existence; they are plain columns now, so "has a rating" is a NOT NULL test.
 */
export async function getRestaurantReviews(query = {}) {
    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 50, 1), 1000);
    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    const skip = (page - 1) * limit;

    const where = { restaurantRating: { not: null } };

    if (query.search && String(query.search).trim()) {
        const contains = { contains: String(query.search).trim(), mode: 'insensitive' };
        where.OR = [
            { orderId: contains },
            { order_id: contains },
            { restaurantRatingComment: contains },
            { restaurant: { restaurantName: contains } },
            { user: { OR: [{ name: contains }, { email: contains }] } },
        ];
    }

    const [docs, total] = await Promise.all([
        prisma.foodOrder.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            skip,
            take: limit,
            select: {
                id: true, orderId: true, order_id: true,
                restaurantRating: true, restaurantRatingComment: true, createdAt: true,
                user: { select: { id: true, name: true, email: true, phone: true } },
                restaurant: { select: { id: true, restaurantName: true } },
            },
        }),
        prisma.foodOrder.count({ where }),
    ]);

    const reviews = docs.map((doc, index) => ({
        sl: skip + index + 1,
        orderId: doc.orderId || doc.order_id,
        restaurant: doc.restaurant?.restaurantName || 'Unknown',
        restaurantId: doc.restaurant?.id || 'N/A',
        customer: doc.user?.name || 'Unknown',
        customerId: doc.user?.id || 'N/A',
        review: doc.restaurantRatingComment || '',
        rating: doc.restaurantRating || 0,
        submittedAt: doc.createdAt,
    }));

    return { reviews, total, page, limit };
}

/**
 * App feedback, which any of the three account types can leave.
 *
 * `userId` is not a foreign key — it points at a customer, a restaurant or a
 * delivery partner depending on `userModel` — so the author is resolved by
 * looking in whichever table that names.
 */
export async function getContactMessages(query = {}) {
    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 10, 1), 100);
    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    const skip = (page - 1) * limit;

    const where = {};
    if (query.rating && !Number.isNaN(Number(query.rating))) {
        where.rating = parseInt(query.rating, 10);
    }

    if (query.search && String(query.search).trim()) {
        const term = String(query.search).trim();
        const contains = { contains: term, mode: 'insensitive' };

        const [users, restaurants, partners] = await Promise.all([
            prisma.foodUser.findMany({
                where: { OR: [{ name: contains }, { email: contains }, { phone: contains }] },
                select: { id: true },
            }),
            prisma.foodRestaurant.findMany({
                where: {
                    OR: [{ restaurantName: contains }, { ownerEmail: contains }, { ownerPhone: contains }],
                },
                select: { id: true },
            }),
            prisma.foodDeliveryPartner.findMany({
                where: { OR: [{ name: contains }, { email: contains }, { phone: contains }] },
                select: { id: true },
            }),
        ]);

        const authorIds = [...users, ...restaurants, ...partners].map((row) => row.id);
        where.OR = [
            { comment: contains },
            ...(authorIds.length ? [{ userId: { in: authorIds } }] : []),
        ];
    }

    const [list, total] = await Promise.all([
        prisma.feedbackExperience.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            skip,
            take: limit,
        }),
        prisma.feedbackExperience.count({ where }),
    ]);

    // Resolve the authors for this page in three queries, not one per row.
    const ids = [...new Set(list.map((doc) => doc.userId).filter(Boolean))];
    const [users, restaurants, partners] = ids.length
        ? await Promise.all([
            prisma.foodUser.findMany({
                where: { id: { in: ids } },
                select: { id: true, name: true, email: true, phone: true },
            }),
            prisma.foodRestaurant.findMany({
                where: { id: { in: ids } },
                select: { id: true, restaurantName: true, ownerEmail: true, ownerPhone: true },
            }),
            prisma.foodDeliveryPartner.findMany({
                where: { id: { in: ids } },
                select: { id: true, name: true, email: true, phone: true },
            }),
        ])
        : [[], [], []];

    const authors = new Map();
    for (const u of users) authors.set(u.id, { name: u.name, email: u.email, phone: u.phone });
    for (const r of restaurants) {
        authors.set(r.id, { name: r.restaurantName, email: r.ownerEmail, phone: r.ownerPhone });
    }
    for (const p of partners) authors.set(p.id, { name: p.name, email: p.email, phone: p.phone });

    const reviews = list.map((doc) => {
        const author = authors.get(doc.userId) || {};
        return {
            _id: doc.id,
            id: doc.id,
            customer: {
                name: author.name || 'Unknown',
                email: author.email || 'N/A',
                phone: author.phone || 'N/A',
            },
            comment: doc.comment || '',
            rating: doc.rating || 0,
            submittedAt: doc.createdAt,
            module: doc.module,
        };
    });

    return {
        reviews,
        pagination: { total, page, limit, totalPages: Math.ceil(total / limit) || 1 },
    };
}

/** The admin search box: a few matches from each thing an admin can open. */
export async function globalSearch(query = '') {
    const term = String(query).trim();
    if (!term) return [];

    const contains = { contains: term, mode: 'insensitive' };

    const [orders, users, restaurants, items, categories, addons] = await Promise.all([
        prisma.foodOrder.findMany({
            // orderStatus is an enum now, so it cannot be pattern-matched the
            // way the Mongo version did; the order number is what an admin
            // actually pastes in here.
            where: { OR: [{ orderId: contains }, { order_id: contains }] },
            take: 5,
            select: { id: true, orderId: true, order_id: true, orderStatus: true },
        }),
        prisma.foodUser.findMany({
            where: { role: 'USER', OR: [{ name: contains }, { email: contains }, { phone: contains }] },
            take: 5,
            select: { id: true, name: true, email: true, phone: true },
        }),
        prisma.foodRestaurant.findMany({
            where: { OR: [{ restaurantName: contains }, { ownerName: contains }, { city: contains }] },
            take: 5,
            select: { id: true, restaurantName: true, city: true, area: true, status: true },
        }),
        prisma.foodItem.findMany({
            where: { OR: [{ name: contains }, { description: contains }] },
            take: 5,
            select: { id: true, name: true, description: true, price: true },
        }),
        prisma.foodCategory.findMany({
            where: { name: contains },
            take: 3,
            select: { id: true, name: true, image: true },
        }),
        prisma.foodAddon.findMany({
            // An add-on's name and price live inside the draft Json, so this is
            // a JSON path match rather than a column comparison.
            where: { isDeleted: false, draft: { path: ['name'], string_contains: term } },
            take: 3,
            select: { id: true, draft: true },
        }),
    ]);

    return [
        ...orders.map((o) => ({
            id: o.id,
            type: 'Order',
            title: `#${o.orderId || o.order_id}`,
            description: `Status: ${o.orderStatus}`,
            path: `/admin/food/orders/all?orderId=${o.id}`,
        })),
        ...users.map((u) => ({
            id: u.id,
            type: 'User',
            title: u.name || 'Unnamed',
            description: `${u.email || u.phone || ''}`,
            path: `/admin/food/customers?userId=${u.id}`,
        })),
        ...restaurants.map((r) => ({
            id: r.id,
            type: 'Restaurant',
            title: r.restaurantName,
            description: `${r.area || ''}, ${r.city || ''} (${r.status})`,
            path: `/admin/food/restaurants?restaurantId=${r.id}`,
        })),
        ...items.map((i) => ({
            id: i.id,
            type: 'Product',
            title: i.name,
            description: `Price: ₹${Number(i.price)}`,
            path: `/admin/food/foods?productId=${i.id}`,
        })),
        ...categories.map((c) => ({
            id: c.id,
            type: 'Category',
            title: c.name,
            description: 'Menu Category',
            path: '/admin/food/categories',
        })),
        ...addons.map((a) => ({
            id: a.id,
            type: 'Addon',
            title: a.draft?.name || 'Addon',
            description: `Price: ₹${Number(a.draft?.price) || 0}`,
            path: '/admin/food/addons',
        })),
    ];
}
