import { ValidationError } from '../../../../core/auth/errors.js';
import { getRestaurantAvailabilityStatus } from '../../restaurant/helpers/restaurantAvailability.helper.js';
import { getRestaurantLocalTimeParts, getRestaurantTimezone } from '../../../../utils/timezone.js';
import { isScheduledFor } from './businessRules.js';

/**
 * The three Business Settings order options as pure rules over the cleaned
 * settings: scheduled orders (business_order.scheduledOrder), takeaway
 * (business_order.takeaway / homeDelivery, and the restaurant's own
 * takeawayEnabled) and rider tips (business_deliveryman.tipsEnabled).
 *
 * Each one switched off gives exactly the behaviour from before it existed:
 * every order a home delivery, no tip, and a time ahead of now refused.
 */

const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;
const MINUTE = 60 * 1000;
const positive = (value, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : fallback;
};

// ─── Order type ──────────────────────────────────────────────────────────────

export const ORDER_TYPES = ['delivery', 'takeaway'];

/** Methods a takeaway order may be paid with: paid before pickup, never collected at a door. */
export const TAKEAWAY_PAYMENT_METHODS = ['razorpay', 'card', 'wallet', 'offline'];

/**
 * 'delivery' or 'takeaway' for a new order, or a refusal worded for the
 * customer. Nothing sent = delivery, as every order was before.
 */
export function resolveOrderType(requested, { orderRules, restaurant } = {}) {
    const type = String(requested || 'delivery').trim().toLowerCase();
    if (!ORDER_TYPES.includes(type)) throw new ValidationError('Choose delivery or takeaway');
    if (type === 'takeaway') {
        if (!orderRules?.takeaway) throw new ValidationError('Takeaway is not available right now.');
        if (restaurant && restaurant.takeawayEnabled === false) {
            throw new ValidationError(`${restaurant.restaurantName || 'This restaurant'} does not offer takeaway.`);
        }
        return type;
    }
    if (orderRules && orderRules.homeDelivery === false) {
        throw new ValidationError('Home delivery is not available right now. Please choose takeaway.');
    }
    return type;
}

export function takeawayPaymentRefusal(method) {
    return TAKEAWAY_PAYMENT_METHODS.includes(String(method || ''))
        ? null
        : 'Takeaway orders are paid in the app. Please pay online or with your wallet.';
}

// ─── Rider tip ───────────────────────────────────────────────────────────────

/** Most a customer may tip on one order. */
export const MAX_RIDER_TIP = 500;
/** The amounts the apps offer as one-tap choices (a custom amount is allowed too). */
export const TIP_PRESETS = [10, 20, 30, 50];

/**
 * The tip to charge, in rupees with paise. 0 when none was sent. Refused when
 * tips are off or the order has no rider (takeaway), and above the cap.
 */
export function cleanRiderTip(value, { tipsEnabled = false, orderType = 'delivery' } = {}) {
    if (value === undefined || value === null || value === '') return 0;
    const tip = Number(value);
    if (!Number.isFinite(tip) || tip < 0) throw new ValidationError('Enter a valid tip amount');
    if (tip === 0) return 0;
    if (!tipsEnabled) throw new ValidationError('Tips are not available right now.');
    if (orderType === 'takeaway') throw new ValidationError('A takeaway order has no delivery partner to tip.');
    if (tip > MAX_RIDER_TIP) throw new ValidationError(`A tip can be at most ₹${MAX_RIDER_TIP}`);
    return round2(tip);
}

// ─── Scheduled orders ────────────────────────────────────────────────────────

/** Shortest notice a scheduled order may be placed with. */
export const scheduleLeadMinutes = () => positive(process.env.SCHEDULED_ORDER_MIN_LEAD_MINUTES, 45);
/**
 * How long before the scheduled time the restaurant is alerted (the new-order
 * ring and its acceptance window start) and riders may be dispatched -- about
 * the time an order placed for "now" takes to arrive.
 */
export const scheduleReleaseMinutes = () => positive(process.env.SCHEDULED_ORDER_RELEASE_MINUTES, 40);
/** Today and tomorrow, in the restaurant's timezone. */
export const SCHEDULE_DAYS = 2;

/** Start of the local day `date` falls in, as an instant. Fixed-offset zones (India) only. */
function localDayStart(date) {
    const { nowMinutes } = getRestaurantLocalTimeParts(date);
    const ms = date.getTime();
    return new Date(ms - nowMinutes * MINUTE - (ms % MINUTE));
}

/**
 * When a scheduled order is released to the restaurant and riders, or null
 * for an order meant for now.
 */
