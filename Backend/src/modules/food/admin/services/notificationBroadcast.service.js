import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { ValidationError, NotFoundError } from '../../../../core/auth/errors.js';
import { createInboxNotifications } from '../../../../core/notifications/notification.service.js';
import { notifyOwnersSafely } from '../../../../core/notifications/firebase.service.js';
import { getIO, rooms } from '../../../../config/socket.js';

/**
 * Admin broadcasts: one message fanned out to every customer, restaurant or
 * rider — or to a hand-picked list.
 *
 * The audience is snapshotted onto the broadcast row as `targets`, so the
 * history still shows who it went to after those accounts change or leave.
 */

const TARGET_TYPES = new Set(['ALL', 'USER', 'RESTAURANT', 'DELIVERY', 'CUSTOM', 'LAPSED']);

const OWNER_LABEL = {
    USER: 'Users',
    LAPSED: 'Lapsed customers',
    RESTAURANT: 'Restaurants',
    DELIVERY_PARTNER: 'Delivery Partners',
};

const normalizeText = (value, fieldName, required = true) => {
    const text = String(value || '').trim();
    if (required && !text) throw new ValidationError(`${fieldName} is required`);
    return text;
};

const requireId = (value, fieldName) => {
    if (!isId(value)) throw new ValidationError(`${fieldName} is invalid`);
    return String(value);
};

const join = (...parts) => parts.filter(Boolean).join(' • ');

/**
 * Who each audience is and how a row of it is labelled. Only accounts that can
 * actually receive the message are included — a suspended restaurant or an
 * unapproved rider is not an audience.
 */
const AUDIENCES = {
    USER: {
        load: (where) => prisma.foodUser.findMany({
            where: { isActive: true, ...where },
            select: { id: true, name: true, phone: true, email: true },
        }),
        label: (row) => ({
            label: String(row.name || row.phone || 'User').trim(),
            subLabel: join(row.phone, row.email),
        }),
    },
    RESTAURANT: {
        load: (where) => prisma.foodRestaurant.findMany({
            where: { status: 'approved', ...where },
            select: {
                id: true, restaurantName: true, ownerName: true,
                ownerPhone: true, ownerEmail: true,
            },
        }),
        label: (row) => ({
            label: String(row.restaurantName || row.ownerName || 'Restaurant').trim(),
            subLabel: join(row.ownerPhone, row.ownerEmail),
        }),
    },
    DELIVERY_PARTNER: {
        load: (where) => prisma.foodDeliveryPartner.findMany({
            where: { status: 'approved', ...where },
            select: { id: true, name: true, phone: true, email: true },
        }),
        label: (row) => ({
            label: String(row.name || row.phone || 'Delivery Partner').trim(),
            subLabel: join(row.phone, row.email),
        }),
    },
};

const loadAudience = async (ownerType, where = {}) => {
    const audience = AUDIENCES[ownerType];
    if (!audience) return [];
    const rows = await audience.load(where);
    return rows.map((row) => ({ ownerType, ownerId: row.id, ...audience.label(row) }));
};

/** Last write wins per recipient, so a duplicated id is sent to once. */
const dedupeTargets = (targets = []) => {
    const map = new Map();
    for (const target of Array.isArray(targets) ? targets : []) {
        const ownerType = String(target?.ownerType || '').trim().toUpperCase();
        const ownerId = String(target?.ownerId || '').trim();
        if (!ownerType || !isId(ownerId)) continue;
        map.set(`${ownerType}:${ownerId}`, {
            ownerType,
            ownerId,
            label: String(target?.label || '').trim(),
            subLabel: String(target?.subLabel || '').trim(),
        });
    }
    return [...map.values()];
};

/**
 * Customers worth winning back: they ordered once, and then stopped.
 *
 * "Stopped" is measured from their last order rather than their last login,
 * because there is no last-login column on the user -- and an order is the
 * better signal anyway. Someone browsing weekly without buying is not lapsed
 * in any sense that matters.
 *
 * Customers who have never ordered at all are a different problem and are
 * excluded by default: they need onboarding, not a "we miss you" message
 * about an order they never placed. `includeNeverOrdered` opts into them,
 * measuring their silence from signup instead.
 */
