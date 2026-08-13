import { Prisma } from '@prisma/client';
import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { ValidationError, ForbiddenError } from '../../../../core/auth/errors.js';
import { getIO, rooms } from '../../../../config/socket.js';
import { notifyOwnersSafely } from '../../orders/services/order.helpers.js';
import { notifyAdminsSafely } from '../../../../core/notifications/firebase.service.js';
import { logger } from '../../../../utils/logger.js';

const ROLES = ['USER', 'RESTAURANT', 'DELIVERY_PARTNER', 'ADMIN'];

/** The order columns that decide who may talk to whom. */
const ORDER_PARTIES = { userId: true, restaurantId: true, deliveryPartnerId: true };

/** Stable identifier for a participant. ADMIN carries no id (shared inbox). */
export const partyToken = (role, id) => (role === 'ADMIN' ? 'ADMIN' : `${role}:${String(id)}`);

/** Deterministic conversation id — same two parties (+ order) always collide to one thread. */
const buildConversationId = (tokenA, tokenB, orderId) => {
    const scope = orderId ? String(orderId) : 'direct';
    return `${scope}::${[tokenA, tokenB].sort().join('|')}`;
};

/** Socket room a party listens on. */
const roomForToken = (role, id) => {
    if (role === 'ADMIN') return rooms.admin();
    if (role === 'USER') return rooms.user(id);
    if (role === 'RESTAURANT') return rooms.restaurant(id);
    if (role === 'DELIVERY_PARTNER') return rooms.delivery(id);
    return null;
};

const loadOrderParties = async (orderId) => {
    if (!isId(orderId)) throw new ValidationError('Invalid order id');
    const order = await prisma.foodOrder.findUnique({
        where: { id: String(orderId) },
        select: ORDER_PARTIES,
    });
    if (!order) throw new ValidationError('Order not found');
    return order;
};

/** Both non-admin parties must actually belong to the order they're chatting about. */
async function assertOrderParticipants(orderId, tokens) {
    const order = await loadOrderParties(orderId);

    const orderTokens = new Set(
        [
            order.userId && partyToken('USER', order.userId),
            order.restaurantId && partyToken('RESTAURANT', order.restaurantId),
            order.deliveryPartnerId && partyToken('DELIVERY_PARTNER', order.deliveryPartnerId),
        ].filter(Boolean)
    );

    for (const t of tokens) {
        if (t === 'ADMIN') continue; // admin may join any order thread
        if (!orderTokens.has(t)) {
            throw new ForbiddenError('You are not a participant of this order');
        }
    }
}

/**
 * Work out who the message is for, from the ORDER — never from a client-supplied peerId,
 * which a caller could point at an unrelated user.
 *
 * With only { orderId, text } the counterpart is implied: a customer is writing to the
 * assigned rider and vice versa. peerRole is honoured when supplied so a restaurant can
 * pick which side of the order it is addressing.
 */
function resolveOrderRecipient(sender, order, requestedPeerRole = '') {
    const parties = {
        USER: order?.userId ? String(order.userId) : '',
        DELIVERY_PARTNER: order?.deliveryPartnerId ? String(order.deliveryPartnerId) : '',
        RESTAURANT: order?.restaurantId ? String(order.restaurantId) : '',
    };

    // The sender must actually be on this order.
    if (String(parties[sender.role] || '') !== String(sender.id)) {
        throw new ForbiddenError('You are not a participant of this order');
    }

    if (requestedPeerRole) {
        const role = String(requestedPeerRole).toUpperCase();
        if (!parties[role]) {
            throw new ValidationError(
                role === 'DELIVERY_PARTNER'
                    ? 'No delivery partner is assigned to this order yet'
                    : `This order has no ${role.toLowerCase()} to message`
            );
        }
        if (role === sender.role) throw new ValidationError('Cannot message yourself');
        return { role, id: parties[role] };
    }

    // Default counterpart: customer <-> assigned rider.
    if (sender.role === 'USER') {
        if (!parties.DELIVERY_PARTNER) {
            throw new ValidationError('No delivery partner is assigned to this order yet');
        }
        return { role: 'DELIVERY_PARTNER', id: parties.DELIVERY_PARTNER };
    }
    if (sender.role === 'DELIVERY_PARTNER') {
        if (!parties.USER) throw new ValidationError('This order has no customer to message');
        return { role: 'USER', id: parties.USER };
    }
    // A restaurant has two possible counterparts, so it must say which.
    throw new ValidationError('peerRole is required for this sender');
}

