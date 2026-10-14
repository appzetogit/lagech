import test from 'node:test';
import assert from 'node:assert/strict';

import {
    orderEditRefusal,
    cleanReferenceCode,
    cleanEditLines,
    EDITABLE_ORDER_STATUSES,
    REFERENCE_CODE_MAX,
} from './orderEditRules.js';

const cod = (over = {}) => ({ orderStatus: 'confirmed', paymentMethod: 'cash', paymentStatus: 'cod_pending', walletAmount: 0, ...over });

test('edit: allowed before pickup on an order nothing was captured for', () => {
    for (const orderStatus of EDITABLE_ORDER_STATUSES) {
        assert.equal(orderEditRefusal(cod({ orderStatus })), null, orderStatus);
    }
    assert.deepEqual(EDITABLE_ORDER_STATUSES, ['created', 'confirmed', 'preparing']);
    assert.equal(orderEditRefusal(cod({ paymentMethod: 'razorpay_qr', paymentStatus: 'created' })), null, 'QR at the door, not out yet');
    assert.equal(orderEditRefusal(cod({ paymentMethod: 'offline', paymentStatus: 'created' })), null, 'offline, not verified');
    // The toOrder shape reads the same.
    assert.equal(orderEditRefusal({
        orderStatus: 'preparing',
        payment: { method: 'cash', status: 'cod_pending', walletAmount: 0, refund: { status: 'none' } },
        deliveryState: { pickedUpAt: null },
    }), null);
});

test('edit: refused once the food is ready, picked up, delivered or cancelled', () => {
    assert.match(orderEditRefusal(cod({ orderStatus: 'ready_for_pickup' })), /ready for pickup/);
    assert.match(orderEditRefusal(cod({ orderStatus: 'reached_pickup' })), /ready for pickup/);
    assert.match(orderEditRefusal(cod({ orderStatus: 'picked_up' })), /picked up/);
    assert.match(orderEditRefusal(cod({ orderStatus: 'reached_drop' })), /picked up/);
    assert.match(orderEditRefusal(cod({ orderStatus: 'preparing', pickedUpAt: new Date() })), /picked up/);
    assert.match(orderEditRefusal(cod({ orderStatus: 'delivered' })), /delivered/);
    for (const s of ['cancelled_by_user', 'cancelled_by_restaurant', 'cancelled_by_admin']) {
        assert.match(orderEditRefusal(cod({ orderStatus: s })), /cancelled/);
    }
    assert.match(orderEditRefusal(cod({ orderStatus: 'pending_payment' })), /waiting for its payment/);
    assert.equal(orderEditRefusal(null), 'Order not found');
});

test('edit: refused for anything paid online, by wallet or in part', () => {
    assert.match(orderEditRefusal(cod({ paymentMethod: 'razorpay', paymentStatus: 'paid' })), /paid online/);
    assert.match(orderEditRefusal(cod({ paymentMethod: 'razorpay', paymentStatus: 'created' })), /paid online/);
    assert.match(orderEditRefusal(cod({ paymentMethod: 'wallet', paymentStatus: 'paid' })), /wallet/);
    assert.match(orderEditRefusal(cod({ walletAmount: 50 })), /Part of this order/);
    assert.match(orderEditRefusal(cod({ paymentMethod: 'offline', paymentStatus: 'paid' })), /already paid/);
    assert.match(orderEditRefusal(cod({ paymentMethod: 'razorpay_qr', paymentStatus: 'paid' })), /already paid/);
    assert.match(orderEditRefusal(cod({ paymentMethod: 'razorpay_qr', paymentStatus: 'pending_qr' })), /QR/);
    assert.match(orderEditRefusal(cod({ refundStatus: 'pending' })), /refund/);
});

test('reference code: trimmed, length-limited, empty clears', () => {
    assert.equal(cleanReferenceCode('  UPI-4417 '), 'UPI-4417');
    assert.equal(cleanReferenceCode(123456), '123456');
    assert.equal(cleanReferenceCode(''), null);
    assert.equal(cleanReferenceCode('   '), null);
    assert.equal(cleanReferenceCode(null), null);
    assert.equal(cleanReferenceCode('x'.repeat(REFERENCE_CODE_MAX)).length, REFERENCE_CODE_MAX);
    assert.throws(() => cleanReferenceCode('x'.repeat(REFERENCE_CODE_MAX + 1)), /at most 100/);
    assert.throws(() => cleanReferenceCode(undefined), /required/);
    assert.throws(() => cleanReferenceCode({ a: 1 }), /must be text/);
    assert.throws(() => cleanReferenceCode('abc\ndef'), /invalid characters/);
});

test('edit lines: the order-creation shape, at least one, sane quantities', () => {
    assert.deepEqual(cleanEditLines([{ foodId: 'a'.repeat(24), quantity: 2, addons: [{ addonId: 'b'.repeat(24), name: 'Cheese' }, 'Mayo'] }]), [
        { itemId: 'a'.repeat(24), variantId: '', quantity: 2, addons: ['b'.repeat(24), 'Mayo'], notes: '' },
    ]);
    assert.equal(cleanEditLines([{ itemId: 'c'.repeat(24), itemCampaignId: 'd'.repeat(24), quantity: 1 }])[0].campaignId, 'd'.repeat(24));
    assert.throws(() => cleanEditLines([]), /At least one item/);
    assert.throws(() => cleanEditLines(undefined), /At least one item/);
    assert.throws(() => cleanEditLines([{ itemId: 'a'.repeat(24), quantity: 0 }]), /Quantity/);
    assert.throws(() => cleanEditLines([{ itemId: 'a'.repeat(24), quantity: 1.5 }]), /Quantity/);
    assert.throws(() => cleanEditLines([{ quantity: 1 }]), /item id/);
});
