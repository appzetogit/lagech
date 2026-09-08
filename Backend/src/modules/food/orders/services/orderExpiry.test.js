import test from 'node:test';
import assert from 'node:assert/strict';

import { buildDeadHuntFilter, buildStallFilters, expiryWindows } from './order-expiry.service.js';

/**
 * What the expiry watchdog is allowed to cancel.
 *
 * These filters decide whether somebody's live order is written off, so the
 * shape of them is worth pinning down: the failure is silent and it happens to
 * a real customer.
 */

const NOW = new Date('2026-09-08T12:00:00.000Z');
/** The moment an order has to predate to be considered expired. */
const cutoffOf = (group) => {
    const [byCreation, bySchedule] = group.where.OR;
    assert.deepEqual(byCreation.createdAt.lt, bySchedule.scheduledAt.lt);
    return bySchedule.scheduledAt.lt;
};

const groups = (env = {}) => {
    const saved = { ...process.env };
    Object.assign(process.env, env);
    try {
        return Object.fromEntries(
            buildStallFilters(NOW, expiryWindows()).map((g) => [g.reason, g]),
        );
    } finally {
        process.env = saved;
    }
};

test('an order a rider is already carrying is never a candidate', () => {
    const statuses = groups()['no-rider-found'].where.orderStatus.in;
    for (const carried of ['picked_up', 'reached_drop', 'delivered']) {
        assert.ok(!statuses.includes(carried), `${carried} must not be expirable`);
    }
});

test('a trip a rider accepted is never a candidate', () => {
    // Without this the watchdog would cancel orders out from under a rider who
    // is on their way to the restaurant.
    assert.equal(groups()['no-rider-found'].where.dispatchAcceptedAt, null);
});

test('terminal statuses are not in either group', () => {
    const all = Object.values(groups()).flatMap((g) => g.where.orderStatus.in);
    for (const done of ['delivered', 'cancelled_by_user', 'cancelled_by_restaurant', 'cancelled_by_admin']) {
        assert.ok(!all.includes(done), `${done} must not be expirable`);
    }
});

test('the two groups do not overlap', () => {
    // An order matching both would be cancelled once and then fail the second
    // time, which would show up as an error rather than as nothing happening.
    const [a, b] = buildStallFilters(NOW).map((g) => new Set(g.where.orderStatus.in));
    for (const status of a) assert.ok(!b.has(status), `${status} is in both groups`);
});

test('age is measured from the order, not from the last touch', () => {
    // The watchdog restarts dead hunts, and a hunt writes to the row. Measured
    // on `updatedAt`, an order being retried would keep resetting its own clock
    // and could never expire.
    for (const group of buildStallFilters(NOW)) {
        assert.ok(!('updatedAt' in group.where), group.reason);
        assert.ok(cutoffOf(group) instanceof Date);
    }
});

test('a scheduled order is not late until the time it was scheduled for', () => {
    // An order placed at noon for 7pm must not be expired at half past twelve.
    for (const group of buildStallFilters(NOW)) {
        const [byCreation, bySchedule] = group.where.OR;
        // Placing time only counts when the customer picked no time.
        assert.equal(byCreation.scheduledAt, null);
        assert.ok(bySchedule.scheduledAt.lt instanceof Date);
        assert.ok(!('createdAt' in bySchedule));
    }
});

test('the restaurant is given less time than dispatch', () => {
    // Nothing has been cooked yet, so cancelling is cheap; once the kitchen has
    // started, the order deserves a longer run before it is given up on.
    const g = groups();
    assert.ok(cutoffOf(g['restaurant-never-responded']) > cutoffOf(g['no-rider-found']));
});

test('the windows come out of the environment', () => {
    const g = groups({ ORDER_ACCEPT_EXPIRY_MINUTES: '10', ORDER_DISPATCH_EXPIRY_MINUTES: '90' });
    assert.equal(cutoffOf(g['restaurant-never-responded']).toISOString(), '2026-09-08T11:50:00.000Z');
    assert.equal(cutoffOf(g['no-rider-found']).toISOString(), '2026-09-08T10:30:00.000Z');
});