/** True for the customer<->rider pair, whose thread is keyed on the order id itself. */
const isUserRiderPair = (roleA, roleB) =>
    [roleA, roleB].sort().join('|') === 'DELIVERY_PARTNER|USER';

export async function sendMessage(sender, dto) {
    const text = String(dto?.text || '').trim();
    if (!text) throw new ValidationError('Message text is required');
    if (text.length > 2000) throw new ValidationError('Message is too long (max 2000 chars)');

    const requestedPeerRole = String(dto?.peerRole || '').toUpperCase();
    if (requestedPeerRole && !ROLES.includes(requestedPeerRole)) {
        throw new ValidationError('Invalid peerRole');
    }

    const orderIdRaw = dto?.orderId ? String(dto.orderId) : '';
    const adminInvolved = sender.role === 'ADMIN' || requestedPeerRole === 'ADMIN';

    // Non-admin conversations must be tied to a shared order (anti-spam).
    if (!adminInvolved && !orderIdRaw) {
        throw new ValidationError('orderId is required to chat outside of admin support');
    }

    let orderId = null;
    let peerRole;
    let peerId;

    if (orderIdRaw && !adminInvolved) {
        const order = await loadOrderParties(orderIdRaw);
        orderId = orderIdRaw;

        const peer = resolveOrderRecipient(sender, order, requestedPeerRole);
        peerRole = peer.role;
        peerId = peer.id;
    } else {
        // Admin support thread: no order, so the peer must be stated.
        peerRole = requestedPeerRole || 'ADMIN';
        if (peerRole !== 'ADMIN') {
            if (!isId(dto?.peerId)) {
                throw new ValidationError('peerId is required for non-admin recipients');
            }
            peerId = String(dto.peerId);
        }
        if (isId(orderIdRaw)) orderId = orderIdRaw;
    }

    const senderToken = partyToken(sender.role, sender.id);
    const recipientToken = partyToken(peerRole, peerId);

    // Customer <-> rider threads are keyed on the order id exactly, because the
    // client looks the thread up by the order id it already holds.
    const conversationId =
        orderId && isUserRiderPair(sender.role, peerRole)
            ? String(orderId)
            : buildConversationId(senderToken, recipientToken, orderId);

    const message = await prisma.foodChatMessage.create({
        data: {
            conversationId,
            orderId,
            senderRole: sender.role,
            senderId: String(sender.id),
            senderToken,
            recipientRole: peerRole,
            recipientId: peerRole === 'ADMIN' ? null : String(peerId),
            recipientToken,
            participants: [senderToken, recipientToken],
            text,
        },
    });

    const payload = serializeMessage(message);

    // Live delivery — emit to the recipient's room and echo to the sender's own other devices.
    try {
        const io = getIO();
        if (io) {
            const recipientRoom = roomForToken(peerRole, peerId);
            const senderRoom = roomForToken(sender.role, sender.id);
            if (recipientRoom) io.to(recipientRoom).emit('chat:message', payload);
            if (senderRoom && senderRoom !== recipientRoom) io.to(senderRoom).emit('chat:message', payload);
        }
    } catch (err) {
        logger.warn(`chat socket emit failed: ${err?.message || err}`);
    }

    // Push to the recipient (FCM handles foreground suppression on-device).
    const pushPayload = {
        title: chatTitle(sender.role),
        body: text.slice(0, 120),
        data: { type: 'chat_message', conversationId, orderId: orderId ? String(orderId) : '' },
    };
    if (peerRole === 'ADMIN') {
        notifyAdminsSafely(pushPayload).catch(() => {});
    } else {
        notifyOwnersSafely([{ ownerType: peerRole, ownerId: peerId }], pushPayload).catch(() => {});
    }

    return payload;
}

const chatTitle = (senderRole) => {
    if (senderRole === 'USER') return 'New message from customer';
    if (senderRole === 'RESTAURANT') return 'New message from restaurant';
    if (senderRole === 'DELIVERY_PARTNER') return 'New message from delivery partner';
    if (senderRole === 'ADMIN') return 'New message from support';
    return 'New message';
};

export function serializeMessage(row) {
    return {
        id: String(row.id),
        conversationId: row.conversationId,
        orderId: row.orderId ? String(row.orderId) : null,
        senderRole: row.senderRole,
        senderId: String(row.senderId),
        recipientRole: row.recipientRole,
        recipientId: row.recipientId ? String(row.recipientId) : null,
        text: row.text,
        readAt: row.readAt || null,
        createdAt: row.createdAt,
    };
}

