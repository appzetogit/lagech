import test from 'node:test';
import assert from 'node:assert/strict';

import {
    ADMIN_MARKED_PAID_METHOD_ID,
    addressEditRefusal,
    cleanCutlery,
    cleanDeliveryAddress,
    cleanOrderNotes,
    cleanPaidFlag,
    cleanScheduledAt,
    cutleryEditRefusal,
    describeAddressChange,
    formatAdminTime,
    noteEditRefusal,
    NOTE_MAX,
    orderInfoEditState,
    paymentStatusRefusal,
    scheduleEditRefusal,
} from './orderInfoEditRules.js';

const cod = (over = {}) => ({
    orderStatus: 'confirmed', orderType: 'delivery', paymentMethod: 'cash', paymentStatus: 'cod_pending', walletAmount: 0, ...over,
});
const markedPaid = (over = {}) => cod({
    paymentMethod: 'offline', paymentStatus: 'paid', offlinePayment: { methodId: ADMIN_MARKED_PAID_METHOD_ID, status: 'verified' }, ...over,
});
const CANCELLED = ['cancelled_by_user', 'cancelled_by_restaurant', 'cancelled_by_admin'];

const form = (over = {}) => ({
    fullName: '  Asha  Rao ', phone: '98765 43210', street: '12 MG Road', additionalDetails: 'Flat 4, 2nd floor, near temple',
    city: 'Indore', state: 'MP', zipCode: '452001', latitude: 22.72, longitude: 75.86, ...over,
});

test('address: editable until delivered or cancelled, never for a takeaway', () => {
    for (const orderStatus of ['pending_payment', 'created', 'confirmed', 'preparing', 'ready_for_pickup', 'picked_up', 'reached_drop']) {
        assert.equal(addressEditRefusal(cod({ orderStatus })), null, orderStatus);
    }
    assert.match(addressEditRefusal(cod({ orderStatus: 'delivered' })), /delivered/);
    for (const s of CANCELLED) assert.match(addressEditRefusal(cod({ orderStatus: s })), /cancelled/);
    assert.match(addressEditRefusal(cod({ orderType: 'takeaway' })), /takeaway/);
    assert.equal(addressEditRefusal(null), 'Order not found');
});

test('address: the form is cleaned into the order address shape', () => {
    const a = cleanDeliveryAddress(form({ label: 'Office' }));
    assert.equal(a.fullName, 'Asha Rao');
    assert.equal(a.name, 'Asha Rao');
    assert.equal(a.phone, '98765 43210');
    assert.equal(a.additionalDetails, 'Flat 4, 2nd floor, near temple');
    assert.equal(a.label, 'Office');
    assert.equal(a.lat, 22.72);
    assert.equal(a.lng, 75.86);
    // GeoJSON and lat/lng are read too.
    assert.equal(cleanDeliveryAddress(form({ latitude: undefined, longitude: undefined, location: { coordinates: [75.1, 22.1] } })).lng, 75.1);
    assert.equal(cleanDeliveryAddress(form({ latitude: undefined, longitude: undefined, lat: '22.5', lng: '75.5' })).lat, 22.5);
    assert.equal(cleanDeliveryAddress(form({ additionalDetails: undefined, state: undefined, zipCode: '' })).additionalDetails, '');

    assert.throws(() => cleanDeliveryAddress(form({ fullName: ' ' })), /Receiver name is required/);
    assert.throws(() => cleanDeliveryAddress(form({ phone: 'call me' })), /valid contact/);
    assert.throws(() => cleanDeliveryAddress(form({ phone: '' })), /Contact number is required/);
    assert.throws(() => cleanDeliveryAddress(form({ street: '' })), /Street/);
    assert.throws(() => cleanDeliveryAddress(form({ city: '' })), /City/);
    assert.throws(() => cleanDeliveryAddress(form({ street: 'x'.repeat(301) })), /at most 300/);
    assert.throws(() => cleanDeliveryAddress(form({ zipCode: '45#001' })), /zip/);
    assert.throws(() => cleanDeliveryAddress(form({ label: 'Castle' })), /Label/);
    assert.throws(() => cleanDeliveryAddress(form({ street: { $ne: 1 } })), /must be text/);
    assert.throws(() => cleanDeliveryAddress(form({ latitude: undefined })), /pin/);
    assert.throws(() => cleanDeliveryAddress(form({ latitude: 'abc' })), /pin/);
    assert.throws(() => cleanDeliveryAddress(form({ latitude: 91 })), /not a valid location/);
    assert.throws(() => cleanDeliveryAddress(form({ latitude: 0, longitude: 0 })), /not a valid location/);
    assert.throws(() => cleanDeliveryAddress(null), /Receiver name/);
});

