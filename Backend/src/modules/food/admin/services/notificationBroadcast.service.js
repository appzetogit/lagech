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

const TARGET_TYPES = new Set(['ALL', 'USER', 'RESTAURANT', 'DELIVERY', 'CUSTOM']);

const OWNER_LABEL = {
    USER: 'Users',
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

const resolveTargets = async ({ targetType, targetIds = [], targets = [] } = {}) => {
    if (targetType === 'CUSTOM') return resolveCustomTargets({ targets, targetIds });
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