/** History for one conversation. Marks messages TO me as read as a side effect. */
export async function getHistory(me, { conversationId, page = 1, limit = 30 }) {
    if (!conversationId) throw new ValidationError('conversationId is required');
    const myToken = partyToken(me.role, me.id);

    const first = await prisma.foodChatMessage.findFirst({
        where: { conversationId },
        select: { participants: true },
    });
    if (!first) return { messages: [], pagination: { page: 1, limit, total: 0, totalPages: 1 } };
    if (!first.participants.includes(myToken)) {
        throw new ForbiddenError('Not your conversation');
    }

    const p = Math.max(1, parseInt(page, 10) || 1);
    const l = Math.min(Math.max(parseInt(limit, 10) || 30, 1), 100);

    const [docs, total] = await Promise.all([
        prisma.foodChatMessage.findMany({
            where: { conversationId },
            orderBy: { createdAt: 'desc' },
            skip: (p - 1) * l,
            take: l,
        }),
        prisma.foodChatMessage.count({ where: { conversationId } }),
    ]);

    await markRead(me, conversationId);

    return {
        messages: docs.map(serializeMessage).reverse(), // oldest → newest for UI
        pagination: { page: p, limit: l, total, totalPages: Math.max(1, Math.ceil(total / l)) },
    };
}

/** Mark every message sent TO me in this conversation as read. */
export async function markRead(me, conversationId) {
    const myToken = partyToken(me.role, me.id);
    const { count } = await prisma.foodChatMessage.updateMany({
        where: { conversationId, recipientToken: myToken, readAt: null },
        data: { readAt: new Date() },
    });
    return { updated: count };
}

/**
 * Conversations I take part in, newest first.
 *
 * Messages stay the source of truth for lastMessage / lastAt / unread; the
 * conversation row only contributes the support metadata (title, status,
 * closedAt). A thread with no row — every order chat created before support
 * threads existed — still lists, defaulted to an open conversation with no
 * title, so nothing needed backfilling. Threads opened but never written to
 * would be invisible if we only grouped messages, so they are merged in too.
 *
 * The grouping was a Mongo aggregation pipeline; DISTINCT ON is the Postgres
 * idiom for "latest row per group" and does it in one indexed pass.
 *
 * @param {{orderId?: string}} [query] Pass orderId to list only that order's threads.
 */
