import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../../config/prisma.js';
import { uniquePhone, uniqueTag } from '../../../../utils/testIds.js';
import {
    switchToCash,
    getPaymentStatus,
    createCollectQr,
    syncRazorpayQrPayment,
} from './order-payment.service.js';

/**
 * Collecting payment at the door.
 *
 * A rider arrives, the customer either scans a QR or pays cash, and this
 * decides which. Getting it wrong is expensive in both directions: settle a QR
 * that was never captured and the food leaves without payment; miss one that
 * was and the customer pays twice.
 *
 * Razorpay is not configured under test, so the paths that call out to it are
 * covered up to the point they would — which is also exactly how these behave
 * in any environment missing the keys.
 */
const created = { orders: [], users: [], restaurants: [], partners: [] };
let restaurantId = null;
let userId = null;
let partnerId = null;
let otherPartnerId = null;
let tag = null;

test.before(async () => {
    tag = uniqueTag('OPay');

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

    const user = await prisma.foodUser.create({ data: { phone: uniquePhone('5') } });
    created.users.push(user.id);
    userId = user.id;

    const [rider, other] = await Promise.all([
        prisma.foodDeliveryPartner.create({
            data: { name: `${tag} Rider`, phone: uniquePhone('6'), status: 'approved' },
        }),
        prisma.foodDeliveryPartner.create({
            data: { name: `${tag} Other`, phone: uniquePhone('6'), status: 'approved' },
        }),
    ]);
    created.partners.push(rider.id, other.id);
    partnerId = rider.id;
    otherPartnerId = other.id;
});

test.after(async () => {
    await prisma.foodTransaction.deleteMany({ where: { orderId: { in: created.orders } } });
    await prisma.foodOrder.deleteMany({ where: { id: { in: created.orders } } });
    await prisma.foodDeliveryPartner.deleteMany({ where: { id: { in: created.partners } } });
    await prisma.foodUser.deleteMany({ where: { id: { in: created.users } } });
    await prisma.foodRestaurant.deleteMany({ where: { id: { in: created.restaurants } } });
    await prisma.$disconnect();
});

/**
 * An order out for delivery, with the ledger row placed alongside it.
 *
 * Both records carry the payment method, and switchToCash has to move both —
 * see the test that checks it.
 */
/**
 * createOrder writes the display id to both columns, and the two lookup
 * helpers in this module read one each — orderIdentity reads order_id,
 * buildOrderIdentityFilter reads either. A fixture setting only one passes
 * some of these and fails the rest for a reason that has nothing to do with
 * the code under test.
 */
const displayId = () => {
    const value = `${tag}-${uniqueTag('O')}`;
    return { order_id: value, orderId: value };
};

const outForDelivery = async ({
    paymentMethod = 'razorpay_qr',
    paymentStatus = 'pending_qr',
    total = 500,
    withTransaction = true,
    qr = undefined,
} = {}) => {
    const order = await prisma.foodOrder.create({
        data: {
            userId,
            restaurantId,
            dispatchDeliveryPartnerId: partnerId,
            ...displayId(),
            orderStatus: 'picked_up',
            paymentMethod,
            paymentStatus,
            addrStreet: '1 Test Street', addrCity: 'Indore', addrState: 'MP',
            subtotal: total,
            total,
            riderEarning: 35,
            ...(qr ? { qr } : {}),
        },
    });
    created.orders.push(order.id);

    if (withTransaction) {
        await prisma.foodTransaction.create({
            data: {
                orderId: order.id,
                userId,
                restaurantId,
                deliveryPartnerId: partnerId,
                paymentMethod,
                paymentStatusLabel: paymentStatus,
                amountDue: total,
                currency: 'INR',
                status: 'pending',
                subtotal: total,
                total,
                totalCustomerPaid: total,
                // The split has no defaults; none of these tests read it.
                restaurantShare: 0,
                commissionAmount: 0,
                riderShare: 0,
                platformNetProfit: 0,
                ...(qr ? { qr } : {}),
            },
        });
    }

    return order;
};

