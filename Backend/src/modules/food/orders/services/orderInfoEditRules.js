/**
 * The rest of the old 6amMart panel's Order Details edits, as pure rules so
 * they are tested without a database (adminOrderInfoEdit.service.js applies
 * them):
 *
 *   Delivery info   receiver, phone, address text and the map pin
 *   Order note      the cooking note and the rider's delivery instructions
 *   Cutlery         send cutlery or not
 *   Schedule        the time of a scheduled order not released yet
 *   Payment status  "Mark as paid / unpaid" for a cash order
 *
 * Each `...Refusal` returns why the admin may not make the change, or null.
 * They take the toOrder shape (payment.method, deliveryState.pickedUpAt) or
 * a bare row (paymentMethod, pickedUpAt).
 */
import { ValidationError } from '../../../../core/auth/errors.js';

const CANCELLED = ['cancelled_by_user', 'cancelled_by_restaurant', 'cancelled_by_admin'];
const PICKED_UP = ['picked_up', 'reached_drop'];

const statusOf = (order) => String(order?.orderStatus || '');
const methodOf = (order) => String(order?.payment?.method ?? order?.paymentMethod ?? '');
const paymentStatusOf = (order) => String(order?.payment?.status ?? order?.paymentStatus ?? '');
const walletPartOf = (order) => {
    if (methodOf(order) === 'wallet') return 0;
    return Number(order?.payment?.walletAmount ?? order?.walletAmount ?? 0) || 0;
};
const pickedUp = (order) =>
    Boolean(order?.deliveryState?.pickedUpAt ?? order?.pickedUpAt) || PICKED_UP.includes(statusOf(order));

/** Delivered or cancelled: nothing about the order changes any more. */
function closedRefusal(order) {
    if (!order) return 'Order not found';
    const status = statusOf(order);
    if (CANCELLED.includes(status)) return 'This order was cancelled.';
    if (status === 'delivered') return 'This order was already delivered.';
    return null;
}

// ─── Delivery info ──────────────────────────────────────────────────────────

/** Until delivered or cancelled, as 6amMart; a takeaway has no address. */
export function addressEditRefusal(order) {
    const closed = closedRefusal(order);
    if (closed) return closed;
    if (String(order.orderType || 'delivery') === 'takeaway') {
        return 'This is a takeaway order: the customer collects it, so it has no delivery address.';
    }
    return null;
}

export const ADDRESS_LABELS = ['Home', 'Office', 'Other'];
const ADDRESS_LIMITS = { name: 100, phone: 20, street: 300, additionalDetails: 300, city: 100, state: 100, zipCode: 12 };

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

function cleanText(value, label, max, { required = false } = {}) {
    if (value != null && typeof value !== 'string' && typeof value !== 'number') {
        throw new ValidationError(`${label} must be text`);
    }
    const text = String(value ?? '').replace(/\s+/g, ' ').trim();
    if (required && !text) throw new ValidationError(`${label} is required`);
    if (text.length > max) throw new ValidationError(`${label} can be at most ${max} characters`);
    if (CONTROL.test(text)) throw new ValidationError(`${label} has invalid characters`);
    return text;
}

/**
 * The admin's address form, in the order's deliveryAddress shape. Every
 * field is sent (the form shows them all); the pin is `latitude`/`longitude`
 * (or `lat`/`lng`, or a GeoJSON `location`).
 */
export function cleanDeliveryAddress(body) {
    const raw = body && typeof body === 'object' ? body : {};
    const fullName = cleanText(raw.fullName ?? raw.name, 'Receiver name', ADDRESS_LIMITS.name, { required: true });
    const phone = cleanText(raw.phone, 'Contact number', ADDRESS_LIMITS.phone, { required: true });
    if (!/^\+?[\d\s()-]{6,20}$/.test(phone) || phone.replace(/\D/g, '').length < 6) {
        throw new ValidationError('Enter a valid contact number');
    }
    const street = cleanText(raw.street, 'Street / area', ADDRESS_LIMITS.street, { required: true });
    const additionalDetails = cleanText(raw.additionalDetails, 'House / floor / landmark', ADDRESS_LIMITS.additionalDetails);
    const city = cleanText(raw.city, 'City', ADDRESS_LIMITS.city, { required: true });
    const state = cleanText(raw.state, 'State', ADDRESS_LIMITS.state);
    const zipCode = cleanText(raw.zipCode, 'Zip code', ADDRESS_LIMITS.zipCode);
    if (zipCode && !/^[A-Za-z0-9 -]{3,12}$/.test(zipCode)) throw new ValidationError('Enter a valid zip code');
    const label = ADDRESS_LABELS.includes(String(raw.label)) ? String(raw.label) : null;
    if (raw.label != null && raw.label !== '' && !label) throw new ValidationError(`Label must be one of ${ADDRESS_LABELS.join(', ')}`);

    const coords = Array.isArray(raw.location?.coordinates) ? raw.location.coordinates : null;
    const lat = Number(raw.latitude ?? raw.lat ?? coords?.[1]);
    const lng = Number(raw.longitude ?? raw.lng ?? coords?.[0]);
    if ([raw.latitude ?? raw.lat ?? coords?.[1], raw.longitude ?? raw.lng ?? coords?.[0]].some((v) => v == null || v === '')
        || !Number.isFinite(lat) || !Number.isFinite(lng)) {
        throw new ValidationError('Place the pin on the map');
    }
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180 || (lat === 0 && lng === 0)) {
        throw new ValidationError('The map pin is not a valid location');
    }

    return {
        ...(label ? { label } : {}),
        name: fullName,
        fullName,
        phone,
        street,
        additionalDetails,
        city,
        state,
        zipCode,
        lat: Math.round(lat * 1e7) / 1e7,
        lng: Math.round(lng * 1e7) / 1e7,
    };
}