export async function listConversations(me, query = {}) {
    const myToken = partyToken(me.role, me.id);

    const orderId = String(query.orderId || '').trim();
    if (orderId && !isId(orderId)) throw new ValidationError('Invalid order id');
    const orderFilter = orderId ? Prisma.sql`AND "orderId" = ${orderId}` : Prisma.empty;

    const rows = await prisma.$queryRaw`
        WITH mine AS (
            SELECT * FROM "food_chat_messages"
            WHERE ${myToken} = ANY("participants") ${orderFilter}
        ),
        agg AS (
            SELECT "conversationId",
                   MIN("createdAt") AS "firstAt",
                   COUNT(*) FILTER (
                       WHERE "recipientToken" = ${myToken} AND "readAt" IS NULL
                   ) AS "unread"
            FROM mine
            GROUP BY "conversationId"
        ),
        latest AS (
            SELECT DISTINCT ON ("conversationId")
                   "conversationId", "orderId", "text", "createdAt", "participants"
            FROM mine
            ORDER BY "conversationId", "createdAt" DESC
        )
        SELECT latest."conversationId", latest."orderId",
               latest."text" AS "lastText", latest."createdAt" AS "lastAt",
               latest."participants", agg."firstAt", agg."unread"
        FROM latest
        JOIN agg ON agg."conversationId" = latest."conversationId"
        ORDER BY latest."createdAt" DESC
    `;

    const docs = await prisma.foodChatConversation.findMany({
        where: {
            participants: { has: myToken },
            ...(orderId ? { orderId } : {}),
        },
    });
    const docById = new Map(docs.map((d) => [d.conversationId, d]));

    const merged = rows.map((r) => {
        const doc = docById.get(r.conversationId);
        docById.delete(r.conversationId);
        return {
            conversationId: r.conversationId,
            orderId: r.orderId ? String(r.orderId) : doc?.orderId ? String(doc.orderId) : null,
            title: doc?.title || '',
            peerToken: (r.participants || []).find((t) => t !== myToken) || doc?.peerToken || null,
            lastMessage: r.lastText,
            lastAt: r.lastAt,
            // COUNT is int8, which the driver hands back as a BigInt.
            unread: Number(r.unread),
            status: doc?.status || 'open',
            // Without a row the thread began with its first message.
            createdAt: doc?.createdAt || r.firstAt,
            closedAt: doc?.closedAt || null,
        };
    });

    // Opened but not yet written to.
    for (const doc of docById.values()) {
        merged.push({
            conversationId: doc.conversationId,
            orderId: doc.orderId ? String(doc.orderId) : null,
            title: doc.title || '',
            peerToken: doc.peerToken,
            lastMessage: '',
            lastAt: null,
            unread: 0,
            status: doc.status,
            createdAt: doc.createdAt,
            closedAt: doc.closedAt || null,
        });
    }

    merged.sort(
        (a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()
    );

    return { conversations: merged };
}

/** Shape sent to clients over both REST and the socket, so they never disagree. */
const serializeConversation = (doc, extra = {}) => ({
    conversationId: doc.conversationId,
    orderId: doc.orderId ? String(doc.orderId) : null,
    title: doc.title || '',
    peerToken: doc.peerToken,
    status: doc.status,
    createdAt: doc.createdAt,
    closedAt: doc.closedAt || null,
    lastMessage: '',
    lastAt: null,
    unread: 0,
    ...extra,
});

function emitConversationUpdate(doc) {
    try {
        const io = getIO();
        if (!io) return;
        const payload = serializeConversation(doc);
        // Every participant, so an agent closing a thread updates the user's list
        // immediately instead of only on their next fetch.
        for (const token of doc.participants || []) {
            const [role, id] = token === 'ADMIN' ? ['ADMIN', null] : token.split(':');
            const room = roomForToken(role, id);
            if (room) io.to(room).emit('chat:conversation_update', payload);
        }
    } catch (e) {
        logger.warn(`emitConversationUpdate failed: ${e?.message || e}`);
    }
}

/**
 * Opens a support thread, or returns the existing one.
 *
 * The conversation id is the same deterministic value the messages use, so a
 * thread opened here and the messages later sent into it join up without the
 * client having to pass an id around.
 */
export async function createConversation(me, dto = {}) {
    const myToken = partyToken(me.role, me.id);
    const peerToken = String(dto.peerToken || 'ADMIN').trim();
    const title = String(dto.title || '').trim().slice(0, 200);

    const orderId = String(dto.orderId || '').trim();
    if (orderId && !isId(orderId)) throw new ValidationError('Invalid order id');
    if (peerToken !== 'ADMIN') {
        const [peerRole] = peerToken.split(':');
        if (!ROLES.includes(peerRole)) throw new ValidationError('Invalid peer');
        // Chatting about an order means both sides must belong to it.
        if (orderId) await assertOrderParticipants(orderId, [myToken, peerToken]);
    }

    const conversationId = buildConversationId(myToken, peerToken, orderId || null);

    // Upsert so a double-tap on "start chat" reuses the thread instead of
    // colliding on the unique index. `update` writes conversationId back to
    // itself: a no-op that keeps it non-empty, which is what makes Prisma
    // compile this to INSERT … ON CONFLICT. See prisma/README.md.
    const doc = await prisma.foodChatConversation.upsert({
        where: { conversationId },
        create: {
            conversationId,
            orderId: orderId || null,
            title,
            peerToken,
            openedByToken: myToken,
            participants: [myToken, peerToken].sort(),
            status: 'open',
            closedAt: null,
        },
        update: { conversationId },
    });

    emitConversationUpdate(doc);
    return { conversation: serializeConversation(doc) };
}

/**
 * Moves a thread through open -> in_progress -> closed (and back if reopened).
 *
 * closedAt is derived here rather than trusted from the client, so it can never
 * disagree with status.
 */
export async function updateConversationStatus(me, conversationId, status) {
    const myToken = partyToken(me.role, me.id);
    const next = String(status || '').trim().toLowerCase();
    if (!['open', 'in_progress', 'closed'].includes(next)) {
        throw new ValidationError('Status must be open, in_progress or closed');
    }

    const existing = await prisma.foodChatConversation.findUnique({
        where: { conversationId: String(conversationId || '').trim() },
    });
    if (!existing) throw new ValidationError('Conversation not found');

    // ADMIN is a shared inbox, so any admin may act on a thread it is part of.
    if (!(existing.participants || []).includes(myToken)) {
        throw new ForbiddenError('Not your conversation');
    }

    const doc = await prisma.foodChatConversation.update({
        where: { conversationId: existing.conversationId },
        data: { status: next, closedAt: next === 'closed' ? new Date() : null },
    });

    emitConversationUpdate(doc);
    return { conversation: serializeConversation(doc) };
}
