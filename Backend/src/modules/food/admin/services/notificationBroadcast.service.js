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

/**
 * Make a coupon usable by the people this campaign is about to reach.
 *
 * A win-back message saying "here is 50% off" is worth nothing if the code
 * is refused, so for a customer-specific coupon the recipients are added to
 * its allow-list as the campaign goes out. Coupons open to everyone need no
 * grant; the code simply travels with the message.
 *
 * Only customers are granted. A restaurant or rider in a mixed audience has
 * no place on a customer coupon allow-list, and adding their ids would put
 * entries there that can never match a signed-in customer.
 */
const attachCouponToAudience = async (couponId, targets = []) => {
    if (!isId(couponId)) return null;

    const offer = await prisma.foodOffer.findUnique({
        where: { id: String(couponId) },
        select: { id: true, couponCode: true, customerScope: true, customerIds: true, status: true },
    });
    if (!offer) throw new ValidationError('The selected coupon no longer exists');
    if (offer.status !== 'active') {
        // Sending a code that is switched off produces a message customers
        // act on and cannot use.
        throw new ValidationError(`Coupon ${offer.couponCode} is not active`);
    }

    if (offer.customerScope !== 'specific') {
        return { id: offer.id, code: offer.couponCode, granted: 0 };
    }

    const existing = new Set((offer.customerIds || []).map(String));
    const toAdd = targets
        .filter((t) => t.ownerType === 'USER')
        .map((t) => String(t.ownerId))
        .filter((id) => isId(id) && !existing.has(id));

    if (toAdd.length) {
        await prisma.foodOffer.update({
            where: { id: offer.id },
            // Written as the union rather than a push, so re-running a
            // campaign cannot list the same customer twice.
            data: { customerIds: [...existing, ...toAdd] },
        });
    }

    return { id: offer.id, code: offer.couponCode, granted: toAdd.length };
};

/**
 * Put the coupon code in the message, unless the admin already did.
 *
 * A campaign that attaches a coupon but never names it leaves the customer
 * with a discount they cannot find. Appending it here rather than in the admin
 * screen means the stored message, the inbox entry and the push body all carry
 * the same text -- appending in three places is three chances for them to
 * drift.
 *
 * The check is case-insensitive and looks for the bare code, so an admin who
 * wrote "use winback25 today" does not get it repeated back at them.
 */
const withCouponCode = (message, code) => {
    const trimmed = String(message || '').trim();
    const couponCode = String(code || '').trim();
    if (!couponCode) return trimmed;

    // Coupon codes are uppercased alphanumerics by the validator, so the
    // common case needs no regex escaping at all. Anything unexpected falls
    // back to a plain substring test rather than being compiled into a
    // pattern.
    const simple = /^[A-Z0-9_-]+$/i.test(couponCode);
    const mentioned = simple
        ? new RegExp(`\\b${couponCode}\\b`, 'i').test(trimmed)
        : trimmed.toUpperCase().includes(couponCode.toUpperCase());
    if (mentioned) return trimmed;

    return `${trimmed}

Use code ${couponCode}`;
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

    // Before the message, not after: a customer who reads it and tries the
    // code immediately should find it already works.
    const coupon = await attachCouponToAudience(body?.couponId, resolvedTargets);

    // One place, so every copy of the text below says the same thing.
    const finalMessage = withCouponCode(message, coupon?.code);

    const broadcast = await prisma.notificationBroadcast.create({
        data: {
            title,
            message: finalMessage,
            link,
            targetType,
            couponId: coupon?.id || null,
            couponCode: coupon?.code || '',
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
            message: finalMessage,
            link,
            category: 'broadcast',
            broadcastId: broadcast.id,
            metadata: {
                broadcastId: broadcast.id,
                ownerLabel: target.label || '',
                ownerSubLabel: target.subLabel || '',
                // So the app can show the code as something tappable rather
                // than leaving the customer to retype it out of the message.
                couponCode: coupon?.code || '',
            },
        })),
    });

    await notifyOwnersSafely(
        resolvedTargets.map(({ ownerType, ownerId }) => ({ ownerType, ownerId })),
        {
            title,
            body: finalMessage,
            data: {
                type: 'admin_broadcast',
                broadcastId: broadcast.id,
                link,
                couponCode: coupon?.code || '',
            },
        }
    );

    emitRealtimeNotifications(resolvedTargets, broadcast);

    return {
        broadcast,
        targetPreview: resolvedTargets.slice(0, 10),
        // How many recipients were newly granted the coupon, which is not
        // the audience size: anyone already on the allow-list is not counted
        // again.
        coupon,
    };
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
