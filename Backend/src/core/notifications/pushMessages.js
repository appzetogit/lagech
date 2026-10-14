import { logger } from '../../utils/logger.js';

/**
 * The admin's own wording for the order pushes, like the old 6amMart panel's
 * "push notification messages" (Business Settings -> Push Notification, and
 * System Settings -> 3rd Party & Configurations -> Firebase notification; both
 * pages edit this one document).
 *
 * Every push goes through sendNotificationToOwner, which hands its payload to
 * applyPushMessage() after the Notification Channels check. A push is matched
 * to a message here by the `data.type` (and `data.orderStatus`) the sending
 * code already puts on it and by who receives it. When the admin wrote a title
 * or body for that message, it replaces the code's wording, with placeholders
 * such as {orderId} or {storeName} filled from the order; when the admin left
 * it blank, the code's wording (shown on the page as the default) goes out
 * unchanged.
 *
 * Switching: like 6amMart, every message has its own on/off here, and a
 * message switched off is not pushed (nor kept in the inbox). Notification
 * Channels stays the master switch for a whole group of events (every order
 * status push, say): a push goes out only when both are on. The delivery offer
 * to riders is never switchable, because without it orders are not delivered.
 *
 * `legacy` is the 6amMart notification_messages key a message is imported
 * from (scripts/legacy-import, step notification-messages).
 *
 * Fails open: if the settings or the order cannot be read, the push goes out
 * as the code wrote it.
 */

export const AREA = 'push_messages';

const CANCEL = 'cancel';

/** Placeholders every order message can use ({storeName} and {userName} as in 6amMart). */
const ORDER_VARS = ['userName', 'customerName', 'orderId', 'storeName', 'restaurantName', 'deliveryManName', 'orderAmount'];

/**
 * key, label, who gets it, how a push is recognised (any of `match`),
 * `channel`: the Notification Channels event that is also a switch for it
 * (null when only this page switches it), `locked` when it cannot be switched
 * at all, and the code's own wording today (`defaultTitle` / `defaultBody`,
 * shown on the page; the code may add details such as a refund amount).
 */
