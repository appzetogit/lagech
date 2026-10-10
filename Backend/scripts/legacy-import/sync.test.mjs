import test from 'node:test';
import assert from 'node:assert/strict';
import { Prisma } from '@prisma/client';

import { prisma } from '../../src/config/prisma.js';
import {
    NOT_IN_BASELINE, classifyProtected, comparable, fillBlanks, guardedUpdate, legacyChangedPatch, same,
} from './sync.mjs';
import { planUserSync } from './steps/customers.mjs';
import { planRiderSync } from './steps/deliveryPartners.mjs';
import { planOrderSync } from './steps/orders.mjs';

/**
 * The sync's merge rules, on plain objects shaped like the rows involved.
 * No database is touched; the import modules only need the client to load.
 */
test.after(() => prisma.$disconnect());

test('values compare by meaning: decimals, numeric strings, dates, null and blank', () => {
    assert.ok(same(new Prisma.Decimal('10.50'), '10.50'));
    assert.ok(same(new Prisma.Decimal('10'), 10));
    assert.ok(same('10.00', 10));
    assert.ok(!same('0123', 123), 'a leading zero is text, not a number');
    assert.ok(same(new Date('2026-10-01T00:00:00Z'), new Date('2026-10-01T00:00:00Z')));
    assert.ok(same(null, ''));
    assert.ok(same(undefined, null));
    assert.ok(same({ b: 1, a: { d: 2, c: 3 } }, { a: { c: 3, d: 2 }, b: 1 }), 'key order is not a change');
    assert.ok(!same({ a: 1 }, { a: 2 }));
    assert.notEqual(comparable(true), comparable('true'));
});

test('fill blanks: only empty fields are filled; a value set here is kept and named', () => {
    const { patch, kept } = fillBlanks(
        { name: 'Asha (set here)', email: '', profileImage: null },
        { name: 'Asha Old', email: 'asha@example.com', profileImage: '' },
        ['name', 'email', 'profileImage'],
    );
    assert.deepEqual(patch, { email: 'asha@example.com' });
    assert.deepEqual(kept, ['name']);
});

test('a status follows the old system only while this system still has the imported value', () => {
    // Imported active, still active here, blocked in the old system: blocked.
    assert.deepEqual(
        guardedUpdate({ isActive: true }, { isActive: true }, { isActive: false }, ['isActive']).patch,
        { isActive: false },
    );
    // Imported active, an admin here blocked them, the old system still has
    // them active: stays blocked, and nothing is reported as a conflict.
    const blockedHere = guardedUpdate({ isActive: false }, { isActive: true }, { isActive: true }, ['isActive']);
    assert.deepEqual(blockedHere.patch, {});
    assert.equal(blockedHere.protected, true);
    // Already what the old system says: nothing to do.
    assert.deepEqual(guardedUpdate({ isActive: false }, { isActive: true }, { isActive: false }, ['isActive']),
        { patch: {}, protected: false });
    // No baseline row to say what was imported: never overwritten.
    assert.equal(guardedUpdate({ isActive: true }, null, { isActive: false }, ['isActive']).protected, true);
});

test('orders: only fields the old system changed are written, conflicts are named', () => {
    const original = { orderStatus: 'cancelled_by_admin', note: 'x', riderEarning: 0 };
    const target = { orderStatus: 'delivered', note: 'x', riderEarning: 45 };
    const current = { orderStatus: 'cancelled_by_admin', note: 'edited here', riderEarning: new Prisma.Decimal(0) };
    const { patch, legacyChanged, conflicts } = legacyChangedPatch(current, original, target, ['orderStatus', 'note', 'riderEarning']);
    assert.deepEqual(patch, { orderStatus: 'delivered', riderEarning: 45 });
    assert.deepEqual(legacyChanged, ['orderStatus', 'riderEarning']);
    assert.deepEqual(conflicts, [], 'note was edited here but the old system did not change it: kept, no conflict');

    const both = legacyChangedPatch({ orderStatus: 'refunded' }, original, target, ['orderStatus']);
    assert.deepEqual(both.patch, { orderStatus: 'delivered' });
    assert.deepEqual(both.conflicts, ['orderStatus']);
});

test('protected rows: unchanged, or changed in the old system and named by column', () => {
    assert.deepEqual(classifyProtected({ name: 'A', price: '10.00' }, { name: 'A', price: 10 }, ['name', 'price']),
        { outcome: 'unchanged', columns: [] });
    assert.deepEqual(classifyProtected({ name: 'A', price: '10.00' }, { name: 'B', price: '12.00' }, ['name', 'price']),
        { outcome: 'protected', columns: ['name', 'price'] });
    // Imported by an earlier sync from a newer copy: nothing to compare, left as it is.
    assert.deepEqual(classifyProtected(undefined, { name: 'A' }, ['name']), { outcome: 'unchanged', columns: [NOT_IN_BASELINE] });
});

test('customers: blanks filled, own details kept, blocked here stays blocked', () => {
    const original = { name: 'Ravi', email: null, profileImage: '', isActive: true, isVerified: true };
    const target = { name: 'Ravi K', email: 'ravi@example.com', profileImage: '/uploads/legacy/profile/r.png', isActive: false, isVerified: true };

    const untouched = planUserSync({ ...original, name: 'Ravi' }, original, target);
    assert.deepEqual(untouched.patch, { email: 'ravi@example.com', profileImage: '/uploads/legacy/profile/r.png', isActive: false });
    assert.deepEqual(untouched.kept, ['name'], 'the name is set here, so the old rename is not taken');

    // Blocked here; the old system still has them active.
    const editedHere = planUserSync({ name: 'Ravi Kumar', email: 'own@example.com', profileImage: '/x.png', isActive: false, isVerified: true },
        original, { ...target, isActive: true });
    assert.deepEqual(editedHere.patch, {});
    assert.deepEqual(editedHere.kept.sort(), ['email', 'isActive', 'name', 'profileImage']);
});