test('a nonsense window falls back rather than expiring everything', () => {
    // `0` or a typo must not become "cancel every open order", which is what a
    // plain Number() with no guard would produce.
    for (const bad of ['0', '-5', 'soon', '']) {
        const saved = process.env.ORDER_ACCEPT_EXPIRY_MINUTES;
        process.env.ORDER_ACCEPT_EXPIRY_MINUTES = bad;
        try {
            assert.equal(expiryWindows().awaitingRestaurantMinutes, 30, `for ${JSON.stringify(bad)}`);
        } finally {
            if (saved === undefined) delete process.env.ORDER_ACCEPT_EXPIRY_MINUTES;
            else process.env.ORDER_ACCEPT_EXPIRY_MINUTES = saved;
        }
    }
});

test('every group carries a reason the customer can read', () => {
    for (const group of buildStallFilters(NOW)) {
        assert.ok(group.note.length > 20, group.reason);
        // The note is used verbatim as the push body, so it must not leak the
        // internal slug.
        assert.ok(!group.note.includes('-'), group.note);
    }
});

/**
 * What the watchdog is allowed to start hunting for again.
 *
 * Restarting a hunt wakes every nearby rider with a push, so the cost of a
 * wrong match here is a burst of notifications for a trip that is not real.
 */

const HUNT_DEAD_MS = 3 * 60 * 1000;
const hunt = (now = NOW) => buildDeadHuntFilter(now, expiryWindows(), HUNT_DEAD_MS);

test('only an order with no rider at all is hunted again', () => {
    const w = hunt();
    assert.equal(w.dispatchStatus, 'unassigned');
    assert.equal(w.dispatchAcceptedAt, null);
    // Both halves of the record, so a partial assignment cannot slip through.
    assert.equal(w.dispatchDeliveryPartnerId, null);
});

test('an order mid-round is left alone', () => {
    // `dispatchingAt` is the in-flight lock. Picking one up here would run two
    // rounds against the same order at once.
    assert.equal(hunt().dispatchingAt, null);
});

test('a hunt is only dead after several rounds of silence', () => {
    // A round is 45s and touches the row. Anything shorter than a couple of
    // rounds would restart hunts that are merely slow.
    const quietSince = hunt().updatedAt.lt;
    assert.equal(NOW.getTime() - quietSince.getTime(), HUNT_DEAD_MS);
    assert.ok(HUNT_DEAD_MS > 3 * 45 * 1000);
});

test('resuming stops exactly where expiring starts', () => {
    // The two must meet: a gap would leave orders that are neither retried nor
    // closed, an overlap would wake riders for an order about to be cancelled.
    const resumeFloor = hunt().OR[1].scheduledAt.gte;
    const expireCeiling = cutoffOf(groups()['no-rider-found']);
    assert.deepEqual(resumeFloor, expireCeiling);
});

test('an order is never both resumed and expired', () => {
    const resumeFloor = hunt().OR[1].scheduledAt.gte;
    const expireCeiling = cutoffOf(groups()['no-rider-found']);
    // Resume wants scheduledAt >= floor, expiry wants scheduledAt < ceiling.
    // Equal bounds make the two sets disjoint and complete.
    const anOrderAt = (iso) => {
        const at = new Date(iso);
        return { resumed: at >= resumeFloor, expired: at < expireCeiling };
    };
    for (const iso of ['2026-09-08T11:59:00.000Z', '2026-09-08T10:00:00.000Z', '2026-09-04T07:54:56.938Z']) {
        const { resumed, expired } = anOrderAt(iso);
        assert.notEqual(resumed, expired, iso);
    }
});

test('a scheduled hunt is judged on its scheduled time', () => {
    const [byCreation, bySchedule] = hunt().OR;
    assert.equal(byCreation.scheduledAt, null);
    assert.ok(bySchedule.scheduledAt.gte instanceof Date);
});

test('only orders the restaurant has taken on are hunted', () => {
    const statuses = hunt().orderStatus.in;
    assert.ok(!statuses.includes('created'), 'nothing to dispatch before the restaurant accepts');
    for (const carried of ['picked_up', 'reached_drop', 'delivered']) {
        assert.ok(!statuses.includes(carried), carried);
    }
});
