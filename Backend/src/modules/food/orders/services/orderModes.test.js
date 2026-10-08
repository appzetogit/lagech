import test from 'node:test';
import assert from 'node:assert/strict';

import {
    resolveOrderType,
    takeawayPaymentRefusal,
    cleanRiderTip,
    MAX_RIDER_TIP,
    releaseAtFor,
    isHeldForSchedule,
    assertSchedulable,
    buildScheduleSlots,
    scheduleLeadMinutes,
    scheduleReleaseMinutes,
} from './orderModes.js';

const MIN = 60 * 1000;
const OFF = { homeDelivery: true, takeaway: false, scheduledOrder: false };
const ON = { homeDelivery: true, takeaway: true, scheduledOrder: true };

// ─── Order type ──────────────────────────────────────────────────────────────

test('nothing sent is a home delivery, as before takeaway existed', () => {
    assert.equal(resolveOrderType(undefined, { orderRules: OFF }), 'delivery');
    assert.equal(resolveOrderType('', { orderRules: OFF }), 'delivery');
    assert.equal(resolveOrderType('delivery', { orderRules: OFF }), 'delivery');
});

test('takeaway needs the setting on and the restaurant offering it', () => {
    assert.throws(() => resolveOrderType('takeaway', { orderRules: OFF }), /Takeaway is not available/);
    assert.equal(resolveOrderType('takeaway', { orderRules: ON }), 'takeaway');
    assert.equal(resolveOrderType('TAKEAWAY', { orderRules: ON, restaurant: { takeawayEnabled: true } }), 'takeaway');
    assert.throws(
        () => resolveOrderType('takeaway', { orderRules: ON, restaurant: { takeawayEnabled: false, restaurantName: 'Spice' } }),
        /Spice does not offer takeaway/,
    );
    assert.throws(() => resolveOrderType('dine-in', { orderRules: ON }), /delivery or takeaway/);
});

test('home delivery off leaves takeaway only', () => {
    const rules = { homeDelivery: false, takeaway: true };
    assert.throws(() => resolveOrderType('delivery', { orderRules: rules }), /Home delivery is not available/);
    assert.equal(resolveOrderType('takeaway', { orderRules: rules }), 'takeaway');
});

test('a takeaway is paid in the app, never collected at a door', () => {
    for (const ok of ['razorpay', 'card', 'wallet', 'offline']) assert.equal(takeawayPaymentRefusal(ok), null, ok);
    for (const no of ['cash', 'razorpay_qr']) assert.match(takeawayPaymentRefusal(no), /paid in the app/, no);
});

// ─── Tips ────────────────────────────────────────────────────────────────────

test('no tip sent is no tip, whatever the switch', () => {
    assert.equal(cleanRiderTip(undefined), 0);
    assert.equal(cleanRiderTip(null, { tipsEnabled: true }), 0);
    assert.equal(cleanRiderTip(0), 0, 'an explicit 0 is fine with tips off');
});

test('a tip is refused while tips are off, on a takeaway, and above the cap', () => {
    assert.throws(() => cleanRiderTip(20), /Tips are not available/);
    assert.throws(() => cleanRiderTip(20, { tipsEnabled: true, orderType: 'takeaway' }), /no delivery partner/);
    assert.throws(() => cleanRiderTip(MAX_RIDER_TIP + 1, { tipsEnabled: true }), /at most ₹500/);
    assert.throws(() => cleanRiderTip(-5, { tipsEnabled: true }), /valid tip/);
    assert.throws(() => cleanRiderTip('abc', { tipsEnabled: true }), /valid tip/);
});

test('a tip within the cap is kept to the paisa', () => {
    assert.equal(cleanRiderTip(30, { tipsEnabled: true }), 30);
    assert.equal(cleanRiderTip('25.555', { tipsEnabled: true }), 25.56);
    assert.equal(cleanRiderTip(MAX_RIDER_TIP, { tipsEnabled: true }), MAX_RIDER_TIP);
});

// ─── Scheduling ──────────────────────────────────────────────────────────────

// 2026-10-06 06:30 UTC = 12:00 noon in India.
const NOON = new Date('2026-10-06T06:30:00.000Z');

test('an order for now is never held', () => {
    assert.equal(releaseAtFor(null, NOON), null);
    assert.equal(releaseAtFor(new Date(NOON.getTime() + 2 * MIN), NOON), null, 'clock skew is still now');
    assert.equal(isHeldForSchedule({ releaseAt: null }, NOON), false);
});

