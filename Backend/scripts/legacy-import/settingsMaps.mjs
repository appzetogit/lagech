/**
 * Pure mappings for the steps notification-messages, store-notification-settings
 * and faqs: old rows in, rows for this system out. Kept apart from the steps
 * (which write through Prisma) so they can be tested without a database.
 */
import { RESTAURANT_NOTIFICATION_EVENTS, statusFor } from '../../src/core/notifications/restaurantNotificationSettings.js';
import { readFaqInput } from '../../src/modules/food/admin/services/faq.helpers.js';

// ─── notification-messages ───────────────────────────────────────────────────

/** business_settings rows ({"status":1,"message":"..."}) as notification_messages rows. */
export function rowsFromBusinessSettings(rows = []) {
    const out = [];
    for (const row of rows || []) {
        let parsed = null;
        try {
            parsed = typeof row.value === 'string' ? JSON.parse(row.value) : row.value;
        } catch {
            parsed = null;
        }
        if (!parsed || typeof parsed !== 'object') continue;
        out.push({ id: row.id, key: row.key, message: parsed.message ?? '', status: parsed.status ?? 1 });
    }
    return out;
}

// ─── store-notification-settings ────────────────────────────────────────────

const EVENT_KEYS = new Set(RESTAURANT_NOTIFICATION_EVENTS.map((event) => event.key));
const STATUS_FIELDS = ['mailStatus', 'smsStatus', 'pushStatus'];

/**
 * One store_notification_settings row -> { data } or { skip: reason }.
 * 'inactive' stays off, anything else on; a channel the event does not offer
 * here is 'disable' whatever the old row said.
 */
export function mapStoreNotificationRow(row, restaurants) {
    const key = String(row?.key || '').trim();
    if (!EVENT_KEYS.has(key)) return { skip: `"${key || '(blank)'}" is not a Notification Setup event here` };
    const restaurantId = restaurants.get(String(row.store_id));
    if (!restaurantId) return { skip: `store ${row.store_id} was not imported` };
    return {
        data: {
            restaurantId,
            key,
            mailStatus: statusFor(key, 'mail', row.mail_status),
            smsStatus: statusFor(key, 'sms', row.sms_status),
            pushStatus: statusFor(key, 'push', row.push_notification_status),
        },
    };
}

const sameStatuses = (a, b) => Boolean(a && b) && STATUS_FIELDS.every((field) => a[field] === b[field]);

/**
 * What to do with one mapped row, given the row here (if any) and, on a sync,
 * what the baseline copy's row mapped to. A row here is the restaurant's own
 * choice: only one still holding what the old system had follows a change.
 * @returns {'create' | 'update' | 'unchanged' | 'protected'}
 */
export function decideStoreNotificationRow(wanted, here, baselineWanted = null) {
    if (!here) return 'create';
    if (sameStatuses(here, wanted)) return 'unchanged';
    if (baselineWanted && sameStatuses(here, baselineWanted)) return 'update';
    return 'protected';
}

// ─── faqs ────────────────────────────────────────────────────────────────────

/** Old f_a_q_s.user_type -> audience here (null: everyone). */
const AUDIENCE = { customer: 'customer', user: 'customer', vendor: 'restaurant', store: 'restaurant', deliveryman: 'rider', delivery_man: 'rider' };

/** One f_a_q_s row -> { data } or { skip: reason }. `index` is its place in the list. */
export function mapLegacyFaq(row, index = 0) {
    const userType = String(row?.user_type || '').trim().toLowerCase();
    try {
        const data = readFaqInput({
            question: row?.question,
            answer: row?.answer,
            audience: AUDIENCE[userType] ?? null,
            isActive: Number(row?.status) === 1,
            sortOrder: index,
        });
        if (row?.created_at) data.createdAt = row.created_at;
        return { data };
    } catch (error) {
        return { skip: error.message };
    }
}