test('address: the history note names what changed', () => {
    const before = { fullName: 'Asha Rao', phone: '98765 43210', street: '1 Old Road', city: 'Indore', lat: 22.7, lng: 75.8 };
    const parts = describeAddressChange(before, cleanDeliveryAddress(form()));
    assert.equal(parts.length, 2, JSON.stringify(parts));
    assert.match(parts[0], /address "1 Old Road, Indore" → "12 MG Road, Flat 4/);
    assert.match(parts[1], /pin 22\.72000, 75\.86000/);
    const same = cleanDeliveryAddress(form());
    assert.deepEqual(describeAddressChange({ ...same }, same), []);
});

test('note and delivery instructions: until delivered or cancelled; either or both; "" clears', () => {
    assert.equal(noteEditRefusal(cod({ orderStatus: 'picked_up' })), null);
    assert.match(noteEditRefusal(cod({ orderStatus: 'delivered' })), /delivered/);
    assert.deepEqual(cleanOrderNotes({ note: '  less spicy ' }), { note: 'less spicy' });
    assert.deepEqual(cleanOrderNotes({ deliveryInstructions: '' }), { deliveryInstructions: '' });
    assert.deepEqual(cleanOrderNotes({ note: 'a', deliveryInstructions: 'b' }), { note: 'a', deliveryInstructions: 'b' });
    assert.throws(() => cleanOrderNotes({}), /Send note/);
    assert.throws(() => cleanOrderNotes({ note: 5 }), /must be text/);
    assert.throws(() => cleanOrderNotes({ note: 'x'.repeat(NOTE_MAX + 1) }), /at most/);
});

test('cutlery: until the rider has the bag', () => {
    assert.equal(cutleryEditRefusal(cod({ orderStatus: 'ready_for_pickup' })), null);
    assert.match(cutleryEditRefusal(cod({ orderStatus: 'picked_up' })), /picked up/);
    assert.match(cutleryEditRefusal(cod({ orderStatus: 'ready_for_pickup', pickedUpAt: new Date() })), /picked up/);
    assert.match(cutleryEditRefusal(cod({ orderStatus: 'delivered' })), /delivered/);
    assert.equal(cleanCutlery(false), false);
    assert.equal(cleanCutlery('true'), true);
    assert.throws(() => cleanCutlery('maybe'), /true or false/);
    assert.throws(() => cleanCutlery(undefined), /true or false/);
});

test('schedule: only a scheduled order still held for its release time', () => {
    const now = new Date('2026-10-14T10:00:00Z');
    const later = new Date('2026-10-14T14:00:00Z');
    const sched = (over = {}) => cod({ orderStatus: 'created', releaseAt: later, scheduledAt: later, ...over });
    assert.equal(scheduleEditRefusal(sched(), now), null);
    assert.equal(scheduleEditRefusal(sched({ orderStatus: 'confirmed' }), now), null, 'accepted early');
    assert.equal(scheduleEditRefusal(sched({ orderStatus: 'pending_payment' }), now), null, 'offline payment awaiting');
    assert.match(scheduleEditRefusal(sched({ releaseAt: null }), now), /placed for now/);
    assert.match(scheduleEditRefusal(sched({ orderStatus: 'preparing' }), now), /started/);
    assert.match(scheduleEditRefusal(sched({ releaseAt: new Date('2026-10-14T09:59:00Z') }), now), /released/);
    assert.match(scheduleEditRefusal(sched({ dispatchDeliveryPartnerId: 'r1' }), now), /rider/);
    assert.match(scheduleEditRefusal(sched({ orderStatus: 'cancelled_by_admin' }), now), /cancelled/);
    assert.equal(cleanScheduledAt('2026-10-14T15:00:00Z').toISOString(), '2026-10-14T15:00:00.000Z');
    assert.throws(() => cleanScheduledAt(''), /required/);
    assert.throws(() => cleanScheduledAt('soon'), /Invalid/);
    assert.throws(() => cleanScheduledAt({}), /must be a date/);
});

test('payment: a cash order is marked paid only before the rider has the food', () => {
    for (const orderStatus of ['created', 'confirmed', 'preparing', 'ready_for_pickup']) {
        assert.equal(paymentStatusRefusal(cod({ orderStatus }), true), null, orderStatus);
    }
    assert.match(paymentStatusRefusal(cod({ orderStatus: 'picked_up' }), true), /twice/);
    assert.match(paymentStatusRefusal(cod({ orderStatus: 'reached_drop' }), true), /twice/);
    assert.match(paymentStatusRefusal(cod({ pickedUpAt: new Date() }), true), /twice/);
    assert.match(paymentStatusRefusal(cod({ orderStatus: 'delivered', paymentStatus: 'paid' }), true), /already paid/);
    assert.match(paymentStatusRefusal(cod({ orderStatus: 'cancelled_by_user' }), true), /cancelled/);
    assert.match(paymentStatusRefusal(cod({ walletAmount: 50 }), true), /wallet/);
    assert.match(paymentStatusRefusal(cod({ paymentMethod: 'razorpay', paymentStatus: 'created' }), true), /gateway/);
    assert.match(paymentStatusRefusal(cod({ paymentMethod: 'razorpay_qr' }), true), /gateway/);
    assert.match(paymentStatusRefusal(cod({ paymentMethod: 'wallet', paymentStatus: 'paid' }), true), /already paid/);
    assert.match(paymentStatusRefusal(cod({ paymentMethod: 'offline', paymentStatus: 'created', orderStatus: 'pending_payment' }), true), /Offline payment panel/);
});

test('payment: only the admin\'s own "paid" is undone, and not once the rider has it', () => {
    assert.equal(paymentStatusRefusal(markedPaid(), false), null);
    assert.match(paymentStatusRefusal(markedPaid({ orderStatus: 'picked_up' }), false), /rider already has/);
    assert.match(paymentStatusRefusal(markedPaid({ orderStatus: 'delivered' }), false), /delivered/);
    assert.match(paymentStatusRefusal(cod({ orderStatus: 'delivered', paymentStatus: 'paid' }), false), /rider collected/);
    assert.match(paymentStatusRefusal(cod(), false), /not paid/);
    assert.match(paymentStatusRefusal(cod({ paymentMethod: 'razorpay', paymentStatus: 'paid' }), false), /Only a cash order the admin marked/);
    assert.match(paymentStatusRefusal(cod({ paymentMethod: 'offline', paymentStatus: 'paid', offlinePayment: { methodId: 'bank' } }), false), /Only a cash order/);
    assert.equal(cleanPaidFlag({ paid: true }), true);
    assert.equal(cleanPaidFlag({ paymentStatus: 'unpaid' }), false);
    assert.throws(() => cleanPaidFlag({ paid: 'yes' }), /paid: true or false/);
});

test('history times read "14 Oct 2026, 03:50 PM" in India time', () => {
    assert.equal(formatAdminTime(new Date('2026-10-14T10:20:00Z')), '14 Oct 2026, 03:50 PM');
    assert.equal(formatAdminTime(new Date('2026-09-03T18:35:00Z')), '04 Sep 2026, 12:05 AM');
    assert.equal(formatAdminTime(null), '');
    assert.equal(formatAdminTime('nope'), '');
});

test('details state: one object for the page', () => {
    const s = orderInfoEditState(cod());
    assert.equal(s.address.editable, true);
    assert.equal(s.note.editable, true);
    assert.equal(s.cutlery.editable, true);
    assert.equal(s.schedule.editable, false);
    assert.match(s.schedule.reason, /placed for now/);
    assert.deepEqual(s.payment, { applies: true, paid: false, markedPaidByAdmin: false, canMarkPaid: true, canMarkUnpaid: false, reason: null });

    const p = orderInfoEditState(markedPaid()).payment;
    assert.equal(p.applies, true);
    assert.equal(p.paid, true);
    assert.equal(p.markedPaidByAdmin, true);
    assert.equal(p.canMarkUnpaid, true);

    const online = orderInfoEditState(cod({ paymentMethod: 'razorpay', paymentStatus: 'paid' })).payment;
    assert.equal(online.applies, false, 'no switch for an online payment');
    const delivered = orderInfoEditState(cod({ orderStatus: 'delivered', paymentStatus: 'paid' }));
    assert.equal(delivered.address.editable, false);
    assert.equal(delivered.payment.canMarkUnpaid, false);
    assert.match(delivered.payment.reason, /rider collected/);
});