/** "Name, Phone, address line" changes, for the history note. */
export function describeAddressChange(before, after) {
    const line = (a) => [a.street, a.additionalDetails, a.city, a.state, a.zipCode].map((v) => String(v || '').trim()).filter(Boolean).join(', ');
    const parts = [];
    if (String(before.fullName || before.name || '') !== after.fullName) parts.push(`receiver "${before.fullName || before.name || ''}" → "${after.fullName}"`);
    if (String(before.phone || '') !== after.phone) parts.push(`contact ${before.phone || '—'} → ${after.phone}`);
    if (line(before) !== line(after)) parts.push(`address "${line(before)}" → "${line(after)}"`);
    const moved = Number(before.lat) !== after.lat || Number(before.lng) !== after.lng;
    if (moved) parts.push(`pin ${after.lat.toFixed(5)}, ${after.lng.toFixed(5)}`);
    return parts;
}

// ─── Note, delivery instructions, cutlery ───────────────────────────────────

export const NOTE_MAX = 500;

export function noteEditRefusal(order) {
    return closedRefusal(order);
}

/** { note?, deliveryInstructions? }: at least one, each trimmed text up to NOTE_MAX ("" clears it). */
export function cleanOrderNotes(body) {
    const raw = body && typeof body === 'object' ? body : {};
    const has = (k) => Object.prototype.hasOwnProperty.call(raw, k) && raw[k] !== undefined;
    if (!has('note') && !has('deliveryInstructions')) {
        throw new ValidationError('Send note and/or deliveryInstructions');
    }
    const clean = (value, label) => {
        if (value !== null && typeof value !== 'string') throw new ValidationError(`${label} must be text`);
        const text = String(value ?? '').trim();
        if (text.length > NOTE_MAX) throw new ValidationError(`${label} can be at most ${NOTE_MAX} characters`);
        if (CONTROL.test(text)) throw new ValidationError(`${label} has invalid characters`);
        return text;
    };
    return {
        ...(has('note') ? { note: clean(raw.note, 'Order note') } : {}),
        ...(has('deliveryInstructions') ? { deliveryInstructions: clean(raw.deliveryInstructions, 'Delivery instructions') } : {}),
    };
}

/** Cutlery goes in the bag, so it is settled once the rider has the bag. */
export function cutleryEditRefusal(order) {
    const closed = closedRefusal(order);
    if (closed) return closed;
    if (pickedUp(order)) return 'This order was already picked up, so its cutlery can no longer change.';
    return null;
}

export function cleanCutlery(value) {
    if (typeof value === 'boolean') return value;
    if (value === 'true' || value === 1 || value === '1') return true;
    if (value === 'false' || value === 0 || value === '0') return false;
    throw new ValidationError('sendCutlery must be true or false');
}

// ─── Scheduled time ─────────────────────────────────────────────────────────

/** Statuses a scheduled order can be moved in: waiting, placed, accepted early. */
export const RESCHEDULABLE_STATUSES = ['pending_payment', 'created', 'confirmed'];

/**
 * A scheduled order that has not started: still held for its release time
 * (the restaurant has not been alerted and no rider hunted for it) and not
 * being cooked.
 */
export function scheduleEditRefusal(order, now = new Date()) {
    const closed = closedRefusal(order);
    if (closed) return closed;
    const releaseAt = order.releaseAt ? new Date(order.releaseAt) : null;
    if (!releaseAt || Number.isNaN(releaseAt.getTime())) return 'This order was placed for now, not scheduled.';
    if (!RESCHEDULABLE_STATUSES.includes(statusOf(order)) || pickedUp(order)) {
        return 'The restaurant has already started on this order, so its time can no longer change.';
    }
    if (releaseAt.getTime() <= now.getTime()) {
        return 'This order was already released to the restaurant and riders, so its time can no longer change.';
    }
    if (order.dispatchDeliveryPartnerId) return 'A rider already has this order, so its time can no longer change.';
    return null;
}

export function cleanScheduledAt(value) {
    if (value == null || value === '') throw new ValidationError('scheduledAt is required');
    if (typeof value !== 'string' && typeof value !== 'number') throw new ValidationError('scheduledAt must be a date');
    const at = new Date(value);
    if (Number.isNaN(at.getTime())) throw new ValidationError('Invalid scheduled time');
    return at;
}

// ─── Payment status ─────────────────────────────────────────────────────────