// ── switching to cash ──

test('switching to cash moves the order and the ledger row together', async () => {
    const order = await outForDelivery();

    const result = await switchToCash(order.id, partnerId);
    assert.deepEqual(result, { success: true });

    const [row, tx] = await Promise.all([
        prisma.foodOrder.findUnique({ where: { id: order.id } }),
        prisma.foodTransaction.findUnique({ where: { orderId: order.id } }),
    ]);

    // Both, not one. Updating only the transaction left the order on
    // razorpay_qr/pending_qr, so completeDelivery never flipped it to paid and
    // the cash-in-hand totals — which filter on the order's own method and
    // status — never saw money the rider had actually collected.
    assert.equal(row.paymentMethod, 'cash');
    assert.equal(row.paymentStatus, 'cod_pending');
    assert.equal(tx.paymentMethod, 'cash');
    assert.equal(tx.paymentStatusLabel, 'cod_pending');
});

test('switching to cash clears the QR so a stale link cannot be paid against', async () => {
    const qr = { paymentLinkId: 'plink_stale', shortUrl: 'https://rzp.io/i/stale', status: 'created' };
    const order = await outForDelivery({ qr });

    await switchToCash(order.id, partnerId);

    const [row, tx] = await Promise.all([
        prisma.foodOrder.findUnique({ where: { id: order.id } }),
        prisma.foodTransaction.findUnique({ where: { orderId: order.id } }),
    ]);
    assert.deepEqual(row.qr, {}, 'the order no longer points at a live payment link');
    assert.deepEqual(tx.qr, {});
});

test('switching to cash records who did it and why', async () => {
    const order = await outForDelivery();
    await switchToCash(order.id, partnerId);

    const history = await prisma.foodTransactionHistory.findMany({
        where: { transaction: { orderId: order.id } },
        orderBy: { at: 'desc' },
    });
    const entry = history.find((h) => h.kind === 'cod_switched_to_cash');
    assert.ok(entry, 'the switch is on the transaction history');
    assert.equal(entry.recordedById, partnerId);
    assert.equal(entry.recordedByRole, 'DELIVERY_PARTNER');
});

test('an order that was already paid online cannot be switched to cash', async () => {
    // Otherwise a rider could collect cash for an order the customer has
    // already paid for online, and the money would simply be theirs.
    const order = await outForDelivery({ paymentMethod: 'razorpay', paymentStatus: 'paid' });

    await assert.rejects(
        () => switchToCash(order.id, partnerId),
        /cannot be switched to cash/i,
    );

    const row = await prisma.foodOrder.findUnique({ where: { id: order.id } });
    assert.equal(row.paymentMethod, 'razorpay', 'nothing moved');
});

test('a QR order that has already been paid cannot be switched to cash', async () => {
    const order = await outForDelivery({ paymentMethod: 'razorpay_qr', paymentStatus: 'paid' });

    await assert.rejects(() => switchToCash(order.id, partnerId), /already paid/i);
});

test('only the rider carrying the order can switch it', async () => {
    const order = await outForDelivery();

    await assert.rejects(() => switchToCash(order.id, otherPartnerId), /not your order/i);
    await assert.rejects(() => switchToCash('a'.repeat(24), partnerId), /not found/i);

    const row = await prisma.foodOrder.findUnique({ where: { id: order.id } });
    assert.equal(row.paymentMethod, 'razorpay_qr', 'nothing moved');
});

test('switching to cash works from the display id too', async () => {
    // The rider app holds the FOD- id, not the primary key.
    const order = await outForDelivery();

    await switchToCash(order.order_id, partnerId);

    const row = await prisma.foodOrder.findUnique({ where: { id: order.id } });
    assert.equal(row.paymentMethod, 'cash');
});

// ── reading payment state ──

test('payment status reports the money the rider needs to see', async () => {
    const order = await outForDelivery({ total: 640 });

    const status = await getPaymentStatus(order.id, partnerId);

    assert.equal(status.payment.method, 'razorpay_qr');
    assert.equal(status.payment.status, 'pending_qr');
    assert.equal(Number(status.pricingTotal), 640);
    assert.equal(Number(status.riderEarning), 35);
    assert.equal(status.transactionStatus, 'pending');
});

