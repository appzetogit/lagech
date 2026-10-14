import { logger } from '../../utils/logger.js';
import { ValidationError } from '../auth/errors.js';

/**
 * A restaurant's own notification choices, like the old 6amMart store panel's
 * "Notification Setup" (store_notification_settings): per event, a mail, SMS
 * and push switch. Each channel of an event is
 *
 *   active    sent (the default for every channel the event offers)
 *   inactive  switched off by the restaurant: not sent
 *   disable   not offered for this event: no switch on the page
 *
 * Which channels an event offers is fixed here (the old panel's defaults), not
 * by the stored rows. A missing row means the defaults.
 *
 * Wired today:
 *   - push: sendNotificationToOwner asks isRestaurantNotificationOn() for every
 *     push to a restaurant whose `data.type` belongs to an event below;
 *   - mail: the restaurant emails (withdrawal decision, account suspended or
 *     restored) pass their event to deliverEmail, which asks the same.
 * Events the system sends nothing for yet (advertisements, subscriptions,
 * campaign join decisions) keep their switches for when it does; `wired` on
 * each channel tells the page. This system sends no SMS for these events.
 *
 * Fails open: if the settings cannot be read, the notification is sent.
 */

export const CHANNELS = ['mail', 'sms', 'push'];
export const STATUSES = ['active', 'inactive', 'disable'];
const COLUMN = { mail: 'mailStatus', sms: 'smsStatus', push: 'pushStatus' };

const MAIL_PUSH = { mail: 'active', sms: 'disable', push: 'active' };

/**
 * key (the old panel's), label, what it covers, the channels it offers, and
 * how a send is recognised: push `data.type`s and email templates.
 */
export const RESTAURANT_NOTIFICATION_EVENTS = [
    {
        key: 'store_order_notification',
        label: 'Order notification',
        description: 'New orders, and changes to your orders (status, cancellation, rider assigned or arrived, edits by support).',
        channels: { mail: 'disable', sms: 'disable', push: 'active' },
        pushTypes: ['new_order', 'order_created', 'order_status_update', 'order_cancelled', 'delivery_accepted', 'order_taken', 'rider_arrived', 'order_updated', 'order_deassigned'],
    },
    {
        key: 'store_account_block',
        label: 'Account block',
        description: 'When the admin suspends your restaurant account.',
        channels: MAIL_PUSH,
        emailTemplates: ['account_suspended'],
    },
    {
        key: 'store_account_unblock',
        label: 'Account unblock',
        description: 'When the admin restores your restaurant account.',
        channels: MAIL_PUSH,
        emailTemplates: ['account_unsuspended'],
    },
    {
        key: 'store_withdraw_approve',
        label: 'Withdraw approve',
        description: 'When a withdrawal or payout is approved and paid.',
        channels: MAIL_PUSH,
        emailTemplates: ['withdraw_approved'],
    },
    {
        key: 'store_withdraw_rejaction',
        label: 'Withdraw rejection',
        description: 'When a withdrawal or payout is rejected.',
        channels: MAIL_PUSH,
        emailTemplates: ['withdraw_rejected'],
    },
    {
        key: 'store_campaign_join_request',
        label: 'Campaign join request',
        description: 'When you ask to join a campaign.',
        channels: { mail: 'active', sms: 'disable', push: 'disable' },
    },
    {
        key: 'store_campaign_join_rejaction',
        label: 'Campaign join rejection',
        description: 'When your request to join a campaign is rejected.',
        channels: MAIL_PUSH,
    },
    {
        key: 'store_campaign_join_approval',
        label: 'Campaign join approval',
        description: 'When your request to join a campaign is approved.',
        channels: MAIL_PUSH,
    },
    {
        key: 'store_product_approve',
        label: 'Product approve',
        description: 'When the admin approves a dish or an addon you added.',
        channels: MAIL_PUSH,
        pushTypes: ['food_approved', 'addon_approved'],
    },
    {
        key: 'store_product_reject',
        label: 'Product reject',
        description: 'When the admin rejects a dish or an addon you added.',
        channels: MAIL_PUSH,
        pushTypes: ['food_rejected', 'addon_rejected'],
    },
    { key: 'store_advertisement_create_by_admin', label: 'Advertisement created by admin', description: 'When the admin creates an advertisement for you.', channels: MAIL_PUSH },
    { key: 'store_advertisement_approval', label: 'Advertisement approval', description: 'When your advertisement request is approved.', channels: MAIL_PUSH },
    { key: 'store_advertisement_deny', label: 'Advertisement deny', description: 'When your advertisement request is denied.', channels: MAIL_PUSH },
    { key: 'store_advertisement_resume', label: 'Advertisement resume', description: 'When your advertisement is resumed.', channels: MAIL_PUSH },
    { key: 'store_advertisement_pause', label: 'Advertisement pause', description: 'When your advertisement is paused.', channels: MAIL_PUSH },
    { key: 'store_subscription_success', label: 'Subscription success', description: 'When a subscription plan is bought.', channels: MAIL_PUSH },
    { key: 'store_subscription_renew', label: 'Subscription renew', description: 'When your subscription is renewed.', channels: MAIL_PUSH },
    { key: 'store_subscription_shift', label: 'Subscription shift', description: 'When you move to another subscription plan.', channels: MAIL_PUSH },
    { key: 'store_subscription_cancel', label: 'Subscription cancel', description: 'When your subscription is cancelled.', channels: MAIL_PUSH },
    { key: 'store_subscription_plan_update', label: 'Subscription plan update', description: 'When the admin changes your subscription plan.', channels: MAIL_PUSH },
];

