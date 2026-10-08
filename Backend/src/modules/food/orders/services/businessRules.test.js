import test from 'node:test';
import assert from 'node:assert/strict';

import {
    paymentMethodRefusal,
    isScheduledFor,
    freeDeliveryOverWaiver,
    newCustomerDiscount,
    percentageRiderEarning,
} from './businessRules.js';

const on = { cod: true, digital: true, partialPayment: true };
const wallet = { walletEnabled: true };

test('payment switches refuse only their own methods', () => {
    assert.equal(paymentMethodRefusal('cash', { payment: on, customer: wallet }), null);
    assert.match(paymentMethodRefusal('cash', { payment: { ...on, cod: false }, customer: wallet }), /Cash on Delivery/);
    assert.match(paymentMethodRefusal('cash', { payment: on, customer: wallet, codEnvEnabled: false }), /Cash on Delivery/);
    for (const method of ['razorpay', 'razorpay_qr', 'card']) {
        assert.match(paymentMethodRefusal(method, { payment: { ...on, digital: false }, customer: wallet }), /Online payment/);
    }
    assert.equal(paymentMethodRefusal('offline', { payment: { ...on, digital: false }, customer: wallet }), null);
    assert.equal(paymentMethodRefusal('cash', { payment: { ...on, digital: false }, customer: wallet }), null);
    assert.match(paymentMethodRefusal('wallet', { payment: on, customer: { walletEnabled: false } }), /Wallet/);
});

test('a scheduled time counts only when it is clearly ahead', () => {
    const now = new Date('2026-10-01T10:00:00Z');
    assert.equal(isScheduledFor(null, now), false);
    assert.equal(isScheduledFor('2026-10-01T10:03:00Z', now), false, 'clock skew is not a schedule');
    assert.equal(isScheduledFor('2026-10-01T12:00:00Z', now), true);
    assert.equal(isScheduledFor('nonsense', now), false);
});

test('free delivery over an item total', () => {
    const rule = { enabled: true, minSubtotal: 500 };
    assert.equal(freeDeliveryOverWaiver(rule, { subtotal: 499, deliveryFee: 40, deliveryFeeGst: 7.2 }), 0);
    assert.equal(freeDeliveryOverWaiver(rule, { subtotal: 500, deliveryFee: 40, deliveryFeeGst: 7.2 }), 47.2);
    assert.equal(freeDeliveryOverWaiver(rule, { subtotal: 900, deliveryFee: 40, deliveryFeeGst: 0, couponWaived: 40 }), 0, 'not on top of a coupon');
    assert.equal(freeDeliveryOverWaiver({ enabled: false, minSubtotal: 1 }, { subtotal: 900, deliveryFee: 40 }), 0);
});

test('new customer discount: first order, within validity, capped', () => {
    const now = new Date('2026-10-01T00:00:00Z');
    const amount = { enabled: true, type: 'amount', value: 100, maxDiscount: 0, minOrderAmount: 200, validityDays: 30 };
    const fresh = { subtotal: 300, priorOrders: 0, accountCreatedAt: new Date('2026-09-20T00:00:00Z'), now };
    assert.equal(newCustomerDiscount(amount, fresh), 100);
    assert.equal(newCustomerDiscount(amount, { ...fresh, priorOrders: 1 }), 0);
    assert.equal(newCustomerDiscount(amount, { ...fresh, subtotal: 150 }), 0, 'below the minimum');
    assert.equal(newCustomerDiscount(amount, { ...fresh, accountCreatedAt: new Date('2026-08-01T00:00:00Z') }), 0, 'validity over');
    assert.equal(newCustomerDiscount({ ...amount, validityDays: 0 }, { ...fresh, accountCreatedAt: new Date('2020-01-01') }), 100, '0 days = no limit');
    assert.equal(newCustomerDiscount(amount, { ...fresh, couponDiscount: 50 }), 0, 'does not stack with a coupon');
    assert.equal(newCustomerDiscount({ ...amount, value: 1000, minOrderAmount: 0 }, fresh), 300, 'never more than the items');
    const pct = { enabled: true, type: 'percent', value: 20, maxDiscount: 50, minOrderAmount: 0, validityDays: 0 };
    assert.equal(newCustomerDiscount(pct, { ...fresh, subtotal: 200 }), 40);
    assert.equal(newCustomerDiscount(pct, { ...fresh, subtotal: 1000 }), 50);
    assert.equal(newCustomerDiscount({ ...pct, enabled: false }, fresh), 0);
});

test('percentage rider pay is the fee less the commission', () => {
    assert.equal(percentageRiderEarning(50, 20), 40);
    assert.equal(percentageRiderEarning(45, 0), 45);
    assert.equal(percentageRiderEarning(45, 100), 0);
    assert.equal(percentageRiderEarning(null, 20), 0);
    assert.equal(percentageRiderEarning(33, 15), 28.05);
});