export function releaseAtFor(scheduledAt, now = new Date()) {
    if (!isScheduledFor(scheduledAt, now)) return null;
    const at = new Date(scheduledAt).getTime() - scheduleReleaseMinutes() * MINUTE;
    return new Date(Math.max(at, now.getTime()));
}

/** True while a scheduled order is still waiting for its release time. */
export function isHeldForSchedule(order, now = new Date()) {
    const release = order?.releaseAt ? new Date(order.releaseAt) : null;
    return Boolean(release && !Number.isNaN(release.getTime()) && release.getTime() > now.getTime());
}

/**
 * Refuses a scheduled time the customer could not have been offered: sooner
 * than the lead time, past tomorrow, or when the restaurant is closed then.
 * A time within a few minutes of now is an order for now and is not checked
 * here (isScheduledFor).
 */
export function assertSchedulable(scheduledAt, { restaurant, now = new Date() } = {}) {
    const at = new Date(scheduledAt);
    if (Number.isNaN(at.getTime())) throw new ValidationError('Invalid scheduled time');
    // A slot listed a minute ago is still accepted.
    const earliest = now.getTime() + (scheduleLeadMinutes() - 5) * MINUTE;
    if (at.getTime() < earliest) {
        throw new ValidationError(`Scheduled orders must be at least ${scheduleLeadMinutes()} minutes from now. Please pick a later time.`);
    }
    const horizon = localDayStart(now).getTime() + SCHEDULE_DAYS * 24 * 60 * MINUTE;
    if (at.getTime() >= horizon) throw new ValidationError('Orders can be scheduled for today or tomorrow only.');
    if (restaurant && !getRestaurantAvailabilityStatus(restaurant, at, { ignoreOperationalStatus: true }).isOpen) {
        throw new ValidationError(`${restaurant.restaurantName || 'The restaurant'} is closed at that time. Please pick another slot.`);
    }
    return at;
}

const DAY_LABEL = new Intl.DateTimeFormat('en-IN', { timeZone: getRestaurantTimezone(), weekday: 'short', day: 'numeric', month: 'short' });
const TIME_LABEL = new Intl.DateTimeFormat('en-IN', { timeZone: getRestaurantTimezone(), hour: 'numeric', minute: '2-digit', hour12: true });
const DATE_KEY = new Intl.DateTimeFormat('en-CA', { timeZone: getRestaurantTimezone(), year: 'numeric', month: '2-digit', day: '2-digit' });

/**
 * Every slot a customer may schedule for, grouped by day: from the lead time
 * onwards, on the slot interval from the local midnight, through tomorrow,
 * only slots wholly inside the restaurant's opening hours.
 */
export function buildScheduleSlots(restaurant, { slotMinutes = 30, now = new Date() } = {}) {
    const step = Math.max(5, Number(slotMinutes) || 30) * MINUTE;
    const dayStart = localDayStart(now);
    const earliest = now.getTime() + scheduleLeadMinutes() * MINUTE;
    const end = dayStart.getTime() + SCHEDULE_DAYS * 24 * 60 * MINUTE;
    const days = [];
    for (let d = 0; d < SCHEDULE_DAYS; d += 1) {
        const start = dayStart.getTime() + d * 24 * 60 * MINUTE;
        days.push({
            date: DATE_KEY.format(new Date(start + 12 * 60 * MINUTE)),
            label: d === 0 ? 'Today' : 'Tomorrow',
            dayName: DAY_LABEL.format(new Date(start + 12 * 60 * MINUTE)),
            slots: [],
        });
    }
    const first = dayStart.getTime() + Math.ceil((earliest - dayStart.getTime()) / step) * step;
    for (let t = first; t < end; t += step) {
        const at = new Date(t);
        const slotEnd = new Date(Math.min(t + step, end));
        // The whole slot inside the opening hours: open when it starts and
        // still open a minute before it ends.
        const openAt = (when) => !restaurant
            || getRestaurantAvailabilityStatus(restaurant, when, { ignoreOperationalStatus: true }).isOpen;
        if (!openAt(at) || !openAt(new Date(slotEnd.getTime() - MINUTE))) continue;
        const day = days[Math.floor((t - dayStart.getTime()) / (24 * 60 * MINUTE))];
        if (!day) continue;
        day.slots.push({
            scheduledAt: at.toISOString(),
            endsAt: slotEnd.toISOString(),
            label: `${TIME_LABEL.format(at)} - ${TIME_LABEL.format(slotEnd)}`,
        });
    }
    return days;
}
