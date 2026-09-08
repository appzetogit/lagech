import { Prisma } from '@prisma/client';
import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { ValidationError, ForbiddenError } from '../../../../core/auth/errors.js';
import { getIO, rooms } from '../../../../config/socket.js';
import { notifyOwnersSafely } from '../../orders/services/order.helpers.js';
import { notifyAdminsSafely } from '../../../../core/notifications/firebase.service.js';
import { logger } from '../../../../utils/logger.js';
import { buildPublicUrl } from '../../../../services/storage.service.js';

const ROLES = ['USER', 'RESTAURANT', 'DELIVERY_PARTNER', 'ADMIN'];

/** The order columns that decide who may talk to whom. */
const ORDER_PARTIES = { userId: true, restaurantId: true, dispatchDeliveryPartnerId: true };

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
            order.dispatchDeliveryPartnerId &&
                partyToken('DELIVERY_PARTNER', order.dispatchDeliveryPartnerId),
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
        DELIVERY_PARTNER: order?.dispatchDeliveryPartnerId
            ? String(order.dispatchDeliveryPartnerId)
            : '',
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

/** How many images may ride on one message. */
const MAX_ATTACHMENTS = 5;

/**
 * Keep only what the upload endpoint issued, and only the fields we store.
 *
 * The client sends back what that endpoint returned, so it is our own data --
 * but it has been through a browser, and a message row is read by every party
 * in the conversation. Anything not on this list is dropped rather than
 * persisted, and the url has to be one of ours: a message is a place to put a
 * link in front of somebody, so an off-site one would be worth planting.
 */
const cleanAttachments = (raw) => {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw)) throw new ValidationError('attachments must be a list');
    if (raw.length > MAX_ATTACHMENTS) {
        throw new ValidationError(`At most ${MAX_ATTACHMENTS} attachments per message`);
    }

    return raw.map((item) => {
        const path = String(item?.path || '').trim();

        // The path is the only thing taken from the client, and it is joined
        // onto the uploads root to build a url -- so it has to be a plain
        // relative path. A "../" in here would address files outside it.
        if (!/^[A-Za-z0-9][A-Za-z0-9._\-/]{0,200}$/.test(path) || path.includes('..')) {
            throw new ValidationError('Attachment path is not one this server issued');
        }

        return {
            // Rebuilt, never echoed back from the client: a message is a place
            // to put a link in front of somebody, so a url that came in from
            // outside must not be the one that goes out.
            url: buildPublicUrl(path),
            path,
            mimeType: String(item?.mimeType || ''),
            size: Number(item?.size) || 0,
            name: String(item?.name || '').slice(0, 120),
        };
    });
};

export async function sendMessage(sender, dto) {
    const text = String(dto?.text || '').trim();
    const attachments = cleanAttachments(dto?.attachments);
    // A photo with no caption is an ordinary message; an empty one is not.
    if (!text && attachments.length === 0) {
        throw new ValidationError('Write a message or attach an image');
    }
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
            attachments,
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
        // A caption if there is one, otherwise say what arrived -- a push with
        // an empty body renders as a blank notification.
        body: text
            ? text.slice(0, 120)
            : `Sent ${attachments.length} photo${attachments.length === 1 ? '' : 's'}`,
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
        attachments: Array.isArray(row.attachments) ? row.attachments : [],
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
        messages: await attachSenderNames(docs.map(serializeMessage).reverse()), // oldest → newest for UI
        pagination: { page: p, limit: l, total, totalPages: Math.max(1, Math.ceil(total / l)) },
    };
}

/**
 * How many messages are waiting on me, across every thread.
 *
 * A count rather than the list: the sidebar badge needs one number, and
 * fetching every conversation to add up their unread fields would make a
 * badge cost more than the screen it sits beside.
 */
export async function unreadCount(me) {
    const myToken = partyToken(me.role, me.id);
    const total = await prisma.foodChatMessage.count({
        where: { recipientToken: myToken, readAt: null },
    });
    return { unread: total };
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
                   "conversationId", "orderId", "text", "createdAt", "participants",
                   COALESCE(array_length("attachments", 1), 0) AS "attachmentCount"
            FROM mine
            ORDER BY "conversationId", "createdAt" DESC
        )
        SELECT latest."conversationId", latest."orderId",
               latest."text" AS "lastText", latest."createdAt" AS "lastAt",
               latest."attachmentCount", latest."participants", agg."firstAt", agg."unread"
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
            // A message can be pictures and nothing else, and a thread whose
            // newest message is one reads as empty in the list otherwise.
            lastMessage: r.lastText || photoSummary(Number(r.attachmentCount) || 0),
            lastAt: r.lastAt,
            // COUNT is int8, which the driver hands back as a BigInt.
            unread: Number(r.unread),
            status: doc?.status || 'open',
            assignedAdminId: doc?.assignedAdminId ? String(doc.assignedAdminId) : null,
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
            assignedAdminId: doc.assignedAdminId ? String(doc.assignedAdminId) : null,
            createdAt: doc.createdAt,
            closedAt: doc.closedAt || null,
        });
    }

    merged.sort(
        (a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()
    );

    return { conversations: await attachAssignees(await attachPeers(merged)) };
}

/**
 * Put a name and a number on the other side of each thread.
 *
 * A conversation carries only tokens -- "USER:6a83..." -- which is all the
 * participants themselves need, because each already knows who they are talking
 * to. A support desk does not: an inbox listing two dozen opaque ids is not
 * something anyone can work. Resolved in three queries rather than one per row.
 *
 * A peer that no longer exists (a deleted account) keeps its token and gets no
 * name, so the thread still lists and its history is still readable.
 */
