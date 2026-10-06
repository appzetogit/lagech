import test from 'node:test';
import assert from 'node:assert/strict';

import {
    planPartialPayment,
    orderWalletAmount,
    remainderAmount,
    isPartialPayment,
} from './partialPayment.service.js';
import { cashRefusalReason, describeCashPosition } from '../../delivery/services/riderCash.service.js';
import { sanitizeOrderForDeliveryPartner } from './order.helpers.js';

/** The split rules, without a database. */
const payment = { cod: true, digital: true, partialPayment: true, partialPaymentMethod: 'both' };
const customer = { walletEnabled: true };
const plan = (over = {}) => planPartialPayment({ method: 'cash', total: 500, balance: 120, payment, customer, ...over });

test('the wallet covers what it can and the rest is left to the chosen method', () => {
    assert.deepEqual(plan(), { walletAmount: 120, remainder: 380 });
    assert.deepEqual(plan({ method: 'razorpay', balance: 99.99, total: 250.5 }), { walletAmount: 99.99, remainder: 150.51 });
});

test('the wallet part the customer was shown is used, and a lower balance is refused', () => {
    assert.deepEqual(plan({ walletAmount: 100 }), { walletAmount: 100, remainder: 400 });
    assert.throws(() => plan({ walletAmount: 150 }), /wallet balance has changed \(₹120 now\)/);
    assert.throws(() => plan({ walletAmount: 0 }), /Invalid wallet amount/);
});

test('switched off, wallet off, or an empty wallet refuses', () => {
    assert.throws(() => plan({ payment: { ...payment, partialPayment: false } }), /not available right now/);
    assert.throws(() => plan({ customer: { walletEnabled: false } }), /not available right now/);
    assert.throws(() => plan({ balance: 0 }), /wallet balance is empty/);
});

test('a wallet that covers the whole order is a wallet order, not a partial one', () => {
    assert.throws(() => plan({ balance: 500 }), /Choose Wallet as the payment method/);
    assert.throws(() => plan({ balance: 900 }), /Choose Wallet/);
});

test('only razorpay or cash may pay the rest, as the admin allows', () => {
    for (const method of ['wallet', 'offline', 'razorpay_qr', 'card']) {
        assert.throws(() => plan({ method }), /online or with cash on delivery/, method);
    }
    assert.throws(() => plan({ method: 'razorpay', payment: { ...payment, partialPaymentMethod: 'cod' } }), /only be paid with cash/);
    assert.throws(() => plan({ method: 'cash', payment: { ...payment, partialPaymentMethod: 'digital' } }), /only be paid online/);
    assert.deepEqual(plan({ payment: { ...payment, partialPaymentMethod: 'cod' } }), { walletAmount: 120, remainder: 380 });
});

test('an online rest below one rupee is refused (the gateway minimum)', () => {
    assert.throws(() => plan({ method: 'razorpay', total: 100, balance: 99.5 }), /below ₹1/);
    assert.deepEqual(plan({ method: 'cash', total: 100, balance: 99.5 }), { walletAmount: 99.5, remainder: 0.5 });
});

test('order helpers read the split; a full-wallet order is not partial', () => {
    const partial = { paymentMethod: 'cash', total: 500, walletAmount: '120' };
    assert.equal(orderWalletAmount(partial), 120);
    assert.equal(remainderAmount(partial), 380);
    assert.equal(isPartialPayment(partial), true);
    const full = { paymentMethod: 'wallet', total: 500, walletAmount: 0 };
    assert.equal(isPartialPayment(full), false);
    assert.equal(remainderAmount(full), 500);
    assert.equal(remainderAmount({ paymentMethod: 'razorpay', total: 300 }), 300, 'an ordinary order charges its total');
});

test('the rider collects, and the cash limit counts, only the cash part', () => {
    const order = { paymentMethod: 'cash', total: 500, payment: { method: 'cash', status: 'cod_pending', walletAmount: 120 }, pricing: { total: 500 } };
    assert.equal(sanitizeOrderForDeliveryPartner(order).amountToCollect, 380);
    assert.equal(sanitizeOrderForDeliveryPartner({ ...order, payment: { ...order.payment, status: 'paid' } }).amountToCollect, 0);
    assert.equal(sanitizeOrderForDeliveryPartner({ ...order, payment: { method: 'razorpay', status: 'paid' } }).amountToCollect, 0);
    // Holding 600 of a 1000 limit: a 500 cash order would reach it, its 380 cash part does not.
    const position = describeCashPosition(600, 1000);
    assert.equal(cashRefusalReason(position, order), null);
    assert.match(cashRefusalReason(position, { ...order, payment: { method: 'cash' } }), /cash limit/);
});