export const PUSH_MESSAGES = [
    // Customer.
    {
        key: 'customer_order_placed',
        label: 'Order placed (pending)',
        audience: 'Customer',
        owner: 'USER',
        match: [{ types: ['order_created'] }],
        channel: null,
        legacy: 'order_pending_message',
        defaultTitle: 'Order Confirmed! 🍔',
        defaultBody: 'Your order #{orderId} from {storeName} has been placed successfully.',
    },
    {
        key: 'customer_order_confirmed',
        label: 'Order confirmed by the restaurant',
        audience: 'Customer',
        owner: 'USER',
        match: [{ types: ['order_status_update'], statuses: ['confirmed'] }],
        channel: 'order_status',
        legacy: 'order_confirmation_msg',
        defaultTitle: 'Order Accepted! 🧑‍🍳',
        defaultBody: 'The order has been accepted and is starting to be prepared.',
    },
    {
        key: 'customer_order_processing',
        label: 'Order processing (cooking)',
        audience: 'Customer',
        owner: 'USER',
        match: [{ types: ['order_status_update'], statuses: ['preparing'] }],
        channel: 'order_status',
        legacy: 'order_processing_message',
        defaultTitle: 'Food is being prepared! 🍳',
        defaultBody: 'Your food is currently being prepared by the restaurant.',
    },
    {
        key: 'customer_order_ready',
        label: 'Order ready for handover',
        audience: 'Customer',
        owner: 'USER',
        match: [{ types: ['order_status_update'], statuses: ['ready_for_pickup'] }],
        channel: 'order_status',
        legacy: 'order_handover_message',
        defaultTitle: 'Food is ready! 🛍️',
        defaultBody: 'Your order is ready and waiting to be picked up.',
    },
    {
        key: 'customer_rider_assigned',
        label: 'Delivery man assigned',
        audience: 'Customer',
        owner: 'USER',
        match: [{ types: ['delivery_accepted'] }],
        channel: 'rider_progress',
        legacy: 'delivery_boy_assign_message',
        defaultTitle: 'Order {orderId} accepted',
        defaultBody: 'A delivery partner has accepted your order.',
    },
    {
        key: 'customer_out_for_delivery',
        label: 'Order out for delivery (picked up)',
        audience: 'Customer',
        owner: 'USER',
        match: [{ types: ['order_status_update'], statuses: ['picked_up'] }],
        channel: 'order_status',
        legacy: 'out_for_delivery_message',
        defaultTitle: 'Order on the way!',
        defaultBody: 'Partner has picked up your order #{orderId} and is heading your way.',
    },
    {
        key: 'customer_rider_nearby',
        label: 'Delivery man reached the customer',
        audience: 'Customer',
        owner: 'USER',
        match: [{ types: ['order_status_update'], statuses: ['reached_drop'] }],
        channel: 'order_status',
        defaultTitle: 'Partner nearby!',
        defaultBody: 'Your delivery partner has reached your location for order #{orderId}.',
    },
    {
        key: 'customer_order_delivered',
        label: 'Order delivered',
        audience: 'Customer',
        owner: 'USER',
        match: [{ types: ['order_status_update'], statuses: ['delivered'] }],
        channel: 'order_status',
        legacy: 'order_delivered_message',
        defaultTitle: 'Order #{orderId} delivered!',
        defaultBody: "Hope you enjoyed your meal! Don't forget to rate your experience.",
    },
    {
        key: 'customer_order_cancelled',
        label: 'Order cancelled',
        audience: 'Customer',
        owner: 'USER',
        match: [{ types: ['order_cancelled'] }, { types: ['order_status_update'], statuses: CANCEL }],
        channel: 'order_cancelled',
        legacy: 'order_cancled_message',
        defaultTitle: 'Order Cancelled ❌',
        defaultBody: 'Order #{orderId} has been cancelled successfully.',
    },
    {
        key: 'customer_order_refunded',
        label: 'Order refunded',
        audience: 'Customer',
        owner: 'USER',
        match: [{ types: ['refund_processed'] }],
        channel: 'refund',
        legacy: 'order_refunded_message',
        defaultTitle: 'Refund Processed! 💸',
        defaultBody: 'Your refund for Order #{orderId} has been processed successfully.',
    },
    {
        key: 'customer_refund_request_rejected',
        label: 'Refund request canceled (declined)',
        audience: 'Customer',
        owner: 'USER',
        match: [{ types: ['refund_request_rejected'] }],
        channel: null,
        legacy: 'refund_request_canceled',
        defaultTitle: 'Refund request declined',
        defaultBody: 'Your refund request for order #{orderId} was declined: {reason}',
        extraVars: ['reason'],
    },
    {
        key: 'customer_payment_failed',
        label: 'Payment failed or offline payment rejected',
        audience: 'Customer',
        owner: 'USER',
        match: [{ types: ['payment_failed'] }],
        channel: null,
        defaultTitle: 'Payment failed',
        defaultBody: 'The payment for order #{orderId} did not go through.',
    },
    // Restaurant.
    {
        key: 'restaurant_new_order',
        label: 'New order',
        audience: 'Restaurant',
        owner: 'RESTAURANT',
        match: [{ types: ['new_order', 'order_created'] }],
        channel: 'restaurant_new_order',
        extraVars: ['itemsList', 'itemCount', 'total', 'address'],
        defaultTitle: 'New order received',
        defaultBody: 'Order #{orderId}: {itemsList}',
    },
    {
        key: 'restaurant_order_cancelled',
        label: 'Order cancelled',
        audience: 'Restaurant',
        owner: 'RESTAURANT',
        match: [{ types: ['order_cancelled'] }, { types: ['order_status_update'], statuses: CANCEL }],
        channel: 'order_cancelled',
        defaultTitle: 'Order Cancelled ❌',
        defaultBody: 'Order #{orderId} has been cancelled.',
    },
    {
        key: 'restaurant_rider_assigned',
        label: 'Delivery man assigned',
        audience: 'Restaurant',
        owner: 'RESTAURANT',
        match: [{ types: ['delivery_accepted'] }],
        channel: 'rider_progress',
        defaultTitle: 'Order {orderId} accepted',
        defaultBody: 'A delivery partner has accepted your order.',
    },
    {
        key: 'restaurant_rider_arrived',
        label: 'Delivery man arrived at the restaurant',
        audience: 'Restaurant',
        owner: 'RESTAURANT',
        match: [{ types: ['rider_arrived'] }],
        channel: 'rider_progress',
        defaultTitle: 'Rider arrived!',
        defaultBody: '{deliveryManName} has arrived at {storeName} to pick up the order.',
    },
    {
        key: 'restaurant_order_picked_up',
        label: 'Order picked up',
        audience: 'Restaurant',
        owner: 'RESTAURANT',
        match: [{ types: ['order_status_update'], statuses: ['picked_up'] }],
        channel: 'order_status',
        defaultTitle: 'Order on the way!',
        defaultBody: 'Partner has picked up order #{orderId}.',
    },
    {
        key: 'restaurant_order_delivered',
        label: 'Order delivered',
        audience: 'Restaurant',
        owner: 'RESTAURANT',
        match: [{ types: ['order_status_update'], statuses: ['delivered'] }],
        channel: 'order_status',
        defaultTitle: 'Order #{orderId} delivered!',
        defaultBody: 'Order #{orderId} has been delivered.',
    },
    // Rider.
    {
        key: 'rider_new_order',
        label: 'New delivery offer',
        audience: 'Delivery man',
        owner: 'DELIVERY_PARTNER',
        match: [{ types: ['new_order'] }],
        channel: null,
        locked: true,
        extraVars: ['riderEarning', 'tripDistanceKm', 'customerAddress', 'restaurantAddress'],
        defaultTitle: 'New order available!',
        defaultBody: 'Pickup: {storeName} / Drop: {customerAddress} / Earning: Rs.{riderEarning}',
    },
    {
        key: 'rider_order_assigned',
        label: 'Order assigned to you',
        audience: 'Delivery man',
        owner: 'DELIVERY_PARTNER',
        match: [{ types: ['delivery_accepted'] }],
        channel: 'rider_progress',
        defaultTitle: 'Order {orderId} accepted',
        defaultBody: 'A delivery partner has accepted your order.',
    },
    {
        key: 'rider_order_picked_up',
        label: 'Order picked up',
        audience: 'Delivery man',
        owner: 'DELIVERY_PARTNER',
        match: [{ types: ['order_status_update'], statuses: ['picked_up'] }],
        channel: 'order_status',
        defaultTitle: 'Order picked up!',
        defaultBody: 'You have picked up order #{orderId}. Proceed to the customer location.',
    },
    {
        key: 'rider_order_delivered',
        label: 'Delivery completed',
        audience: 'Delivery man',
        owner: 'DELIVERY_PARTNER',
        match: [{ types: ['order_completed'] }],
        channel: null,
        legacy: 'delivery_boy_delivered_message',
        defaultTitle: 'Delivery successful!',
        defaultBody: 'Order #{orderId} has been successfully delivered.',
    },
    {
        key: 'rider_order_cancelled',
        label: 'Order cancelled',
        audience: 'Delivery man',
        owner: 'DELIVERY_PARTNER',
        match: [{ types: ['order_cancelled'] }, { types: ['order_status_update'], statuses: CANCEL }],
        channel: 'order_cancelled',
        defaultTitle: 'Order Cancelled ❌',
        defaultBody: 'Order #{orderId} has been cancelled.',
    },
];

