import test from 'node:test';
import assert from 'node:assert/strict';

import {
    assertCollectable,
    readCashCollectionBody,
    walletCards,
} from './adminRestaurantCash.helpers.js';

/** Pure rules for "Collect Cash From Store"; runs without a database. */

test('the collect-cash form is read cleaned, cash by default', () => {
    const body = readCashCollectionBody({ amount: '149.555', reference: '  RCPT-1 ', note: ' handed over ', requestKey: 'k1' });
    assert.deepEqual(body, { amount: 149.56, method: 'cash', reference: 'RCPT-1', note: 'handed over', requestKey: 'k1' });
    assert.equal(readCashCollectionBody({ amount: 5, method: 'UPI' }).method, 'upi');
});

test('nonsense amounts and methods are refused', () => {
    assert.throws(() => readCashCollectionBody({ amount: 0 }), /greater than zero/);
    assert.throws(() => readCashCollectionBody({ amount: -10 }), /greater than zero/);
    assert.throws(() => readCashCollectionBody({ amount: 'abc' }), /greater than zero/);
    assert.throws(() => readCashCollectionBody({ amount: 20000000 }), /too large/);
    assert.throws(() => readCashCollectionBody({ amount: 5, method: 'crypto' }), /Method must be one of/);
});

test('a collection settles what is owed and never more', () => {
    assert.doesNotThrow(() => assertCollectable(100, 100));
    assert.doesNotThrow(() => assertCollectable(40, 100));
    assert.throws(() => assertCollectable(100.01, 100), /more than the restaurant owes/);
    // Nothing owed: there is nothing to collect, whatever the amount.
    assert.throws(() => assertCollectable(1, 0), /holds no cash owed/);
    assert.throws(() => assertCollectable(1, undefined), /holds no cash owed/);
});

test('the money cards come from the wallet summary and withdrawal totals', () => {
    const cards = walletCards(
        {
            totalEarnings: 110963,
            walletBalance: 149,
            netAvailable: 0,
            lockedAmount: 149,
            cashOwed: 0,
            totalCashCollected: 0,
        },
        { pendingAmount: 149, approvedAmount: 110815 },
    );
    assert.deepEqual(cards, {
        collectedCash: 0,
        pendingWithdraw: 149,
        totalWithdrawn: 110815,
        withdrawableBalance: 0,
        totalEarning: 110963,
        walletBalance: 149,
        lockedAmount: 149,
        totalCashCollected: 0,
    });
    // A missing summary (unknown restaurant) reads as zeros, not NaN.
    assert.equal(walletCards(undefined).collectedCash, 0);
    assert.equal(walletCards(undefined).totalEarning, 0);
});