export const getLapsedCustomers = async ({
    days = 30,
    includeNeverOrdered = false,
    limit = 1000,
} = {}) => {
    const dayCount = Math.max(1, Math.min(3650, Number(days) || 30));
    const cutoff = new Date(Date.now() - dayCount * 24 * 60 * 60 * 1000);
    const take = Math.max(1, Math.min(5000, Number(limit) || 1000));

    const users = await prisma.foodUser.findMany({
        where: { isActive: true },
        select: {
            id: true, name: true, phone: true, email: true, createdAt: true,
            fcmTokens: true, fcmTokenMobile: true,
        },
    });
    if (!users.length) return { cutoff, days: dayCount, customers: [] };

    // One grouped query rather than a lastOrderAt column on the user, which
    // would have to be kept correct on every order write and would drift the
    // first time one of those paths forgot.
    const lastOrders = await prisma.foodOrder.groupBy({
        by: ['userId'],
        where: { userId: { in: users.map((u) => u.id) } },
        _max: { createdAt: true },
        _count: { _all: true },
    });
    const byUser = new Map(lastOrders.map((row) => [row.userId, row]));

    const customers = [];
    for (const user of users) {
        const stats = byUser.get(user.id);
        const lastOrderAt = stats?._max?.createdAt || null;

        if (!lastOrderAt) {
            if (!includeNeverOrdered) continue;
            // Silence measured from signup: a customer who registered
            // yesterday and has not ordered is not lapsed, they are new.
            if (new Date(user.createdAt) > cutoff) continue;
        } else if (new Date(lastOrderAt) > cutoff) {
            continue;
        }

        const since = lastOrderAt || user.createdAt;
        customers.push({
            id: user.id,
            name: user.name || '',
            phone: user.phone || '',
            email: user.email || '',
            lastOrderAt,
            totalOrders: stats?._count?._all || 0,
            daysSince: Math.floor((Date.now() - new Date(since).getTime()) / 86400000),
            // Whether a push can actually reach them. An inbox notification is
            // still written either way, but an admin planning a campaign
            // should see how much of it will land silently.
            reachableByPush:
                (user.fcmTokens?.length || 0) + (user.fcmTokenMobile?.length || 0) > 0,
        });
    }

    customers.sort((a, b) => b.daysSince - a.daysSince);

    return {
        days: dayCount,
        cutoff,
        includeNeverOrdered: Boolean(includeNeverOrdered),
        total: customers.length,
        reachableByPush: customers.filter((c) => c.reachableByPush).length,
        customers: customers.slice(0, take),
    };
};

const resolveCustomTargets = async ({ targets = [], targetIds = [] } = {}) => {
    // The panel normally sends the full rows it rendered; ids are the fallback.
    const explicit = dedupeTargets(targets);
    if (explicit.length > 0) return explicit;

    const ids = [...new Set(
        (Array.isArray(targetIds) ? targetIds : []).map((v) => String(v || '').trim()).filter(isId)
    )];
    if (!ids.length) {
        throw new ValidationError('Please select at least one recipient for custom broadcast');
    }

    return loadAudience('USER', { id: { in: ids } });
};

const resolveTargets = async ({ targetType, targetIds = [], targets = [], lapsedDays, lapsedIncludeNeverOrdered } = {}) => {
    if (targetType === 'CUSTOM') return resolveCustomTargets({ targets, targetIds });
    if (targetType === 'LAPSED') {
        // Resolved now, not when the campaign was drafted: a customer who
        // ordered in the meantime should not be told they are missed.
        const { customers } = await getLapsedCustomers({
            days: lapsedDays,
            includeNeverOrdered: lapsedIncludeNeverOrdered,
        });
        return customers.map((c) => ({
            ownerType: 'USER',
            ownerId: c.id,
            label: String(c.name || c.phone || 'User').trim(),
            subLabel: join(c.phone, c.email),
        }));
    }
    if (targetType === 'USER') return loadAudience('USER');
    if (targetType === 'RESTAURANT') return loadAudience('RESTAURANT');
    if (targetType === 'DELIVERY') return loadAudience('DELIVERY_PARTNER');

    if (targetType === 'ALL') {
        const all = await Promise.all(
            ['USER', 'RESTAURANT', 'DELIVERY_PARTNER'].map((type) => loadAudience(type))
        );
        return all.flat();
    }

    throw new ValidationError('Unsupported targetType');
};

const ROOM_BY_OWNER_TYPE = {
    USER: rooms.user,
    RESTAURANT: rooms.restaurant,
    DELIVERY_PARTNER: rooms.delivery,
};

