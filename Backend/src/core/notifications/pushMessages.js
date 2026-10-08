import { logger } from '../../utils/logger.js';

/**
 * The admin's own wording for the order pushes (System Settings -> 3rd Party &
 * Configurations -> Firebase notification), like the old 6amMart panel's
 * "push notification messages".
 *
 * Every push goes through sendNotificationToOwner, which hands its payload to
 * applyPushMessage() after the Notification Channels check. A push is matched
 * to a message here by the `data.type` (and `data.orderStatus`) the sending
 * code already puts on it and by who receives it. When the admin wrote a title
 * or body for that message, it replaces the code's wording, with placeholders
 * such as {orderId} filled from the order; when the admin left it blank, the
 * code's wording goes out unchanged.
 *
 * Switching: a message whose event Notification Channels already switches
 * (order status, cancellations, refunds, rider progress, a restaurant's new
 * order) has its on/off THERE, not here -- one switch per event. Messages that
 * page cannot switch get their own switch here, except the delivery offer to
 * riders, which is never switchable because without it orders are not
 * delivered.
 *
 * Fails open: if the settings or the order cannot be read, the push goes out
 * as the code wrote it.
 */

export const AREA = 'push_messages';

const CANCEL = 'cancel';

/** Placeholders every order message can use. */
const ORDER_VARS = ['orderId', 'restaurantName', 'customerName', 'userName', 'deliveryManName', 'orderAmount'];

/**
 * key, label, who gets it, how a push is recognised (any of `match`), and
 * `channel`: the Notification Channels event that switches it (null when this
 * page switches it), or `locked` when it cannot be switched at all.
 */
export const PUSH_MESSAGES = [
    // Customer.
    {
        key: 'customer_order_placed',
        label: 'Order placed',
        audience: 'Customer',
        owner: 'USER',
        match: [{ types: ['order_created'] }],
        channel: null,
    },
    {
        key: 'customer_order_confirmed',
        label: 'Order confirmed by the restaurant',
        audience: 'Customer',
        owner: 'USER',
        match: [{ types: ['order_status_update'], statuses: ['confirmed'] }],
        channel: 'order_status',
    },
    {
        key: 'customer_order_processing',
        label: 'Order processing (cooking)',
        audience: 'Customer',
        owner: 'USER',
        match: [{ types: ['order_status_update'], statuses: ['preparing'] }],
        channel: 'order_status',
    },
    {
        key: 'customer_order_ready',
        label: 'Order ready for handover',
        audience: 'Customer',
        owner: 'USER',
        match: [{ types: ['order_status_update'], statuses: ['ready_for_pickup'] }],
        channel: 'order_status',
    },
    {
        key: 'customer_rider_assigned',
        label: 'Delivery man assigned',
        audience: 'Customer',
        owner: 'USER',
        match: [{ types: ['delivery_accepted'] }],
        channel: 'rider_progress',
    },
    {
        key: 'customer_out_for_delivery',
        label: 'Order out for delivery',
        audience: 'Customer',
        owner: 'USER',
        match: [{ types: ['order_status_update'], statuses: ['picked_up'] }],
        channel: 'order_status',
    },
    {
        key: 'customer_rider_nearby',
        label: 'Delivery man reached the customer',
        audience: 'Customer',
        owner: 'USER',
        match: [{ types: ['order_status_update'], statuses: ['reached_drop'] }],
        channel: 'order_status',
    },
    {
        key: 'customer_order_delivered',
        label: 'Order delivered',
        audience: 'Customer',
        owner: 'USER',
        match: [{ types: ['order_status_update'], statuses: ['delivered'] }],
        channel: 'order_status',
    },
    {
        key: 'customer_order_cancelled',
        label: 'Order cancelled',
        audience: 'Customer',
        owner: 'USER',
        match: [{ types: ['order_cancelled'] }, { types: ['order_status_update'], statuses: CANCEL }],
        channel: 'order_cancelled',
    },
    {
        key: 'customer_order_refunded',
        label: 'Order refunded',
        audience: 'Customer',
        owner: 'USER',
        match: [{ types: ['refund_processed'] }],
        channel: 'refund',
    },
    {
        key: 'customer_payment_failed',
        label: 'Payment failed or offline payment rejected',
        audience: 'Customer',
        owner: 'USER',
        match: [{ types: ['payment_failed'] }],
        channel: null,
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
    },
    {
        key: 'restaurant_order_cancelled',
        label: 'Order cancelled',
        audience: 'Restaurant',
        owner: 'RESTAURANT',
        match: [{ types: ['order_cancelled'] }, { types: ['order_status_update'], statuses: CANCEL }],
        channel: 'order_cancelled',
    },
    {
        key: 'restaurant_rider_assigned',
        label: 'Delivery man assigned',
        audience: 'Restaurant',
        owner: 'RESTAURANT',
        match: [{ types: ['delivery_accepted'] }],
        channel: 'rider_progress',
    },
    {
        key: 'restaurant_rider_arrived',
        label: 'Delivery man arrived at the restaurant',
        audience: 'Restaurant',
        owner: 'RESTAURANT',
        match: [{ types: ['rider_arrived'] }],
        channel: 'rider_progress',
    },
    {
        key: 'restaurant_order_picked_up',
        label: 'Order picked up',
        audience: 'Restaurant',
        owner: 'RESTAURANT',
        match: [{ types: ['order_status_update'], statuses: ['picked_up'] }],
        channel: 'order_status',
    },
    {
        key: 'restaurant_order_delivered',
        label: 'Order delivered',
        audience: 'Restaurant',
        owner: 'RESTAURANT',
        match: [{ types: ['order_status_update'], statuses: ['delivered'] }],
        channel: 'order_status',
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
    },
    {
        key: 'rider_order_assigned',
        label: 'Order assigned to you',
        audience: 'Delivery man',
        owner: 'DELIVERY_PARTNER',
        match: [{ types: ['delivery_accepted'] }],
        channel: 'rider_progress',
    },
    {
        key: 'rider_order_picked_up',
        label: 'Order picked up',
        audience: 'Delivery man',
        owner: 'DELIVERY_PARTNER',
        match: [{ types: ['order_status_update'], statuses: ['picked_up'] }],
        channel: 'order_status',
    },
    {
        key: 'rider_order_delivered',
        label: 'Delivery completed',
        audience: 'Delivery man',
        owner: 'DELIVERY_PARTNER',
        match: [{ types: ['order_completed'] }],
        channel: null,
    },
    {
        key: 'rider_order_cancelled',
        label: 'Order cancelled',
        audience: 'Delivery man',
        owner: 'DELIVERY_PARTNER',
        match: [{ types: ['order_cancelled'] }, { types: ['order_status_update'], statuses: CANCEL }],
        channel: 'order_cancelled',
    },
];

/** Whether this page carries the on/off switch for a message. */
export const ownSwitch = (message) => Boolean(message) && !message.channel && !message.locked;

/** The placeholders a message's text may use. */
export const placeholdersFor = (message) => [...ORDER_VARS, ...(message?.extraVars || [])];

/** What the admin page renders: the messages without the matching rules. */
export const PUSH_MESSAGE_CATALOG = PUSH_MESSAGES.map((message) => ({
    key: message.key,
    label: message.label,
    audience: message.audience,
    switchable: ownSwitch(message),
    switchedOn: message.channel ? 'notification_channels' : message.locked ? 'never' : 'here',
    channel: message.channel,
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
        return {
            ...vars,
            orderId: order.order_id || order.id,
            restaurantName: order.restaurant?.restaurantName || '',
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