test('riders: approval follows the old system only while untouched here, with its dates', () => {
    const original = { status: 'approved', approvedAt: new Date('2025-01-01'), email: null, profilePhoto: null };
    const target = { status: 'deactivated', approvedAt: new Date('2025-01-01'), rejectionReason: 'Suspended by admin', email: 'r@example.com', profilePhoto: null };

    const follows = planRiderSync({ ...original }, original, target);
    assert.deepEqual(follows.patch, {
        email: 'r@example.com',
        status: 'deactivated',
        approvedAt: new Date('2025-01-01'),
        rejectedAt: null,
        rejectionReason: 'Suspended by admin',
    });

    const reapprovedHere = planRiderSync({ ...original, status: 'rejected', email: 'own@example.com' }, original, target);
    assert.deepEqual(reapprovedHere.patch, {});
    assert.deepEqual(reapprovedHere.kept.sort(), ['email', 'status']);
});

const order = (over = {}) => ({
    data: {
        orderStatus: 'cancelled_by_admin', paymentStatus: 'created', paymentAmountDue: 300, razorpayPaymentId: null,
        dispatchStatus: 'cancelled', dispatchDeliveryPartnerId: 'r1', dispatchAssignedAt: null, dispatchAcceptedAt: null,
        deliveryPhase: 'en_route_to_pickup', deliveryStatus: '', pickedUpAt: null, deliveredAt: null,
        riderEarning: 0, platformProfit: 0, restaurantCommission: 0,
        note: 'Still open when the previous system was switched off',
        ...over.data,
    },
    transaction: { deliveryPartnerId: 'r1', status: 'failed', restaurantShare: 0, riderShare: 0, totalCustomerPaid: 0, ...over.transaction },
    history: over.history || [{ to: 'created', at: new Date('2026-09-14T10:00:00Z'), byRole: 'USER' },
        { to: 'cancelled_by_admin', at: new Date('2026-09-14T11:00:00Z'), byRole: 'SYSTEM' }],
    itemRatings: over.itemRatings || [],
});

test('orders: an order open at the first import and delivered since follows the old system', () => {
    const original = order();
    const delivered = new Date('2026-09-14T12:00:00Z');
    const target = order({
        data: {
            orderStatus: 'delivered', paymentStatus: 'paid', paymentAmountDue: 0, dispatchStatus: 'accepted',
            deliveryPhase: 'delivered', deliveryStatus: 'delivered', deliveredAt: delivered,
            riderEarning: 40, platformProfit: 25, restaurantCommission: 30, note: '',
            restaurantRating: 5, restaurantRatingComment: 'good', restaurantRatedAt: delivered,
        },
        transaction: { status: 'captured', restaurantShare: 200, riderShare: 40, totalCustomerPaid: 300 },
        history: [{ to: 'created', at: new Date('2026-09-14T10:00:00Z'), byRole: 'USER' },
            { to: 'delivered', at: delivered, byRole: 'DELIVERY_PARTNER' }],
    });
    const current = { ...original.data, paymentAmountDue: new Prisma.Decimal(300) };
    const plan = planOrderSync({
        original, target, current,
        currentTxn: { ...original.transaction },
        currentHistory: original.history,
        currentRatings: [],
    });
    assert.equal(plan.changed, true);
    assert.equal(plan.order.orderStatus, 'delivered');
    assert.equal(plan.order.riderEarning, 40);
    assert.equal(plan.order.restaurantRating, 5);
    assert.equal(plan.order.note, '');
    assert.deepEqual(plan.txn, { status: 'captured', restaurantShare: 200, riderShare: 40, totalCustomerPaid: 300 });
    assert.equal(plan.replaceHistory, true);
    assert.deepEqual(plan.conflicts, []);

    // Run again after it was applied: nothing left to do.
    const again = planOrderSync({
        original, target,
        current: { ...current, ...plan.order },
        currentTxn: { ...original.transaction, ...plan.txn },
        currentHistory: target.history,
        currentRatings: [],
    });
    assert.equal(again.changed, false);
});

test('orders: history edited here is left alone and reported', () => {
    const original = order();
    const target = order({ history: [{ to: 'created', at: new Date('2026-09-14T10:00:00Z'), byRole: 'USER' }] });
    const plan = planOrderSync({
        original, target,
        current: original.data,
        currentTxn: original.transaction,
        currentHistory: [...original.history, { to: 'refunded', at: new Date('2026-09-20T00:00:00Z'), byRole: 'ADMIN' }],
        currentRatings: [],
    });
    assert.equal(plan.replaceHistory, false);
    assert.equal(plan.changed, false);
    assert.deepEqual(plan.conflicts, ['history (edited here; left alone)']);
});

test('orders: nothing changed in the old system means nothing written, whatever differs here', () => {
    const original = order();
    const plan = planOrderSync({
        original, target: order(),
        current: { ...original.data, note: 'admin note here', riderEarning: 99 },
        currentTxn: original.transaction,
        currentHistory: [],
        currentRatings: [],
    });
    assert.equal(plan.changed, false);
    assert.deepEqual(plan.conflicts, []);
});