/** Whether a message can be switched off: all but the delivery offer. */
export const ownSwitch = (message) => Boolean(message) && !message.locked;

/** The placeholders a message's text may use. */
export const placeholdersFor = (message) => [...ORDER_VARS, ...(message?.extraVars || [])];

/** 6amMart notification_messages key -> the message here it becomes. */
export const LEGACY_PUSH_MESSAGE_KEYS = Object.fromEntries(
    PUSH_MESSAGES.filter((message) => message.legacy).map((message) => [message.legacy, message.key]),
);

/** What the admin page renders: the messages without the matching rules. */
export const PUSH_MESSAGE_CATALOG = PUSH_MESSAGES.map((message) => ({
    key: message.key,
    label: message.label,
    audience: message.audience,
    switchable: ownSwitch(message),
    switchedOn: message.locked ? 'never' : 'here',
    // The Notification Channels event that is the master switch for it.
    channel: message.channel,
    legacyKey: message.legacy || null,
    defaultTitle: message.defaultTitle || '',
    defaultBody: message.defaultBody || '',
    placeholders: placeholdersFor(message),
}));

const text = (value, max) => String(value ?? '').trim().slice(0, max);

/** Every message with enabled/title/body, whatever was stored. Pure. */
export function normalizePushMessages(value = {}) {
    const stored = value && typeof value === 'object' && value.messages && typeof value.messages === 'object' ? value.messages : {};
    const messages = {};
    for (const message of PUSH_MESSAGES) {
        const saved = stored[message.key] && typeof stored[message.key] === 'object' ? stored[message.key] : {};
        const enabled = ownSwitch(message) ? saved.enabled !== false && saved.enabled !== 'false' : true;
        messages[message.key] = { enabled, title: text(saved.title, 120), body: text(saved.body, 500) };
    }
    return { messages };
}

