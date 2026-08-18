import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../config/prisma.js';
import { uniquePhone, uniqueTag } from '../../utils/testIds.js';
import { getBalance } from './transaction.service.js';
import {
    initiateRefund,
    processGatewayRefund,
    getRefundsByOrder,
    listRefunds,
} from './refund.service.js';

/**
 * Refunds.
 *
 * The one caller in production is the order-cancellation processor, and it
 * always asks for a wallet refund — so that is the path these follow. A refund
 * that credits twice, or credits nothing while reporting success, is money the
 * business loses quietly and nobody notices for weeks.
 *
 * The gateway path cannot be exercised here: it needs live Razorpay
 * credentials, and isRazorpayConfigured() is false without them. What is
 * covered is the fallback that runs instead, which is what happens in any
 * environment where the keys are absent.
 */
const created = { orders: [], payments: [], refunds: [], users: [], restaurants: [] };
let restaurantId = null;
let tag = null;

test.before(async () => {
    tag = uniqueTag('Rfnd');
    const restaurant = await prisma.foodRestaurant.create({
        data: {
            restaurantName: `${tag} Kitchen`,
            ownerName: 'Owner',
            ownerPhone: uniquePhone('9'),
            status: 'approved',
        },
    });
    created.restaurants.push(restaurant.id);
    restaurantId = restaurant.id;
});

test.after(async () => {
    await prisma.refund.deleteMany({ where: { orderId: { in: created.orders } } });
    // Ledger entries reference the wallet, and both reference the payment.
    await prisma.transaction.deleteMany({ where: { entityId: { in: created.users } } });
    await prisma.wallet.deleteMany({ where: { entityId: { in: created.users } } });
    await prisma.payment.deleteMany({ where: { orderId: { in: created.orders } } });
    await prisma.foodOrder.deleteMany({ where: { id: { in: created.orders } } });
    await prisma.foodUser.deleteMany({ where: { id: { in: created.users } } });
    await prisma.foodRestaurant.deleteMany({ where: { id: { in: created.restaurants } } });
    await prisma.$disconnect();
});

/**
 * A customer who paid for an order.
 *
 * Each case gets its own, because a refund moves the payment to 'refunded' and
 * that is deliberately a one-way door.
 */
const paidOrder = async ({ amount = 500, gateway = 'razorpay', status = 'success' } = {}) => {
    const user = await prisma.foodUser.create({ data: { phone: uniquePhone('5') } });
    created.users.push(user.id);

    const order = await prisma.foodOrder.create({
        data: {
            userId: user.id,
            restaurantId,
            orderId: `${tag}-${uniqueTag('O')}`,
            orderStatus: 'confirmed',
            paymentMethod: 'razorpay',
            addrStreet: '1 Test Street', addrCity: 'Indore', addrState: 'MP',
            subtotal: amount,
            total: amount,
        },
    });
    created.orders.push(order.id);

    const payment = await prisma.payment.create({
        data: {
            orderId: order.id,
            userId: user.id,
            amount,
            method: 'razorpay',
            gateway,
            gatewayPaymentId: gateway === 'razorpay' ? `pay_${uniqueTag('')}` : null,
            status,
        },
    });
    created.payments.push(payment.id);

    return { user, order, payment };
};

test('a wallet refund credits the customer and closes out both rows', async () => {
    const { user, order, payment } = await paidOrder({ amount: 500 });

    const refund = await initiateRefund({
        paymentId: payment.id,
        orderId: order.id,
        userId: user.id,
        amount: 500,
        reason: 'Order cancelled',
    });

    assert.equal(refund.status, 'processed');
    assert.ok(refund.processedAt, 'a processed refund records when');

    const { balance } = await getBalance('user', user.id);
    assert.equal(balance, 500, 'the customer got their money back');

    // The payment is closed too, which is what stops it being refunded again.
    const after = await prisma.payment.findUnique({ where: { id: payment.id } });
    assert.equal(after.status, 'refunded');
});

test('the credit is one ledger entry, tied to the order and the payment', async () => {
    const { user, order, payment } = await paidOrder({ amount: 320 });

    await initiateRefund({
        paymentId: payment.id, orderId: order.id, userId: user.id, amount: 320,
        reason: 'Restaurant closed',
    });

    const entries = await prisma.transaction.findMany({ where: { entityId: user.id } });
    assert.equal(entries.length, 1, 'refunding once must not pay out twice');
    assert.equal(entries[0].type, 'credit');
    assert.equal(entries[0].category, 'order_refund');
    assert.equal(Number(entries[0].amount), 320);
    // Support traces a refund back from the ledger, so both links matter.
    assert.equal(entries[0].orderId, order.id);
    assert.equal(entries[0].paymentId, payment.id);
});

test('the same payment cannot be refunded twice', async () => {
    const { user, order, payment } = await paidOrder({ amount: 500 });

    await initiateRefund({ paymentId: payment.id, orderId: order.id, userId: user.id, amount: 500 });

    // The second attempt is refused because the payment is no longer
    // successful. That is the only thing standing between a retried
    // cancellation and paying the customer twice — every refund row carries its
    // own idempotency key, so the ledger would not stop it.
    await assert.rejects(
        () => initiateRefund({ paymentId: payment.id, orderId: order.id, userId: user.id, amount: 500 }),
        /Can only refund successful payments/,
    );

    const { balance } = await getBalance('user', user.id);
    assert.equal(balance, 500, 'still refunded exactly once');
});

test('a payment that never succeeded cannot be refunded', async () => {
    const { user, order, payment } = await paidOrder({ status: 'failed' });

    await assert.rejects(
        () => initiateRefund({ paymentId: payment.id, orderId: order.id, userId: user.id, amount: 500 }),
        /Can only refund successful payments/,
    );
    assert.equal((await prisma.refund.findMany({ where: { orderId: order.id } })).length, 0);

    await assert.rejects(
        () => initiateRefund({ paymentId: 'a'.repeat(24), orderId: order.id, userId: user.id, amount: 5 }),
        /Payment not found/,
    );
});