const EVENTS = new Map(RESTAURANT_NOTIFICATION_EVENTS.map((event) => [event.key, event]));

/** Whether the event lets the restaurant switch this channel. */
export const isOffered = (eventKey, channel) => {
    const event = EVENTS.get(eventKey);
    return Boolean(event) && CHANNELS.includes(channel) && event.channels[channel] !== 'disable';
};

/** Whether this system sends anything on that channel for the event today. */
const isWired = (event, channel) =>
    (channel === 'push' && Boolean(event.pushTypes?.length)) || (channel === 'mail' && Boolean(event.emailTemplates?.length));

/** The status a stored value stands for. Pure. */
export function statusFor(eventKey, channel, stored) {
    if (!isOffered(eventKey, channel)) return 'disable';
    return stored === 'inactive' ? 'inactive' : 'active';
}

/**
 * Every event with each channel's status, offer and wiring, from this
 * restaurant's rows (any missing row is the defaults). Pure.
 */
export function resolveRestaurantSettings(rows = []) {
    const byKey = new Map((rows || []).map((row) => [row.key, row]));
    return RESTAURANT_NOTIFICATION_EVENTS.map((event) => {
        const row = byKey.get(event.key) || {};
        const entry = { key: event.key, label: event.label, description: event.description };
        for (const channel of CHANNELS) {
            entry[channel] = {
                status: statusFor(event.key, channel, row[COLUMN[channel]]),
                offered: isOffered(event.key, channel),
                wired: channel !== 'sms' && isWired(event, channel),
            };
        }
        return entry;
    });
}

/**
 * Whether a notification for `eventKey` goes out on `channel`, given this
 * restaurant's rows. Unknown events and channels the event does not offer
 * are not the restaurant's to switch, so they are sent. Pure.
 */
export function channelOn(rows, eventKey, channel) {
    if (!eventKey || !isOffered(eventKey, channel)) return true;
    const row = (rows || []).find((candidate) => candidate.key === eventKey);
    return statusFor(eventKey, channel, row?.[COLUMN[channel]]) === 'active';
}

