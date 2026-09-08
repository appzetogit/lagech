import test from 'node:test';
import assert from 'node:assert/strict';

import { buildStallFilters, expiryWindows } from './order-expiry.service.js';

/**
 * What the expiry watchdog is allowed to cancel.
 *
 * These filters decide whether somebody's live order is written off, so the
 * shape of them is worth pinning down: the failure is silent and it happens to
 * a real customer.
 */

const NOW = new Date('2026-09-08T12:00:00.000Z');
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

test('staleness is measured on last movement, not on when the order was placed', () => {
    // A dispatch round still running touches the row, so a long hunt that is
    // alive keeps resetting the clock and never expires.
    for (const group of buildStallFilters(NOW)) {
        assert.ok(group.where.updatedAt?.lt instanceof Date);
        assert.ok(!('createdAt' in group.where));
    }
});

test('the restaurant is given less time than dispatch', () => {
    // Nothing has been cooked yet, so cancelling is cheap; once the kitchen has
    // started, the order deserves a longer run before it is given up on.
    const g = groups();
    assert.ok(
        g['restaurant-never-responded'].where.updatedAt.lt >
            g['no-rider-found'].where.updatedAt.lt,
    );
});

test('the windows come out of the environment', () => {
    const g = groups({ ORDER_ACCEPT_EXPIRY_MINUTES: '10', ORDER_DISPATCH_EXPIRY_MINUTES: '90' });
    assert.equal(
        g['restaurant-never-responded'].where.updatedAt.lt.toISOString(),
        '2026-09-08T11:50:00.000Z',
    );
    assert.equal(
        g['no-rider-found'].where.updatedAt.lt.toISOString(),
        '2026-09-08T10:30:00.000Z',
    );
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