/** An old message text as it is stored here: single spaces, trimmed, bounded. */
const legacyText = (value) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 500);

/** One wanted entry per old key, from 6amMart notification_messages rows (last row wins). */
const wantedFromLegacy = (rows = []) => {
    const wanted = new Map();
    for (const row of rows || []) {
        const legacyKey = String(row?.key || '').trim();
        if (!legacyKey) continue;
        wanted.set(legacyKey, { body: legacyText(row.message), enabled: Number(row.status) !== 0 });
    }
    return wanted;
};

/**
 * The old panel's message texts and switches folded into the stored value.
 * Only a message nobody has edited here is filled (no title, no body, still
 * on). A message that still holds exactly what an earlier import wrote (the
 * `baselineRows`, on a sync) follows the old system's change; anything else
 * set here is left alone. Pure.
 *
 * @returns {{ value, outcomes: { legacyKey, key, outcome, reason? }[] }}
 *   outcome: created | updated | unchanged | protected | skipped
 */
export function mergeLegacyPushMessages(current = {}, rows = [], { baselineRows = null } = {}) {
    const value = normalizePushMessages(current);
    const baseline = baselineRows ? wantedFromLegacy(baselineRows) : null;
    const outcomes = [];
    for (const [legacyKey, wanted] of wantedFromLegacy(rows)) {
        const key = LEGACY_PUSH_MESSAGE_KEYS[legacyKey];
        if (!key) {
            outcomes.push({ legacyKey, key: null, outcome: 'skipped', reason: 'no message here for it' });
            continue;
        }
        const entry = value.messages[key];
        const holds = (w) => Boolean(w) && !entry.title && entry.body === w.body && entry.enabled === w.enabled;
        const untouched = !entry.title && !entry.body && entry.enabled !== false;
        let outcome;
        if (holds(wanted)) outcome = 'unchanged';
        else if (untouched) outcome = wanted.body || !wanted.enabled ? 'created' : 'unchanged';
        else if (baseline && holds(baseline.get(legacyKey))) outcome = 'updated';
        else outcome = 'protected';
        if (outcome === 'created' || outcome === 'updated') {
            value.messages[key] = { enabled: wanted.enabled, title: '', body: wanted.body };
        }
        outcomes.push({ legacyKey, key, outcome });
    }
    return { value, outcomes };
}

/** Which message a push is, from its data and who receives it; null if none. Pure. */
export function messageForPush(data = {}, ownerType = '') {
    const type = String(data?.type || '');
    if (!type) return null;
    const owner = String(ownerType || '').toUpperCase();
    const status = String(data?.orderStatus || '').toLowerCase();
    return (
        PUSH_MESSAGES.find(
            (message) =>
                message.owner === owner &&
                message.match.some((rule) => {
                    if (!rule.types.includes(type)) return false;
                    if (!rule.statuses) return true;
                    if (rule.statuses === CANCEL) return status.includes('cancel');
                    return rule.statuses.includes(status);
                }),
        ) || null
    );
}

/** Fill {placeholders}; unknown or empty ones become blank. Pure. */
export function renderPushText(template, vars = {}) {
    return String(template || '')
        .replace(/\{(\w+)\}/g, (_, name) => (vars[name] === undefined || vars[name] === null ? '' : String(vars[name])))
        .replace(/[ \t]{2,}/g, ' ')
        .trim();
}

/**
 * The payload with the admin's text in place of the code's, or `skip` when the
 * admin switched the message off. Pure, given loaded settings and the values
 * for the placeholders.
 */
