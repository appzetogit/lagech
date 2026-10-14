/**
 * Chat history: `conversations` + `messages` -> food_chat_conversations,
 * food_chat_messages.
 *
 * The old ids in both tables are `user_infos` ids, not customer, store or
 * rider ids: a user_infos row carries the user_id, vendor_id or
 * deliveryman_id (or admin_id) behind it, and the conversation's
 * sender_type / receiver_type says which. Those go through legacy.id_map
 * ('user', 'restaurant' via the vendor's store, 'delivery_partner'); the
 * admin side is the shared support inbox here (token ADMIN), with the real
 * admin recorded as the sender of their replies.
 *
 * Threads are keyed the way chat.service.js keys them, so an imported thread
 * is the one the apps open: `direct::<tokens>` for a pair, and for a support
 * message about an order (the old app stamped those with order_id),
 * `<order id>::<tokens>`, the per-order support thread. One old conversation
 * can therefore become several threads here, one per order it discussed.
 *
 * A conversation whose other side was not imported (or whose profile the old
 * system deleted) is skipped and listed. Pictures are referenced under
 * UPLOAD_STORAGE_ROOT/legacy/conversation/ when the file was copied there;
 * otherwise the message keeps its text, a picture-only one says a photo was
 * not carried over, and the summary counts them. Timestamps and seen flags are
 * kept as they were.
 *
 * Re-runs and syncs never duplicate (messages are tracked in legacy.id_map),
 * never mark a message unread that was read here, and never change a thread
 * row that exists here.
 */
import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '../../../src/config/prisma.js';
import { config } from '../../../src/config/env.js';
import { buildPublicUrl } from '../../../src/services/storage.service.js';
import { loadIdMap, recordId } from '../idMap.mjs';
import { classifyProtected, isBlank } from '../sync.mjs';

const CONVERSATION = 'chat_conversation';
const THREAD = 'chat_thread';
const MESSAGE = 'chat_message';
const IMAGE_DIR = 'legacy/conversation';

/** What a picture-only message says when its picture was not copied across. */
export const PHOTO_NOT_CARRIED = '(photo from the old app, not carried over)';

const TYPE_ROLE = { customer: 'USER', user: 'USER', vendor: 'RESTAURANT', store: 'RESTAURANT', delivery_man: 'DELIVERY_PARTNER', deliveryman: 'DELIVERY_PARTNER', admin: 'ADMIN' };

/** Same as chat.service.js partyToken: ADMIN is one shared inbox, so it carries no id. */
export const partyToken = (role, id) => (role === 'ADMIN' ? 'ADMIN' : `${role}:${String(id)}`);

/** Same keys chat.service.js derives, so the apps find these threads. */
export const threadKey = (tokenA, tokenB, orderId) => {
    const roles = [tokenA, tokenB].map((t) => t.split(':')[0]).sort().join('|');
    if (orderId && roles === 'DELIVERY_PARTNER|USER') return String(orderId);
    return `${orderId ? String(orderId) : 'direct'}::${[tokenA, tokenB].sort().join('|')}`;
};

const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };

/**
 * The old `file` column ([{img, storage}]) as attachments here, for the files
 * that exist. `stat(path)` returns { size } or null; injected for the test.
 *
 * @returns {{ attachments: object[], missing: string[] }}
 */
export function attachmentsOf(rawFile, stat) {
    let list = [];
    try {
        const parsed = rawFile ? JSON.parse(rawFile) : [];
        list = Array.isArray(parsed) ? parsed : [];
    } catch {
        list = [];
    }
    const attachments = [];
    const missing = [];
    for (const entry of list) {
        const name = String(entry?.img || '').trim();
        if (!name) continue;
        // Only a plain file name: it is joined onto the uploads root, and the
        // chat service refuses any attachment path that is not this shape.
        const relative = `${IMAGE_DIR}/${name}`;
        const found = /^[A-Za-z0-9][A-Za-z0-9._-]{0,150}$/.test(name) && !name.includes('..') ? stat(relative) : null;
        if (!found) {
            missing.push(name);
            continue;
        }
        attachments.push({
            url: buildPublicUrl(relative),
            path: relative,
            mimeType: MIME[name.split('.').pop().toLowerCase()] || '',
            size: Number(found.size) || 0,
            name: name.slice(0, 120),
        });
    }
    return { attachments, missing };
}

