import test from 'node:test';
import assert from 'node:assert/strict';

import { cashRefusalReason, describeCashPosition, orderCollectsCash } from './riderCash.service.js';

/**
 * The cash-limit rules, without a database: what a rider holding a given
 * amount may take. They follow the previous system, with a Rs.5,000 limit.
 */

const LIMIT = 5000;
const cashOrder = (total) => ({ paymentMethod: 'cash', total });
const prepaid = (total) => ({ paymentMethod: 'razorpay', total });

test('no limit set: nothing warns, suspends or refuses', () => {
    const position = describeCashPosition(99999, 0);
    assert.equal(position.cashSuspended, false);
    assert.equal(position.cashLimitWarning, false);
    assert.equal(cashRefusalReason(position, cashOrder(5000)), null);
});

test('the warning starts at 90% of the limit', () => {
    assert.equal(describeCashPosition(4499, LIMIT).cashLimitWarning, false);
    const at = describeCashPosition(4500, LIMIT);
    assert.equal(at.cashWarningAt, 4500);
    assert.equal(at.cashLimitWarning, true);
    assert.equal(at.cashSuspended, false);
});

test('a cash order counts toward the limit before it is accepted', () => {
    // Checking only what the rider already held let one big order carry them far past it.
    const holding = describeCashPosition(4600, LIMIT);
    assert.equal(cashRefusalReason(holding, cashOrder(399)), null, '4,999 stays under');
    assert.match(cashRefusalReason(holding, cashOrder(400)), /would take you to your Rs.5000 cash limit/);
});

test('a prepaid order adds no cash, so it is not refused below the limit', () => {
    assert.equal(cashRefusalReason(describeCashPosition(4900, LIMIT), prepaid(2000)), null);
});

test('at or over the limit the rider is suspended from every order', () => {
    const over = describeCashPosition(5000, LIMIT);
    assert.equal(over.cashSuspended, true);
    assert.equal(over.availableCashLimit, 0);
    assert.match(cashRefusalReason(over, prepaid(100)), /suspended/);
    assert.match(cashRefusalReason(over, cashOrder(100)), /suspended/);
});

test('a QR order may fall back to cash at the door, so it counts as cash', () => {
    assert.equal(orderCollectsCash({ payment: { method: 'razorpay_qr' } }), true);
    assert.equal(orderCollectsCash({ paymentMethod: 'wallet' }), false);
    // The mapped order carries its total under pricing.
    const holding = describeCashPosition(4800, LIMIT);
    assert.ok(cashRefusalReason(holding, { payment: { method: 'razorpay_qr' }, pricing: { total: 250 } }));
});