const emitRealtimeNotifications = (targets = [], broadcast) => {
    const io = getIO();
    if (!io) return;

    const payload = {
        id: broadcast.id,
        title: broadcast.title,
        message: broadcast.message,
        link: broadcast.link || '',
        targetType: broadcast.targetType,
        createdAt: broadcast.createdAt,
    };

    for (const target of targets) {
        const room = ROOM_BY_OWNER_TYPE[target.ownerType];
        if (room && target.ownerId) io.to(room(target.ownerId)).emit('admin_notification', payload);
    }
};

export const createBroadcastNotification = async ({ body = {}, adminId } = {}) => {
    const title = normalizeText(body?.title, 'title');
    const message = normalizeText(body?.message, 'message');
    const link = normalizeText(body?.link, 'link', false);

    const targetType = String(body?.targetType || '').trim().toUpperCase();
    if (!TARGET_TYPES.has(targetType)) throw new ValidationError('targetType is invalid');

    const createdById = requireId(adminId, 'createdBy');

    const resolvedTargets = await resolveTargets({
        targetType,
        targetIds: body?.targetIds,
        targets: body?.targets,
        lapsedDays: body?.lapsedDays,
        lapsedIncludeNeverOrdered: body?.lapsedIncludeNeverOrdered,
    });
    if (!resolvedTargets.length) {
        throw new ValidationError(`No recipients found for ${targetType.toLowerCase()} broadcast`);
    }

    const broadcast = await prisma.notificationBroadcast.create({
        data: {
            title,
            message,
            link,
            targetType,
            // Only a custom broadcast has an explicit id list; the rest are
            // "everyone who matched at the time", which `targets` records.
            targetIds: targetType === 'CUSTOM' ? resolvedTargets.map((t) => t.ownerId) : [],
            targets: resolvedTargets,
            createdById,
            targetCount: resolvedTargets.length,
        },
    });

    await createInboxNotifications({
        notifications: resolvedTargets.map((target) => ({
            ownerType: target.ownerType,
            ownerId: target.ownerId,
            title,
            message,
            link,
            category: 'broadcast',
            broadcastId: broadcast.id,
            metadata: {
                broadcastId: broadcast.id,
                ownerLabel: target.label || '',
                ownerSubLabel: target.subLabel || '',
            },
        })),
    });

    await notifyOwnersSafely(
        resolvedTargets.map(({ ownerType, ownerId }) => ({ ownerType, ownerId })),
        { title, body: message, data: { type: 'admin_broadcast', broadcastId: broadcast.id, link } }
    );

    emitRealtimeNotifications(resolvedTargets, broadcast);

    return { broadcast, targetPreview: resolvedTargets.slice(0, 10) };
};

export const getBroadcastNotifications = async ({ page = 1, limit = 10 } = {}) => {
    const nextPage = Math.max(1, Number(page) || 1);
    const nextLimit = Math.max(1, Math.min(100, Number(limit) || 10));

    const [items, total] = await Promise.all([
        prisma.notificationBroadcast.findMany({
            orderBy: { createdAt: 'desc' },
            skip: (nextPage - 1) * nextLimit,
            take: nextLimit,
            include: { createdBy: { select: { id: true, name: true, email: true } } },
        }),
        prisma.notificationBroadcast.count(),
    ]);

    return {
        items: items.map((item) => ({
            ...item,
            _id: item.id,
            targetLabel: item.targetType === 'CUSTOM'
                ? `${item.targetCount || (Array.isArray(item.targets) ? item.targets.length : 0)} selected recipients`
                : OWNER_LABEL[item.targetType] || item.targetType,
        })),
        pagination: {
            page: nextPage,
            limit: nextLimit,
            total,
            totalPages: Math.max(1, Math.ceil(total / nextLimit)),
        },
    };
};

export const deleteBroadcastNotification = async (broadcastId) => {
    const id = requireId(broadcastId, 'broadcastId');

    const broadcast = await prisma.notificationBroadcast.findUnique({ where: { id } });
    if (!broadcast) throw new NotFoundError('Broadcast notification not found');

    // The inbox rows cascade from the FK, so they are counted before the delete
    // rather than removed in a second statement that could fail on its own.
    const deletedInboxCount = await prisma.foodNotification.count({ where: { broadcastId: id } });
    await prisma.notificationBroadcast.delete({ where: { id } });

    return { broadcast, deletedInboxCount };
};