test('a scheduled order is released shortly before its time, never in the past', () => {
    const at = new Date(NOON.getTime() + 3 * 60 * MIN);
    const release = releaseAtFor(at, NOON);
    assert.equal(at.getTime() - release.getTime(), scheduleReleaseMinutes() * MIN);
    assert.equal(isHeldForSchedule({ releaseAt: release }, NOON), true);
    assert.equal(isHeldForSchedule({ releaseAt: release }, new Date(release.getTime() + 1)), false);

    const soon = new Date(NOON.getTime() + 20 * MIN);
    assert.equal(releaseAtFor(soon, NOON).getTime(), NOON.getTime(), 'sooner than the release lead: released at once');
});

test('a scheduled time must respect the lead time and stay within tomorrow', () => {
    assert.throws(() => assertSchedulable(new Date(NOON.getTime() + 15 * MIN), { now: NOON }), /at least/);
    assert.ok(assertSchedulable(new Date(NOON.getTime() + scheduleLeadMinutes() * MIN), { now: NOON }));
    // 23:30 tomorrow (India) is fine, 00:30 the day after is not.
    assert.ok(assertSchedulable(new Date('2026-10-07T18:00:00.000Z'), { now: NOON }));
    assert.throws(() => assertSchedulable(new Date('2026-10-07T19:00:00.000Z'), { now: NOON }), /today or tomorrow/);
    assert.throws(() => assertSchedulable('not a date', { now: NOON }), /Invalid scheduled time/);
});

test('a scheduled time when the restaurant is closed is refused', () => {
    const restaurant = { restaurantName: 'Dosa Hut', openingTime: '10:00', closingTime: '22:00' };
    // 23:00 India today: closed.
    assert.throws(() => assertSchedulable(new Date('2026-10-06T17:30:00.000Z'), { restaurant, now: NOON }), /Dosa Hut is closed/);
    // 19:00 India: open.
    assert.ok(assertSchedulable(new Date('2026-10-06T13:30:00.000Z'), { restaurant, now: NOON }));
});

test('slots: today and tomorrow, on the interval, from the lead time, inside opening hours', () => {
    const restaurant = { openingTime: '10:00', closingTime: '22:00' };
    const days = buildScheduleSlots(restaurant, { slotMinutes: 30, now: NOON });
    assert.deepEqual(days.map((d) => d.label), ['Today', 'Tomorrow']);
    assert.equal(days[0].date, '2026-10-06');
    assert.equal(days[1].date, '2026-10-07');

    const all = days.flatMap((d) => d.slots.map((s) => new Date(s.scheduledAt)));
    assert.ok(all.length > 0);
    for (const at of all) {
        assert.ok(at.getTime() >= NOON.getTime() + scheduleLeadMinutes() * MIN, 'not before the lead time');
        // On the 30-minute grid of the local day (India is UTC+5:30, so :00/:30 local is :00/:30 UTC too).
        assert.equal(at.getUTCMinutes() % 30, 0);
        // Inside 10:00-22:00 India = 04:30-16:30 UTC.
        const utcMinutes = at.getUTCHours() * 60 + at.getUTCMinutes();
        assert.ok(utcMinutes >= 4 * 60 + 30 && utcMinutes <= 16 * 60, at.toISOString());
    }
    // Today starts at 13:00 India (noon + 45 min lead, rounded up to the grid).
    assert.equal(days[0].slots[0].scheduledAt, '2026-10-06T07:30:00.000Z');
    assert.match(days[0].slots[0].label, /1:00\s?pm - 1:30\s?pm/i);
    // Tomorrow opens at 10:00 India and the last slot ends at closing (21:30-22:00).
    assert.equal(days[1].slots[0].scheduledAt, '2026-10-07T04:30:00.000Z');
    assert.equal(days[1].slots.at(-1).scheduledAt, '2026-10-07T16:00:00.000Z');
    assert.equal(days[1].slots.length, 24, '10:00 to 22:00 in half hours');
});

test('slots follow the admin interval and a restaurant with no hours is open all day', () => {
    const days = buildScheduleSlots(null, { slotMinutes: 60, now: NOON });
    assert.equal(days[1].slots.length, 24, 'every hour tomorrow');
    for (const d of days) {
        for (const s of d.slots) assert.equal(new Date(s.scheduledAt).getUTCMinutes(), 30, 'hour boundaries in India are :30 UTC');
    }
});
