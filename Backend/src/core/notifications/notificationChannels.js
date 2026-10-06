import { logger } from '../../utils/logger.js';

/**
 * Which channels (push, SMS, email) each notification event goes out on, as
 * the admin set it on Notification Channels.
 *
 * Only push is wired: every push in the system goes through
 * sendNotificationToOwner, which asks isPushAllowed() first. Events are
 * recognised by the `data.type` the sending code already puts on its payload,
 * and by who receives it -- 'new_order' to a restaurant is a new-order alert,
 * the same type to a rider is a delivery offer, which is not switchable here
 * because turning it off would stop orders being delivered.
 *
 * This system sends no SMS or email for these events yet, so those switches
 * are saved for when it does (and for the apps to read); they change nothing
 * today. A push whose type is not listed here is always sent.
 */

export const CHANNELS = ['push', 'sms', 'email'];

export const NOTIFICATION_EVENTS = [
    {
        key: 'restaurant_new_order',
        label: 'New order for a restaurant',
        audience: 'Restaurant',
        types: ['new_order', 'order_created'],
        owners: ['RESTAURANT'],
    },
    {
        key: 'order_status',
        label: 'Order status changes',
        audience: 'Customer, restaurant, rider',
        types: ['order_status_update'],
    },
    { key: 'order_cancelled', label: 'Order cancelled', audience: 'Customer, restaurant, rider', types: ['order_cancelled'] },
    { key: 'refund', label: 'Refund processed', audience: 'Customer', types: ['refund_processed'] },
    {
        key: 'rider_progress',
        label: 'Rider accepted, picked up or arrived',
        audience: 'Customer, restaurant',
        types: ['delivery_accepted', 'order_taken', 'rider_arrived'],
    },
    { key: 'chat_message', label: 'Chat messages', audience: 'Everyone', types: ['chat_message'] },
    {
        key: 'wallet',
        label: 'Wallet, payments, withdrawals and bonuses',
        audience: 'Customer, rider, restaurant',
        types: ['payment', 'credit', 'withdrawal', 'deposit', 'bonus', 'referral_bonus', 'earning_addon'],
    },
];

const defaultEvent = () => ({ push: true, sms: false, email: false });

/** Every event with all three switches, whatever was stored. */
export function normalizeChannelSettings(value = {}) {
    const stored = value && typeof value === 'object' && value.events && typeof value.events === 'object' ? value.events : {};
    const events = {};
    for (const event of NOTIFICATION_EVENTS) {
        const saved = stored[event.key] && typeof stored[event.key] === 'object' ? stored[event.key] : {};
        const base = defaultEvent();
        events[event.key] = Object.fromEntries(
            CHANNELS.map((channel) => [channel, typeof saved[channel] === 'boolean' ? saved[channel] : base[channel]]),
        );
    }
    return { events };
}

/** Which switchable event a push is, from its type and who receives it; null if none. */
export function eventForPush(type, ownerType) {
    const kind = String(type || '');
    if (!kind) return null;
    const owner = String(ownerType || '').toUpperCase();
    const event = NOTIFICATION_EVENTS.find(
        (candidate) => candidate.types.includes(kind) && (!candidate.owners || candidate.owners.includes(owner)),
    );
    return event?.key || null;
}

/** Pure decision, given loaded settings. Unknown events are always allowed. */
export function channelAllowed(settings, event, channel) {
    if (!event) return true;
    return settings?.events?.[event]?.[channel] !== false;
}

// Read at most every 30 seconds per process: this sits on every push.
const TTL_MS = 30 * 1000;
let cache = { at: 0, value: null };

export function invalidateChannelSettings() {
    cache = { at: 0, value: null };
}

async function loadSettings() {
    if (cache.value && Date.now() - cache.at < TTL_MS) return cache.value;
    const { prisma } = await import('../../config/prisma.js');
    const row = await prisma.foodSystemSetting.findUnique({ where: { key: 'notification_channels' } });
    cache = { at: Date.now(), value: normalizeChannelSettings(row?.value) };
    return cache.value;
}

/**
 * Whether `event` should go out on `channel`. Fails open: if the settings
 * cannot be read, the notification is sent as it always was.
 */
export async function isChannelEnabled(event, channel) {
    if (!event) return true;
    try {
        return channelAllowed(await loadSettings(), event, channel);
    } catch (error) {
        logger.warn(`Notification channel settings unreadable, sending anyway: ${error?.message || error}`);
        return true;
    }
}

/** Whether a push payload to this owner type may be sent. */
export async function isPushAllowed(payload = {}, ownerType = '') {
    const type = payload?.data?.type ?? payload?.type;
    return isChannelEnabled(eventForPush(type, ownerType), 'push');
}