/** The event a push to a restaurant belongs to, from its data; null if none. Pure. */
export function eventForRestaurantPush(data = {}) {
    const type = String(data?.type || '');
    if (!type) return null;
    return RESTAURANT_NOTIFICATION_EVENTS.find((event) => event.pushTypes?.includes(type))?.key || null;
}

/** A switch change from the page, checked. Pure. */
export function readSettingChange(body = {}) {
    const key = String(body.key || '').trim();
    if (!EVENTS.has(key)) throw new ValidationError('Unknown notification');
    const channel = String(body.channel || '').trim().toLowerCase();
    if (!CHANNELS.includes(channel)) throw new ValidationError('Channel must be mail, sms or push');
    if (!isOffered(key, channel)) throw new ValidationError(`${EVENTS.get(key).label} cannot be switched for ${channel}`);
    let status = body.status !== undefined ? String(body.status).trim().toLowerCase() : null;
    if (status === null && body.enabled !== undefined) {
        status = body.enabled === true || body.enabled === 'true' ? 'active' : 'inactive';
    }
    if (status !== 'active' && status !== 'inactive') throw new ValidationError('Status must be active or inactive');
    return { key, channel, status };
}

// ─── Loading ─────────────────────────────────────────────────────────────────

// Per restaurant, read at most every 30 seconds per process: this sits on
// every push to a restaurant.
const TTL_MS = 30 * 1000;
const cache = new Map();

export function invalidateRestaurantNotificationSettings(restaurantId) {
    if (restaurantId) cache.delete(String(restaurantId));
    else cache.clear();
}

async function loadRows(restaurantId) {
    const id = String(restaurantId);
    const hit = cache.get(id);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.rows;
    const { prisma } = await import('../../config/prisma.js');
    const rows = await prisma.foodRestaurantNotificationSetting.findMany({
        where: { restaurantId: id },
        select: { key: true, mailStatus: true, smsStatus: true, pushStatus: true },
    });
    if (cache.size > 5000) cache.clear();
    cache.set(id, { at: Date.now(), rows });
    return rows;
}

/** Whether this restaurant wants `eventKey` on `channel`. Fails open. */
export async function isRestaurantNotificationOn(restaurantId, eventKey, channel) {
    if (!restaurantId || !eventKey || !isOffered(eventKey, channel)) return true;
    try {
        return channelOn(await loadRows(restaurantId), eventKey, channel);
    } catch (error) {
        logger.warn(`Restaurant notification settings unreadable, sending anyway: ${error?.message || error}`);
        return true;
    }
}

/** Whether a push payload to this restaurant may be sent. */
export async function isRestaurantPushAllowed(restaurantId, payload = {}) {
    return isRestaurantNotificationOn(restaurantId, eventForRestaurantPush(payload?.data), 'push');
}

// ─── The restaurant panel ────────────────────────────────────────────────────

export async function getRestaurantNotificationSettings(restaurantId) {
    const { prisma } = await import('../../config/prisma.js');
    const rows = await prisma.foodRestaurantNotificationSetting.findMany({ where: { restaurantId: String(restaurantId) } });
    const updatedAt = rows.reduce((latest, row) => (!latest || row.updatedAt > latest ? row.updatedAt : latest), null);
    return { events: resolveRestaurantSettings(rows), updatedAt };
}

export async function updateRestaurantNotificationSetting(restaurantId, body = {}) {
    const { key, channel, status } = readSettingChange(body);
    const { prisma } = await import('../../config/prisma.js');
    const id = String(restaurantId);
    const defaults = Object.fromEntries(CHANNELS.map((c) => [COLUMN[c], statusFor(key, c, undefined)]));
    await prisma.foodRestaurantNotificationSetting.upsert({
        where: { restaurantId_key: { restaurantId: id, key } },
        create: { restaurantId: id, key, ...defaults, [COLUMN[channel]]: status },
        update: { [COLUMN[channel]]: status },
    });
    invalidateRestaurantNotificationSettings(id);
    return getRestaurantNotificationSettings(id);
}