test('a partial refund credits only what was asked for', async () => {
    const { user, order, payment } = await paidOrder({ amount: 500 });

    const refund = await initiateRefund({
        paymentId: payment.id, orderId: order.id, userId: user.id,
        amount: 120, reason: 'One dish unavailable',
    });

    assert.equal(Number(refund.amount), 120);
    const { balance } = await getBalance('user', user.id);
    assert.equal(balance, 120);

    // Note that a part-refund still closes the payment, so the rest can never
    // be refunded through this path afterwards.
    const after = await prisma.payment.findUnique({ where: { id: payment.id } });
    assert.equal(after.status, 'refunded');
});

test('a refund of zero is refused, and an absent amount still means all of it', async () => {
    const zero = await paidOrder({ amount: 500 });
    // This used to pay the whole 500 back: the amount was read as
    // `Number(amount) || Number(payment.amount)`, and zero is falsy. A caller
    // that worked out a refund legitimately coming to nothing refunded in full.
    await assert.rejects(
        () => initiateRefund({
            paymentId: zero.payment.id, orderId: zero.order.id, userId: zero.user.id, amount: 0,
        }),
        /greater than zero/,
    );
    assert.equal((await getBalance('user', zero.user.id)).balance, 0);
    assert.equal((await prisma.refund.findMany({ where: { orderId: zero.order.id } })).length, 0);

    // Leaving it out is still how you ask for the whole payment back.
    const all = await paidOrder({ amount: 500 });
    const refund = await initiateRefund({
        paymentId: all.payment.id, orderId: all.order.id, userId: all.user.id,
    });
    assert.equal(Number(refund.amount), 500);
    assert.equal((await getBalance('user', all.user.id)).balance, 500);
});

test('a refund cannot exceed the payment it is against', async () => {
    const { user, order, payment } = await paidOrder({ amount: 500 });

    // The refund row is written before the ledger ever sees the figure, so
    // nothing downstream would have caught this.
    await assert.rejects(
        () => initiateRefund({
            paymentId: payment.id, orderId: order.id, userId: user.id, amount: 501,
        }),
        /exceeds the payment/,
    );
    assert.equal((await getBalance('user', user.id)).balance, 0);
    assert.equal((await prisma.refund.findMany({ where: { orderId: order.id } })).length, 0);
});

test('a gateway refund is recorded but pays out nothing yet', async () => {
    const { user, order, payment } = await paidOrder({ amount: 500 });

    const refund = await initiateRefund({
        paymentId: payment.id, orderId: order.id, userId: user.id,
        amount: 500, refundTo: 'gateway',
    });

    assert.equal(refund.status, 'pending');
    assert.equal(refund.refundTo, 'gateway');

    // Nothing moves until processGatewayRefund runs — the money is still with
    // the gateway, not in the customer's wallet.
    const { balance } = await getBalance('user', user.id);
    assert.equal(balance, 0);
    const after = await prisma.payment.findUnique({ where: { id: payment.id } });
    assert.equal(after.status, 'success', 'the payment stays open');
});

test('a gateway refund with no gateway behind it falls back to the wallet', async () => {
    // gateway 'none' is what a cash or wallet payment carries, and it is also
    // what every payment looks like when Razorpay credentials are absent.
    const { user, order, payment } = await paidOrder({ amount: 500, gateway: 'none' });

    const pending = await initiateRefund({
        paymentId: payment.id, orderId: order.id, userId: user.id,
        amount: 500, refundTo: 'gateway',
    });

    const result = await processGatewayRefund(pending.id);
    assert.equal(result.status, 'processed');

    const { balance } = await getBalance('user', user.id);
    assert.equal(balance, 500, 'the customer is paid exactly once');

    // One request, one row. The fallback used to call initiateRefund, which
    // opens a second row — so the request the admin was looking at stayed
    // pending for ever while the money went out against its replacement.
    const rows = await prisma.refund.findMany({ where: { orderId: order.id } });
    assert.equal(rows.length, 1, 'one refund request is one refund row');
    assert.equal(rows[0].id, pending.id, 'and it is the row that was asked for');
    assert.equal(rows[0].status, 'processed');
    assert.equal(rows[0].refundTo, 'wallet', 'it no longer claims to be a gateway refund');
});

test('a refund that is already processed is returned, not repeated', async () => {
    const { user, order, payment } = await paidOrder({ amount: 500 });

    const done = await initiateRefund({
        paymentId: payment.id, orderId: order.id, userId: user.id, amount: 500,
    });

    const again = await processGatewayRefund(done.id);
    assert.equal(again.id, done.id);

    const { balance } = await getBalance('user', user.id);
    assert.equal(balance, 500, 're-processing pays nothing further');

    await assert.rejects(() => processGatewayRefund('a'.repeat(24)), /Refund not found/);
});

test('refunds can be listed by order and by status', async () => {
    const { user, order, payment } = await paidOrder({ amount: 500 });
    await initiateRefund({ paymentId: payment.id, orderId: order.id, userId: user.id, amount: 500 });

    const byOrder = await getRefundsByOrder(order.id);
    assert.equal(byOrder.length, 1);
    assert.equal(byOrder[0].orderId, order.id);

    const { refunds, total, totalPages } = await listRefunds({ status: 'processed', limit: 5 });
    assert.ok(total >= 1);
    assert.ok(refunds.every((r) => r.status === 'processed'), 'the status filter holds');
    assert.equal(totalPages, Math.ceil(total / 5));
});