/**
 * Put a name on each admin reply.
 *
 * Every admin talks through the shared token "ADMIN", which is right for
 * addressing -- a customer writes to support, not to a person -- but it means
 * a thread reads as one voice. `senderId` has always held the real admin id;
 * it was just never turned into anything anyone could see.
 */
const attachSenderNames = async (messages) => {
    const adminIds = [
        ...new Set(
            messages.filter((m) => m.senderRole === 'ADMIN' && m.senderId).map((m) => String(m.senderId)),
        ),
    ];
    if (!adminIds.length) return messages;

    const admins = await prisma.foodAdmin.findMany({
        where: { id: { in: adminIds } },
        select: { id: true, name: true, email: true },
    });
    const names = new Map(
        admins.map((a) => [a.id, a.name || String(a.email || '').split('@')[0] || 'Support']),
    );

    return messages.map((m) =>
        m.senderRole === 'ADMIN'
            ? { ...m, senderName: names.get(String(m.senderId)) || 'Support' }
            : m,
    );
};

/** What a list row says for a message that carries no text. */
const photoSummary = (count) => (count > 0 ? `${count} photo${count === 1 ? '' : 's'}` : '');

/** The assignee of each thread, by name, in one query rather than per row. */
const attachAssignees = async (conversations) => {
    const ids = [...new Set(conversations.map((c) => c.assignedAdminId).filter(Boolean))];
    if (!ids.length) return conversations.map((c) => ({ ...c, assignedAdmin: null }));

    const admins = await prisma.foodAdmin.findMany({
        where: { id: { in: ids } },
        select: { id: true, name: true, email: true },
    });
    const byId = new Map(
        admins.map((a) => [a.id, { id: a.id, name: a.name || String(a.email || '').split('@')[0] || 'Support' }]),
    );

    return conversations.map((c) => ({
        ...c,
        // An admin who has since been deleted leaves the thread assigned to
        // nobody rather than to a blank name.
        assignedAdmin: (c.assignedAdminId && byId.get(c.assignedAdminId)) || null,
    }));
};

const attachPeers = async (conversations) => {
    const byRole = { USER: new Set(), DELIVERY_PARTNER: new Set(), RESTAURANT: new Set() };

    for (const c of conversations) {
        const [role, id] = String(c.peerToken || '').split(':');
        if (byRole[role] && id) byRole[role].add(id);
    }

    const ids = (role) => [...byRole[role]];
    const [users, riders, restaurants] = await Promise.all([
        byRole.USER.size
            ? prisma.foodUser.findMany({ where: { id: { in: ids('USER') } }, select: { id: true, name: true, phone: true } })
            : [],
        byRole.DELIVERY_PARTNER.size
            ? prisma.foodDeliveryPartner.findMany({
                  where: { id: { in: ids('DELIVERY_PARTNER') } },
                  select: { id: true, name: true, phone: true },
              })
            : [],
        byRole.RESTAURANT.size
            ? prisma.foodRestaurant.findMany({
                  where: { id: { in: ids('RESTAURANT') } },
                  select: { id: true, restaurantName: true, ownerPhone: true },
              })
            : [],
    ]);

    const names = new Map();
    for (const u of users) names.set(`USER:${u.id}`, { name: u.name || '', phone: u.phone || '' });
    for (const r of riders)
        names.set(`DELIVERY_PARTNER:${r.id}`, { name: r.name || '', phone: r.phone || '' });
    for (const r of restaurants)
        names.set(`RESTAURANT:${r.id}`, { name: r.restaurantName || '', phone: r.ownerPhone || '' });

    return conversations.map((c) => {
        const [role, id] = String(c.peerToken || '').split(':');
        const found = names.get(c.peerToken);
        return {
            ...c,
            peer: {
                role: role || '',
                id: id || '',
                name: found?.name || (role === 'ADMIN' ? 'Support' : ''),
                phone: found?.phone || '',
            },
        };
    });
};

/** Shape sent to clients over both REST and the socket, so they never disagree. */
const serializeConversation = (doc, extra = {}) => ({
    conversationId: doc.conversationId,
    orderId: doc.orderId ? String(doc.orderId) : null,
    title: doc.title || '',
    peerToken: doc.peerToken,
    status: doc.status,
    assignedAdminId: doc.assignedAdminId ? String(doc.assignedAdminId) : null,
    assignedAt: doc.assignedAt || null,
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
 * Take a thread, or put it back.
 *
 * Only ever to the caller or to nobody. An admin picker would need the right
 * to list every admin, which is a permission a support person has no other
 * reason to hold, and "whoever is dealing with it says so" is the workflow a
 * desk actually runs on.
 *
 * Taking an untouched thread also moves it to in_progress -- the status
 * existed and nothing ever set it, so every thread sat at open until closed.
 *
 * @param {boolean} toSelf true to take it, false to release it
 */
export async function assignConversation(me, conversationId, toSelf = true) {
    if (me?.role !== 'ADMIN') throw new ForbiddenError('Only support can assign a conversation');
    if (!conversationId) throw new ValidationError('conversationId is required');

    const existing = await prisma.foodChatConversation.findUnique({
        where: { conversationId: String(conversationId) },
    });
    if (!existing) throw new ValidationError('Conversation not found');

    const doc = await prisma.foodChatConversation.update({
        where: { conversationId: String(conversationId) },
        data: {
            assignedAdminId: toSelf ? String(me.id) : null,
            assignedAt: toSelf ? new Date() : null,
            // Closed stays closed: picking a thread up is not reopening it.
            ...(toSelf && existing.status === 'open' ? { status: 'in_progress' } : {}),
        },
    });

    emitConversationUpdate(doc);
    const [withName] = await attachAssignees([
        {
            ...serializeConversation(doc),
            assignedAdminId: doc.assignedAdminId ? String(doc.assignedAdminId) : null,
        },
    ]);
    return { conversation: withName };
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
