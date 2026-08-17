import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { sendNotificationToOwner } from '../../../../core/notifications/firebase.service.js';
import { getRestaurantSubscriptionSettings } from './adminSettings.service.js';
import { getAdminRestaurantSubscriptionHistory as historyFromRestaurant } from '../../restaurant/services/subscriptionHistory.service.js';

/**
 * Rider support tickets, bonus history, reviews and the subscription pricing
 * table — extracted from admin.service.js.
 *
 * These share nothing but their home; they are grouped because each is small
 * and none of them belongs to a domain already lifted out.
 */

const TICKET_STATUSES = ['open', 'in_progress', 'resolved', 'closed'];

const PARTNER_SUMMARY = { select: { id: true, name: true, phone: true, email: true } };

/** Everything a rider ticket row shows. */
const serializeTicket = (t) => ({
    _id: t.id,
    id: t.id,
    ticketId: t.ticketId,
    subject: t.subject,
    description: t.description,
    category: t.category,
    priority: t.priority,
    status: t.status,
    adminResponse: t.adminResponse,
    respondedAt: t.respondedAt,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    deliveryPartner: t.deliveryPartner
        ? {
            _id: t.deliveryPartner.id,
            name: t.deliveryPartner.name || '',
            phone: t.deliveryPartner.phone || '',
            email: t.deliveryPartner.email || '',
        }
        : null,
});

/**
 * The rider wallet list is served from adminDeliveryWallet.service.js.
 *
 * ponytail: this stub predates that and always returned an empty page. Kept
 * because a route still points at it; delete both together.
 */
export function getDeliveryWalletsStub() {
    return { wallets: [], pagination: { page: 1, limit: 100, total: 0, pages: 0 } };
}

export async function getSupportTicketStats() {
    // One grouped query rather than four counts.
    const rows = await prisma.deliverySupportTicket.groupBy({
        by: ['status'],
        _count: { _all: true },
    });

    const counts = { total: 0, open: 0, inProgress: 0, resolved: 0, closed: 0 };
    for (const row of rows) {
        counts.total += row._count._all;
        if (row.status === 'open') counts.open = row._count._all;
        if (row.status === 'in_progress') counts.inProgress = row._count._all;
        if (row.status === 'resolved') counts.resolved = row._count._all;
        if (row.status === 'closed') counts.closed = row._count._all;
    }
    return counts;
}

export async function getDeliverySupportTickets(query = {}) {
    const limit = Math.max(1, Math.min(500, Number(query.limit) || 100));
    const page = Math.max(1, Number(query.page) || 1);
    const skip = (page - 1) * limit;

    const where = {};
    if (TICKET_STATUSES.includes(String(query.status || '').trim())) {
        where.status = String(query.status).trim();
    }
    if (query.priority && String(query.priority).trim()) {
        where.priority = String(query.priority).trim();
    }

    if (query.search && String(query.search).trim()) {
        const contains = { contains: String(query.search).trim(), mode: 'insensitive' };
        where.OR = [{ subject: contains }, { description: contains }, { ticketId: contains }];
    }

    const [list, total] = await Promise.all([
        prisma.deliverySupportTicket.findMany({
            where,
            include: { deliveryPartner: PARTNER_SUMMARY },
            orderBy: { createdAt: 'desc' },
            skip,
            take: limit,
        }),
        prisma.deliverySupportTicket.count({ where }),
    ]);

    return {
        tickets: list.map(serializeTicket),
        pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 },
    };
}

export async function updateDeliverySupportTicket(id, body = {}) {
    if (!isId(id)) return null;

    const existing = await prisma.deliverySupportTicket.findUnique({ where: { id: String(id) } });
    if (!existing) return null;

    const { status, adminResponse } = body;
    const data = {};

    if (status !== undefined && TICKET_STATUSES.includes(String(status))) {
        data.status = String(status);
    }

    let replied = false;
    if (adminResponse !== undefined) {
        data.adminResponse = typeof adminResponse === 'string' ? adminResponse.trim() : '';
        if (data.adminResponse) {
            data.respondedAt = new Date();
            replied = true;
        }
    }

    const ticket = await prisma.deliverySupportTicket.update({
        where: { id: existing.id },
        data,
        include: { deliveryPartner: PARTNER_SUMMARY },
    });

    if (replied && ticket.deliveryPartnerId) {
        const message = `Admin has responded to your ticket: "${ticket.subject}"`;

        await prisma.foodNotification
            .create({
                data: {
                    ownerType: 'DELIVERY_PARTNER',
                    ownerId: ticket.deliveryPartnerId,
                    title: 'Support Ticket Response',
                    message,
                    source: 'SUPPORT_RESPONSE',
                    category: 'support',
                    metadata: { ticketId: ticket.id },
                },
            })
            .catch((err) => console.error('Error creating delivery support notification:', err));

        await sendNotificationToOwner({
            ownerType: 'DELIVERY_PARTNER',
            ownerId: ticket.deliveryPartnerId,
            payload: {
                title: 'Support Ticket Response',
                body: message,
                data: { type: 'SUPPORT_RESPONSE', ticketId: ticket.id },
            },
        }).catch((err) => console.error('Error sending delivery support push notification:', err));
    }

    return serializeTicket(ticket);
}

// ─── Subscription pricing ────────────────────────────────────────────────────

/**
 * The GMV bands that decide a restaurant's monthly plan.
 *
 * The bands have to stay ordered and contiguous, or a restaurant's turnover
 * could fall into a gap and match no plan — or into two and match the wrong
 * one. The clamping below is what guarantees that, and it runs after the edit
 * rather than trusting the admin form to be self-consistent.
 */