/**
 * Who one side of an old conversation is here.
 *
 * @param type     the old sender_type / receiver_type
 * @param info     the user_infos row it points at (undefined when deleted)
 * @param maps     { user, restaurant, delivery_partner } id maps, and
 *                 vendorStores: vendor id -> its store ids
 * @returns {{ role, id } | { missing: string }}
 */
export function partyOf(type, infoId, info, maps) {
    const role = TYPE_ROLE[String(type || '').toLowerCase()];
    if (!role) return { missing: `unknown participant type "${type}"` };
    if (role === 'ADMIN') return { role, id: null };
    if (!info) return { missing: `${type} profile ${infoId} no longer exists in the old data` };
    if (role === 'USER') {
        const id = info.user_id != null && maps.user.get(String(info.user_id));
        return id ? { role, id } : { missing: `customer ${info.user_id} not imported` };
    }
    if (role === 'RESTAURANT') {
        const stores = maps.vendorStores.get(String(info.vendor_id)) || [];
        const id = stores.map((store) => maps.restaurant.get(store)).find(Boolean);
        return id ? { role, id } : { missing: `vendor ${info.vendor_id}'s restaurant not imported` };
    }
    const id = info.deliveryman_id != null && maps.delivery_partner.get(String(info.deliveryman_id));
    return id ? { role, id } : { missing: `rider ${info.deliveryman_id} not imported` };
}

/**
 * One old message -> its row here. `sides` is the conversation's two parties
 * (from partyOf), keyed by the old user_infos id; `adminIdOf(info)` gives the
 * admin here who sent an admin reply. Pure; exported for the test.
 *
 * @returns {{ skip: string } | { data: object, missing: string[] }}
 */
export function mapLegacyMessage(row, conversation, sides, { infos, adminIdOf, orderIdOf, stat }) {
    const { a, b } = sides;
    let from;
    let to;
    if (String(row.sender_id) === String(conversation.sender_id)) [from, to] = [a, b];
    else if (String(row.sender_id) === String(conversation.receiver_id)) [from, to] = [b, a];
    else if (infos.get(String(row.sender_id))?.admin_id != null && (a.role === 'ADMIN' || b.role === 'ADMIN')) {
        [from, to] = a.role === 'ADMIN' ? [a, b] : [b, a];
    } else {
        return { skip: 'sender is neither side of its conversation' };
    }

    const senderId = from.role === 'ADMIN' ? adminIdOf(infos.get(String(row.sender_id))) : from.id;
    if (!senderId) return { skip: 'no admin here to attribute the reply to' };

    const { attachments, missing } = attachmentsOf(row.file, stat);
    let text = String(row.message || '').trim().slice(0, 2000);
    if (!text && !attachments.length) {
        if (!missing.length) return { skip: 'empty message' };
        text = PHOTO_NOT_CARRIED;
    }

    const orderId = row.order_id != null ? orderIdOf(String(row.order_id)) : null;
    const senderToken = partyToken(from.role, from.id);
    const recipientToken = partyToken(to.role, to.id);
    const createdAt = row.created_at || conversation.created_at || new Date();
    return {
        missing,
        data: {
            conversationId: threadKey(senderToken, recipientToken, orderId),
            orderId: orderId || null,
            senderRole: from.role,
            senderId: String(senderId),
            senderToken,
            recipientRole: to.role,
            recipientId: to.role === 'ADMIN' ? null : String(to.id),
            recipientToken,
            participants: [senderToken, recipientToken],
            text,
            attachments,
            // Seen in the old app: read when it was marked so (its last update).
            readAt: Number(row.is_seen) === 1 ? (row.updated_at || createdAt) : null,
            createdAt,
            updatedAt: row.updated_at || createdAt,
        },
    };
}

/**
 * An already-imported message: only blanks are filled -- a read flag the old
 * app set since, or a picture that has been copied across since. A message
 * read here is never made unread.
 */
