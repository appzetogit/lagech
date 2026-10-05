import test from 'node:test';
import assert from 'node:assert/strict';

import {
    batchStatusFor,
    checkCoverage,
    money,
    normalizeRiderPhone,
    resolveRiderPayee,
    riderWithdrawable,
} from './adminRiderExtras.helpers.js';

/** Pure arithmetic for rider payouts; runs without a database. */

test('withdrawable is earnings plus bonus less what is paid or promised', () => {
    const r = riderWithdrawable({ earned: 1000, bonus: 100, approved: 300, pending: 200 });
    assert.equal(r.available, 600);
    assert.equal(r.effectiveLocked, 200);
    // The ledger must hold what is promised plus what is still available.
    assert.equal(r.targetLedgerBalance, 800);
});

test('never negative, even when more was paid than earned', () => {
    const r = riderWithdrawable({ earned: 100, approved: 150 });
    assert.equal(r.available, 0);
});

test('a ledger holding more than the order totals is honoured, less what is locked', () => {
    const r = riderWithdrawable({
        earned: 0,
        pending: 50,
        wallet: { balance: 500, lockedAmount: 50, totalEarnings: 0, totalBonus: 0, totalSettled: 0 },
    });
    assert.equal(r.available, 450);
    assert.equal(r.targetLedgerBalance, 500, 'nothing to sync: the ledger already covers it');
});

test('a payout recorded in the ledger counts even if the withdrawal totals lag', () => {
    const r = riderWithdrawable({
        earned: 1000,
        approved: 0,
        wallet: { balance: 0, lockedAmount: 0, totalEarnings: 0, totalSettled: 400 },
    });
    assert.equal(r.available, 600);
});

test('locked amount above pending withdrawals still holds money back', () => {
    const r = riderWithdrawable({
        earned: 0,
        wallet: { balance: 300, lockedAmount: 120, totalEarnings: 300 },
    });
    // From the totals: 300 earned, nothing paid -> 300; from the ledger: 300 - 120.
    assert.equal(r.available, 300);
    assert.equal(r.effectiveLocked, 120);
    assert.equal(r.targetLedgerBalance, 420);
});

test('accepts Decimal-like strings and rounds to paise', () => {
    const r = riderWithdrawable({ earned: '10.005', bonus: '0.10' });
    assert.equal(r.available, 10.11);
    assert.equal(money('3.14159'), 3.14);
    assert.equal(money(null), 0);
});

test('batch status follows its lines', () => {
    assert.equal(batchStatusFor([]), 'completed');
    assert.equal(batchStatusFor(['pending', 'pending']), 'pending');
    assert.equal(batchStatusFor(['approved', 'pending']), 'partially_completed');
    assert.equal(batchStatusFor(['rejected', 'pending']), 'partially_completed');
    assert.equal(batchStatusFor(['approved', 'approved']), 'completed');
    assert.equal(batchStatusFor(['rejected', 'rejected']), 'canceled');
    assert.equal(batchStatusFor(['approved', 'rejected']), 'completed');
});

test('payee prefers a complete bank account, then UPI, else none', () => {
    const bank = resolveRiderPayee({ bankAccountNumber: '123456', bankIfscCode: 'SBIN0001234', upiId: 'a@upi' });
    assert.equal(bank.paymentMethod, 'bank_transfer');
    assert.equal(bank.bankDetails.accountNumber, '123456');

    const upi = resolveRiderPayee({ bankAccountNumber: '123456', upiId: 'a@upi' });
    assert.deepEqual(upi, { paymentMethod: 'upi', bankDetails: { upiId: 'a@upi' } });

    assert.equal(resolveRiderPayee({}), null);
});

test('phones are stored as their last ten digits', () => {
    assert.equal(normalizeRiderPhone('+91 98765-43210'), '9876543210');
    assert.equal(normalizeRiderPhone('9876543210'), '9876543210');
    assert.equal(normalizeRiderPhone('12345'), null);
    assert.equal(normalizeRiderPhone(undefined), null);
});

test('vehicle coverage must be ordered and positive', () => {
    assert.equal(checkCoverage({ startingCoverageKm: 0, maxCoverageKm: 10 }), null);
    assert.equal(checkCoverage({ startingCoverageKm: 5, maxCoverageKm: 5 }), null);
    assert.match(checkCoverage({ startingCoverageKm: 6, maxCoverageKm: 5 }), /at least the starting/);
    assert.match(checkCoverage({ startingCoverageKm: 0, maxCoverageKm: 0 }), /more than 0/);
    assert.match(checkCoverage({ startingCoverageKm: -1, maxCoverageKm: 3 }), /negative/);
});