export const updateRestaurantSubscriptionSettings = async (data = {}) => {
    const nonNegative = (value) => Math.max(0, Number(value) || 0);

    const saved = await prisma.$transaction(async (tx) => {
        const existing = await tx.foodRestaurantSubscriptionSettings.findFirst({
            orderBy: { createdAt: 'desc' },
        });

        // Built key by key rather than spreading the row: the read carries an
        // `_id` alias and the timestamps, none of which are writable.
        const next = {};
        for (const key of [
            'starterPrice', 'growthPrice', 'premiumPrice',
            'starterMinGmv', 'starterMaxGmv',
            'growthMinGmv', 'growthMaxGmv',
            'premiumMinGmv', 'onboardingFee',
        ]) {
            next[key] = nonNegative(data[key] !== undefined ? data[key] : existing?.[key]);
        }

        // Keep the ladder monotonic: each band starts where the last one ended.
        next.starterMinGmv = Math.min(next.starterMinGmv, next.starterMaxGmv);
        if (next.growthMinGmv < next.starterMaxGmv) next.growthMinGmv = next.starterMaxGmv;
        if (next.growthMaxGmv < next.growthMinGmv) next.growthMaxGmv = next.growthMinGmv;
        if (next.premiumMinGmv < next.growthMaxGmv) next.premiumMinGmv = next.growthMaxGmv;

        return existing
            ? tx.foodRestaurantSubscriptionSettings.update({ where: { id: existing.id }, data: next })
            : tx.foodRestaurantSubscriptionSettings.create({ data: next });
    });

    // Returned through the shared reader so callers get one shape, with the
    // same defaults applied.
    return getRestaurantSubscriptionSettings();
};

export const getAdminRestaurantSubscriptionHistory = async (query = {}) =>
    historyFromRestaurant(query);

// ─── Rider bonus history ─────────────────────────────────────────────────────

export async function getDeliveryPartnerBonusTransactions(query = {}) {
    const limit = Math.max(1, Math.min(1000, Number(query.limit) || 100));
    const page = Math.max(1, Number(query.page) || 1);
    const skip = (page - 1) * limit;

    const where = {};
    if (query.search && typeof query.search === 'string' && query.search.trim()) {
        const contains = { contains: query.search.trim(), mode: 'insensitive' };
        // The rider's details live on another table, so this reaches through the
        // relation rather than pre-resolving an id list.
        where.OR = [
            { transactionId: contains },
            {
                deliveryPartner: {
                    OR: [{ name: contains }, { phone: contains }, { email: contains }],
                },
            },
        ];
    }

    const [list, total] = await Promise.all([
        prisma.deliveryBonusTransaction.findMany({
            where,
            include: { deliveryPartner: PARTNER_SUMMARY },
            orderBy: { createdAt: 'desc' },
            skip,
            take: limit,
        }),
        prisma.deliveryBonusTransaction.count({ where }),
    ]);

    const transactions = list.map((t, index) => ({
        sl: skip + index + 1,
        transactionId: t.transactionId,
        deliveryPartnerId: t.deliveryPartnerId,
        deliveryId: t.deliveryPartnerId ? `DP-${t.deliveryPartnerId.slice(-8).toUpperCase()}` : null,
        deliveryman: t.deliveryPartner?.name || '',
        // Decimal, so it would otherwise reach the admin table as a string.
        amount: Number(t.amount),
        bonus: Number(t.amount), // legacy key the older screen still reads
        reference: t.reference || '',
        createdAt: t.createdAt,
    }));

    return {
        transactions,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 },
    };
}

// ─── Rider reviews ───────────────────────────────────────────────────────────

/**
 * Ratings customers left on their rider.
 *
 * Mongo kept these in a `ratings.deliveryPartner` subdocument and filtered on
 * its existence; they are plain columns now, so it is a NOT NULL test.
 */
export async function getDeliverymanReviews(query = {}) {
    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 50, 1), 1000);
    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    const skip = (page - 1) * limit;

    const where = { partnerRating: { not: null } };

    if (query.search && String(query.search).trim()) {
        const contains = { contains: String(query.search).trim(), mode: 'insensitive' };
        where.OR = [
            { orderId: contains },
            { order_id: contains },
            { partnerRatingComment: contains },
            { deliveryPartner: { OR: [{ name: contains }, { phone: contains }] } },
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
                partnerRating: true, partnerRatingComment: true,
                createdAt: true, deliveredAt: true,
                user: { select: { id: true, name: true, email: true, phone: true } },
                deliveryPartner: { select: { id: true, name: true, phone: true } },
            },
        }),
        prisma.foodOrder.count({ where }),
    ]);

    const reviews = docs.map((doc, index) => ({
        sl: skip + index + 1,
        orderId: doc.orderId || doc.order_id,
        deliveryman: doc.deliveryPartner?.name || 'Unknown',
        deliverymanId: doc.deliveryPartner?.id || 'N/A',
        deliverymanPhone: doc.deliveryPartner?.phone || 'N/A',
        customer: doc.user?.name || 'Unknown',
        customerId: doc.user?.id || 'N/A',
        customerPhone: doc.user?.phone || 'N/A',
        review: doc.partnerRatingComment || '',
        rating: doc.partnerRating || 0,
        submittedAt: doc.deliveredAt || doc.createdAt,
    }));

    return { reviews, total, page, limit };
}
