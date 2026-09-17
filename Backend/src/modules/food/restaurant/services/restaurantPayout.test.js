import test from 'node:test';
import assert from 'node:assert/strict';

import {
    batchStatusFor,
    isPayoutDue,
    istClock,
    payoutCutoff,
    resolvePayee,
} from './restaurantPayout.service.js';

/**
 * The timing and payee rules of the daily payout run, without a database.
 * The defaults are the previous system's: daily at 03:05, one waiting day.
 */

const DAILY = { isEnabled: true, frequency: 'daily', weekday: 6, runTime: '03:05', waitingDays: 1 };

test('the run day and time are Indian, not the server clock', () => {
    // 21:40 UTC on the 16th is 03:10 IST on the 17th.
    const clock = istClock(new Date('2026-09-16T21:40:00Z'));
    assert.equal(clock.runDate, '2026-09-17');
    assert.equal(clock.minutes, 3 * 60 + 10);
    assert.equal(clock.startOfDay.toISOString(), '2026-09-16T18:30:00.000Z');
});

test('due from the configured time onward, not before', () => {
    assert.equal(isPayoutDue(DAILY, new Date('2026-09-16T21:34:00Z')), false, '03:04 IST');
    assert.equal(isPayoutDue(DAILY, new Date('2026-09-16T21:35:00Z')), true, '03:05 IST');
    assert.equal(isPayoutDue(DAILY, new Date('2026-09-17T12:00:00Z')), true, 'later that day still due; the batch table stops a repeat');
    assert.equal(isPayoutDue({ ...DAILY, isEnabled: false }, new Date('2026-09-17T12:00:00Z')), false);
});

test('weekly runs only on its weekday', () => {
    const weekly = { ...DAILY, frequency: 'weekly', weekday: 6 };
    assert.equal(isPayoutDue(weekly, new Date('2026-09-19T06:00:00Z')), true, 'Saturday');
    assert.equal(isPayoutDue(weekly, new Date('2026-09-18T06:00:00Z')), false, 'Friday');
});

test('the cut-off holds back the waiting days', () => {
    const now = new Date('2026-09-16T21:40:00Z'); // 17th, 03:10 IST
    // One waiting day: orders placed before the start of the 16th (IST).
    assert.equal(payoutCutoff(DAILY, now).toISOString(), '2026-09-15T18:30:00.000Z');
    assert.equal(payoutCutoff({ ...DAILY, waitingDays: 0 }, now).toISOString(), '2026-09-16T18:30:00.000Z');
});

test('payee: bank first, UPI when chosen or when there is no bank account', () => {
    const both = { accountNumber: '123', ifscCode: 'SBIN0001', accountHolderName: 'A', upiId: 'a@upi' };
    assert.equal(resolvePayee(both).paymentMethod, 'bank_transfer');
    assert.equal(resolvePayee({ ...both, payoutMethod: 'upi' }).paymentMethod, 'upi');
    assert.equal(resolvePayee({ upiId: 'a@upi' }).bankDetails.upiId, 'a@upi');
    assert.equal(resolvePayee({ accountNumber: '123' }), null, 'a bank account without IFSC cannot be paid');
    assert.equal(resolvePayee({ payoutMethod: 'upi', accountNumber: '1', ifscCode: 'X' }).paymentMethod, 'bank_transfer', 'falls back');
});

test('batch status follows its lines', () => {
    assert.equal(batchStatusFor(['pending', 'pending']), 'pending');
    assert.equal(batchStatusFor(['approved', 'approved']), 'completed');
    assert.equal(batchStatusFor(['rejected']), 'canceled');
    assert.equal(batchStatusFor(['approved', 'pending']), 'partially_completed');
    assert.equal(batchStatusFor(['approved', 'rejected']), 'partially_completed');
});