test('payment status falls back to the order when there is no ledger row', async () => {
    // A QR can be raised for an order that never got a transaction at
    // placement, so this must not depend on one existing.
    const order = await outForDelivery({
        paymentMethod: 'cash', paymentStatus: 'cod_pending', withTransaction: false,
    });

    const status = await getPaymentStatus(order.id, partnerId);
    assert.equal(status.payment.method, 'cash');
    assert.equal(status.payment.status, 'cod_pending');
    assert.equal(status.transactionStatus, null);
});

test('payment status is refused to anyone but the assigned rider', async () => {
    const order = await outForDelivery();

    await assert.rejects(() => getPaymentStatus(order.id, otherPartnerId), /not your order/i);
    await assert.rejects(() => getPaymentStatus('a'.repeat(24), partnerId), /not found/i);
    await assert.rejects(() => getPaymentStatus('', partnerId), /order id required/i);
});

// ── raising a QR ──

test('a QR is refused for an order that is already paid', async () => {
    const order = await outForDelivery({ paymentMethod: 'razorpay', paymentStatus: 'paid' });

    await assert.rejects(() => createCollectQr(order.id, partnerId), /already paid/i);
});

test('a QR is refused to a rider who is not carrying the order', async () => {
    const order = await outForDelivery();

    await assert.rejects(() => createCollectQr(order.id, otherPartnerId), /not your order/i);
    await assert.rejects(() => createCollectQr('a'.repeat(24), partnerId), /not found/i);
});

test('a QR is refused when there is nothing left to collect', async () => {
    const order = await outForDelivery({ total: 0 });

    // Ahead of the gateway check, so this is the error even without keys.
    await assert.rejects(() => createCollectQr(order.id, partnerId), /no amount due/i);
});

test('a QR is refused rather than half-created when Razorpay is not configured', async () => {
    const order = await outForDelivery();

    await assert.rejects(() => createCollectQr(order.id, partnerId), /not configured/i);

    // The guard sits before the first write, so a missing key leaves no
    // half-finished QR on either record.
    const [row, tx] = await Promise.all([
        prisma.foodOrder.findUnique({ where: { id: order.id } }),
        prisma.foodTransaction.findUnique({ where: { orderId: order.id } }),
    ]);
    assert.equal(row.paymentStatus, 'pending_qr', 'unchanged');
    assert.ok(!row.qr?.paymentLinkId, 'no payment link was recorded');
    assert.ok(!tx.qr?.paymentLinkId);
});

// ── syncing a QR ──

test('syncing settles nothing it cannot confirm', async () => {
    const order = await outForDelivery({
        qr: { paymentLinkId: 'plink_unknown', status: 'created' },
    });

    // Razorpay is unreachable here, so there is no confirmation to act on. The
    // order must stay unpaid: settling on an unconfirmed link is how a rider
    // ends up handing over food nobody paid for.
    const payment = await syncRazorpayQrPayment({ id: order.id });
    assert.notEqual(payment?.status, 'paid');

    const row = await prisma.foodOrder.findUnique({ where: { id: order.id } });
    assert.equal(row.paymentStatus, 'pending_qr');
});

test('syncing leaves an order that is not on QR alone', async () => {
    const cash = await outForDelivery({ paymentMethod: 'cash', paymentStatus: 'cod_pending' });
    const payment = await syncRazorpayQrPayment({ id: cash.id });
    assert.equal(payment.method, 'cash');

    const row = await prisma.foodOrder.findUnique({ where: { id: cash.id } });
    assert.equal(row.paymentStatus, 'cod_pending');
});

test('syncing an order with no payment record at all returns nothing', async () => {
    const bare = await outForDelivery({ withTransaction: false });
    // No transaction, and the caller passed no order snapshot either.
    assert.equal(await syncRazorpayQrPayment({ id: bare.id }), null);
});