export function planMessageFill(current, target) {
    const patch = {};
    if (!current.readAt && target.readAt) patch.readAt = target.readAt;
    if (isBlank(current.attachments) && target.attachments.length) {
        patch.attachments = target.attachments;
        if (current.text === PHOTO_NOT_CARRIED) patch.text = target.text === PHOTO_NOT_CARRIED ? '' : target.text;
    }
    return patch;
}

const statUpload = (relative) => {
    try {
        const stats = fs.statSync(path.join(config.uploadStorageRoot || 'uploads', relative));
        return stats.isFile() ? { size: stats.size } : null;
    } catch {
        return null;
    }
};

export async function importChat(mysql, report, ctx = {}) {
    const maps = {
        user: await loadIdMap('user'),
        restaurant: await loadIdMap('restaurant'),
        delivery_partner: await loadIdMap('delivery_partner'),
        vendorStores: new Map(),
    };
    const admins = await loadIdMap('admin');
    const orders = await loadIdMap('order');
    const idMap = await loadIdMap(MESSAGE);

    // Only the link columns: names, phones and emails stay in the old database.
    const [infoRows] = await mysql.query('SELECT id, user_id, vendor_id, deliveryman_id, admin_id FROM user_infos');
    const infos = new Map(infoRows.map((row) => [String(row.id), row]));
    const [stores] = await mysql.query('SELECT id, vendor_id FROM stores ORDER BY id');
    for (const store of stores) {
        const key = String(store.vendor_id);
        maps.vendorStores.set(key, [...(maps.vendorStores.get(key) || []), String(store.id)]);
    }
    const [conversations] = await mysql.query('SELECT * FROM conversations ORDER BY id');
    const MESSAGES_SQL = 'SELECT * FROM messages ORDER BY id';
    const [messages] = await mysql.query(MESSAGES_SQL);
    const baseline = ctx.sync ? await ctx.baselineRows(MESSAGES_SQL) : null;

    // The super admin answers for any old admin who is not an admin here.
    const mainAdmin = await prisma.foodAdmin.findFirst({
        where: { adminType: 'super_admin', isDeleted: false },
        orderBy: { createdAt: 'asc' },
        select: { id: true },
    });
    const liveAdmins = new Set((await prisma.foodAdmin.findMany({
        where: { id: { in: [...new Set(admins.values())] } }, select: { id: true },
    })).map((a) => a.id));
    const adminIdOf = (info) => {
        const mapped = info?.admin_id != null ? admins.get(String(info.admin_id)) : null;
        return (mapped && liveAdmins.has(mapped) ? mapped : null) || mainAdmin?.id || null;
    };
    // An order deleted here since is not linked; the message stays, in the plain thread.
    const liveOrders = new Set((await prisma.foodOrder.findMany({
        where: { id: { in: [...new Set(messages.map((m) => m.order_id != null && orders.get(String(m.order_id))).filter(Boolean))] } },
        select: { id: true },
    })).map((o) => o.id));
    const notes = { orderNotImported: 0, missingPhotos: 0, photoOnlyMissing: 0, unread: 0 };
    const orderIdOf = (legacyId) => {
        const id = orders.get(legacyId);
        if (id && liveOrders.has(id)) return id;
        notes.orderNotImported += 1;
        return null;
    };

    const byConversation = new Map();
    for (const message of messages) {
        const key = String(message.conversation_id);
        byConversation.set(key, [...(byConversation.get(key) || []), message]);
    }
    const conversationIds = new Set(conversations.map((c) => String(c.id)));
    for (const [key, list] of byConversation) {
        if (!conversationIds.has(key)) {
            for (const message of list) report.skip(MESSAGE, message.id, `conversation ${key}`, 'its conversation no longer exists in the old data');
        }
    }

    const threads = new Map();
    for (const conversation of conversations) {
        const list = byConversation.get(String(conversation.id)) || [];
        const a = partyOf(conversation.sender_type, conversation.sender_id, infos.get(String(conversation.sender_id)), maps);
        const b = partyOf(conversation.receiver_type, conversation.receiver_id, infos.get(String(conversation.receiver_id)), maps);
        const label = `${conversation.sender_type} -> ${conversation.receiver_type}`;
        if (a.missing || b.missing) {
            report.skip(CONVERSATION, conversation.id, label, `${a.missing || b.missing} (${list.length} message(s) not imported)`);
            continue;
        }
        if (a.role === b.role && a.id === b.id) {
            report.skip(CONVERSATION, conversation.id, label, 'both sides are the same account here');
            continue;
        }
        let added = 0;
        for (const row of list) {
            const mapped = mapLegacyMessage(row, conversation, { a, b }, { infos, adminIdOf, orderIdOf, stat: statUpload });
            if (mapped.skip) {
                report.skip(MESSAGE, row.id, `conversation ${conversation.id}`, mapped.skip);
                continue;
            }
            const { data, missing } = mapped;
            const mappedId = idMap.get(String(row.id));
            const current = mappedId
                ? await prisma.foodChatMessage.findUnique({ where: { id: mappedId }, select: { id: true, readAt: true, attachments: true, text: true } })
                : null;

            if (current) {
                // Imported before: the message is history now; only blanks are filled.
                const patch = planMessageFill(current, data);
                if (Object.keys(patch).length) {
                    await prisma.foodChatMessage.update({ where: { id: current.id }, data: patch });
                    report.done(MESSAGE, 'updated');
                    report.detail(MESSAGE, Object.keys(patch));
                } else if (ctx.sync) {
                    const { outcome, columns } = classifyProtected(baseline.get(String(row.id)), row, ['message', 'file', 'is_seen']);
                    report.done(MESSAGE, outcome);
                    if (columns.length) report.detail(MESSAGE, columns);
                } else {
                    report.done(MESSAGE, 'unchanged');
                }
                continue;
            }
            if (mappedId && ctx.sync) {
                report.skip(MESSAGE, row.id, `conversation ${conversation.id}`, 'imported before but deleted here since; not recreated');
                continue;
            }

            if (missing.length) {
                notes.missingPhotos += missing.length;
                if (data.text === PHOTO_NOT_CARRIED) notes.photoOnlyMissing += 1;
            }
            if (!data.readAt) notes.unread += 1;
            const thread = threads.get(data.conversationId) || {
                conversationId: data.conversationId,
                orderId: data.orderId,
                // The customer (or whoever wrote first in the old app) opened it.
                openedByToken: partyToken(a.role, a.id),
                peerToken: partyToken(b.role, b.id),
                participants: [partyToken(a.role, a.id), partyToken(b.role, b.id)].sort(),
                createdAt: data.createdAt,
            };
            if (data.createdAt < thread.createdAt) thread.createdAt = data.createdAt;
            threads.set(data.conversationId, thread);

            const created = await prisma.foodChatMessage.create({ data, select: { id: true } });
            await recordId(MESSAGE, row.id, created.id);
            report.done(MESSAGE, 'created');
            added += 1;
        }
        // Counted as brought in when any of its messages came across this run.
        report.done(CONVERSATION, added ? 'created' : 'unchanged');
    }

    // A thread row for each thread that has none: its start date, open, no
    // title -- what the inbox shows for a thread without a row anyway. One that
    // exists here (opened by someone since) is left exactly as it is.
    for (const thread of threads.values()) {
        const exists = await prisma.foodChatConversation.count({ where: { conversationId: thread.conversationId } });
        if (exists) {
            report.done(THREAD, 'unchanged');
            continue;
        }
        await prisma.foodChatConversation.create({
            data: { ...thread, title: '', status: 'open', updatedAt: thread.createdAt },
        });
        report.done(THREAD, 'created');
    }

    if (!mainAdmin) {
        report.warn(MESSAGE, '-', '(all)', 'no super admin here: support replies could not be attributed and were skipped');
    }
    if (notes.orderNotImported) {
        report.warn(MESSAGE, '-', '(all)', `${notes.orderNotImported} support message(s) named an order that was not imported; kept in the customer's general support thread`);
    }
    if (notes.missingPhotos) {
        report.warn(MESSAGE, '-', '(all)',
            `${notes.missingPhotos} chat photo(s) not found under ${IMAGE_DIR}; messages kept without them (${notes.photoOnlyMissing} photo-only message(s) say so). Copy the old storage/app/public/conversation folder there and re-run to attach them`);
    }
    if (notes.unread) {
        report.warn(MESSAGE, '-', '(all)', `${notes.unread} message(s) were unseen in the old app and come in unread`);
    }
}