export function applyPushMessageSettings(payload = {}, message, settings, vars = {}) {
    if (!message) return { payload };
    const entry = settings?.messages?.[message.key];
    if (!entry) return { payload };
    if (ownSwitch(message) && entry.enabled === false) return { payload, skip: true };

    const title = entry.title ? renderPushText(entry.title, vars) : '';
    const body = entry.body ? renderPushText(entry.body, vars) : '';
    if (!title && !body) return { payload };

    const next = { ...payload };
    if (title) next.title = title;
    if (body) next.body = body;
    // Data-only legs (new-order alerts) carry their text inside data, which is
    // what the apps render from.
    if (payload.data && typeof payload.data === 'object') {
        const data = { ...payload.data };
        if (title && data.title !== undefined) data.title = title;
        if (body && data.body !== undefined) data.body = body;
        next.data = data;
    }
    return { payload: next, message: message.key };
}

// ─── Loading ─────────────────────────────────────────────────────────────────

// Read at most every 30 seconds per process, like Notification Channels.
const TTL_MS = 30 * 1000;
let cache = { at: 0, value: null };

export function invalidatePushMessages() {
    cache = { at: 0, value: null };
}

async function loadSettings() {
    if (cache.value && Date.now() - cache.at < TTL_MS) return cache.value;
    const { prisma } = await import('../../config/prisma.js');
    const row = await prisma.foodSystemSetting.findUnique({ where: { key: AREA } });
    cache = { at: Date.now(), value: normalizePushMessages(row?.value) };
    return cache.value;
}

const hasText = (settings) =>
    Object.values(settings?.messages || {}).some((entry) => entry.title || entry.body || entry.enabled === false);

// One order read per payload: a fan-out to several owners reuses it.
const varsCache = new WeakMap();

/** Placeholder values for a push: its own string data, then the order's. */
async function varsForPayload(payload) {
    if (varsCache.has(payload)) return varsCache.get(payload);
    const promise = (async () => {
        const data = payload?.data && typeof payload.data === 'object' ? payload.data : {};
        const vars = {};
        for (const [key, value] of Object.entries(data)) {
            if (typeof value === 'string' || typeof value === 'number') vars[key] = String(value);
        }
        const ref = String(data.orderMongoId || data.orderRowId || data.orderId || '').trim();
        if (!ref) return vars;
        const { prisma } = await import('../../config/prisma.js');
        const where = /^[a-f0-9]{24}$/i.test(ref) ? { id: ref } : { OR: [{ order_id: ref }, { orderId: ref }] };
        const order = await prisma.foodOrder.findFirst({
            where,
            select: {
                id: true,
                order_id: true,
                customerName: true,
                total: true,
                restaurant: { select: { restaurantName: true } },
                user: { select: { name: true } },
                deliveryPartner: { select: { name: true } },
            },
        });
        if (!order) return vars;
        const customerName = order.customerName || order.user?.name || '';
        const restaurantName = order.restaurant?.restaurantName || '';
        return {
            ...vars,
            orderId: order.order_id || order.id,
            restaurantName,
            storeName: restaurantName,
            customerName,
            userName: customerName,
            deliveryManName: order.deliveryPartner?.name || data.partnerName || '',
            orderAmount: order.total != null ? String(Number(order.total)) : '',
        };
    })();
    if (payload && typeof payload === 'object') varsCache.set(payload, promise);
    return promise;
}

/**
 * The payload to send to this owner, with the admin's text when set, or
 * `{ skip: true }` when the admin switched this message off.
 */
export async function applyPushMessage(payload = {}, ownerType = '') {
    try {
        const message = messageForPush(payload?.data, ownerType);
        if (!message) return { payload };
        const settings = await loadSettings();
        if (!hasText(settings)) return { payload };
        const entry = settings.messages[message.key];
        if (!entry || (!entry.title && !entry.body && entry.enabled !== false)) return { payload };
        const vars = entry.title || entry.body ? await varsForPayload(payload) : {};
        return applyPushMessageSettings(payload, message, settings, vars);
    } catch (error) {
        logger.warn(`Push message settings unreadable, sending the default text: ${error?.message || error}`);
        return { payload };
    }
}