/**
 * Marked "paid" by the admin before delivery (the customer paid the business
 * directly): stored as a verified offline payment so the rider is not asked
 * for the cash and it is not counted in their cash in hand.
 */
export const ADMIN_MARKED_PAID_METHOD_ID = 'admin_marked_paid';

export const isAdminMarkedPaid = (order) =>
    methodOf(order) === 'offline' && order?.offlinePayment?.methodId === ADMIN_MARKED_PAID_METHOD_ID;

/**
 * Why the order's payment cannot be switched to `paid` (true) or unpaid
 * (false), or null when it can.
 *
 * Only a cash order can be marked paid, and only before the rider has the
 * food: from then on the rider collects at the door, and delivery itself
 * records the cash as paid (and as the rider's cash in hand). Marking it paid
 * as well would count the money twice. A delivered cash order is paid by the
 * rider's collection and cannot be marked unpaid. An online, wallet or QR
 * payment is settled by its gateway; an offline payment is verified on its
 * own panel.
 */
export function paymentStatusRefusal(order, paid) {
    if (!order) return 'Order not found';
    const status = statusOf(order);
    const method = methodOf(order);
    const paymentStatus = paymentStatusOf(order);
    const refundStatus = String(order.payment?.refund?.status ?? order.refundStatus ?? 'none');

    if (CANCELLED.includes(status)) return 'This order was cancelled.';

    if (paid) {
        if (paymentStatus === 'paid' || paymentStatus === 'refunded') return 'This order is already paid.';
        if (method === 'offline') return 'Verify an offline payment on its Offline payment panel.';
        if (method !== 'cash') return 'Only a cash on delivery order can be marked as paid here; this payment is settled by its gateway.';
        if (walletPartOf(order) > 0) return 'Part of this order was paid from the wallet; the rest is collected at the door, so it cannot be marked paid here.';
        if (status === 'delivered') return 'This order was already delivered.';
        if (pickedUp(order)) {
            return 'The rider has the food and collects the cash at the door; delivery marks it paid. Marking it paid now would count the cash twice.';
        }
        if (refundStatus !== 'none') return 'A refund was started for this order.';
        return null;
    }

    if (paymentStatus !== 'paid') return 'This order is not paid.';
    if (status === 'delivered') {
        return method === 'cash'
            ? 'The rider collected the cash for this delivered order, so it cannot be marked unpaid.'
            : 'This order was already delivered.';
    }
    if (!isAdminMarkedPaid(order)) {
        return method === 'cash'
            ? 'This cash order was collected, so it cannot be marked unpaid.'
            : 'Only a cash order the admin marked as paid can be marked unpaid here.';
    }
    if (pickedUp(order)) return 'The rider already has this order, so its payment can no longer change.';
    if (refundStatus !== 'none') return 'A refund was started for this order.';
    return null;
}

export function cleanPaidFlag(body) {
    const raw = body && typeof body === 'object' ? body : {};
    const value = raw.paid ?? (raw.paymentStatus === 'paid' ? true : raw.paymentStatus === 'unpaid' ? false : undefined);
    if (typeof value !== 'boolean') throw new ValidationError('Send paid: true or false');
    return value;
}

// ─── Times in history notes ─────────────────────────────────────────────────

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "14 Oct 2026, 03:50 PM", India time. */
export function formatAdminTime(date, timeZone = 'Asia/Kolkata') {
    const d = date ? new Date(date) : null;
    if (!d || Number.isNaN(d.getTime())) return '';
    const p = Object.fromEntries(
        new Intl.DateTimeFormat('en-GB', {
            timeZone, year: 'numeric', month: 'numeric', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: true,
        }).formatToParts(d).map((part) => [part.type, part.value]),
    );
    const hour = String(Number(p.hour) || 12).padStart(2, '0');
    const ampm = String(p.dayPeriod || '').replace(/\./g, '').trim().toUpperCase() || 'AM';
    // Month names by hand: en-GB spells September "Sept".
    return `${p.day} ${MONTHS[Number(p.month) - 1]} ${p.year}, ${hour}:${p.minute} ${ampm}`;
}

// ─── Everything at once, for the details page ───────────────────────────────

const state = (reason) => ({ editable: !reason, reason });

/** What the Order Details page may offer, each with why not. */
export function orderInfoEditState(order, now = new Date()) {
    const markPaid = paymentStatusRefusal(order, true);
    const markUnpaid = paymentStatusRefusal(order, false);
    const method = methodOf(order);
    return {
        address: state(addressEditRefusal(order)),
        note: state(noteEditRefusal(order)),
        cutlery: state(cutleryEditRefusal(order)),
        schedule: state(scheduleEditRefusal(order, now)),
        payment: {
            // The switch shows for cash orders (and those the admin marked paid).
            applies: method === 'cash' || isAdminMarkedPaid(order),
            paid: paymentStatusOf(order) === 'paid',
            markedPaidByAdmin: isAdminMarkedPaid(order),
            canMarkPaid: !markPaid,
            canMarkUnpaid: !markUnpaid,
            reason: paymentStatusOf(order) === 'paid' ? markUnpaid : markPaid,
        },
    };
}
