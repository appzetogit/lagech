import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../../config/prisma.js';
import { uniquePhone, uniqueTag } from '../../../../utils/testIds.js';
import { testPatch } from '../../../../utils/testGeo.js';
import { recordTransaction, getBalance } from '../../../../core/payments/transaction.service.js';
import {
    createOrder,
    cancelOrder,
    abandonOnlinePaymentOrder,
    expireStalePendingPaymentOrders,
    processRefundAdmin,
    deleteOrderAdmin,
} from './order.service.js';
import { returnPartialWallet, walletDebitKey, walletReturnKey } from './partialPayment.service.js';
import { saveSystemSettings, getPublicBusinessSettings } from '../../admin/services/adminSystemExtras.service.js';
import { invalidateBusinessSettings } from '../../shared/businessSettings.js';
import { getCashInHandMap } from '../../delivery/services/riderCash.service.js';
import { getOrderMoneyReport } from '../../admin/services/adminOrderMoneyReport.service.js';
import { toOrder, orderInclude } from '../order.mapper.js';
import { sanitizeOrderForDeliveryPartner, normalizeOrderForClient } from './order.helpers.js';

/**
 * Partial payment (wallet + razorpay/cash) through the real entry points:
 * placement, abandonment, the pending_payment cleanup, cancellation, admin
 * refund, rider cash and the Transaction report. Every wallet movement is
 * checked against the ledger, and every "return" is run twice.
 */
const HERE = testPatch(43);
const AREAS = ['business_payment', 'business_customer'];
const created = { zones: [], restaurants: [], users: [], foods: [], categories: [], fees: [], partners: [] };
const ctx = {};

const set = (area, value) => saveSystemSettings(area, { value });
const resetSettings = async () => {
    await prisma.foodSystemSetting.deleteMany({ where: { key: { in: AREAS } } });
    invalidateBusinessSettings();
};

const address = () => ({
    label: 'Home', fullName: 'Partial Payer', street: '1 Test Street', city: 'Indore', state: 'MP',
    zipCode: '452001', phone: uniquePhone('5'), latitude: HERE.lat, longitude: HERE.lng,
});

const cart = (extra = {}) => ({
    restaurantId: ctx.restaurantId,
    items: [{ itemId: ctx.foodId, quantity: 1 }],
    address: address(),
    paymentMethod: 'cash',
    ...extra,
});

/** A customer holding `balance` in their wallet. */
const makeUser = async (balance = 0) => {
    const user = await prisma.foodUser.create({ data: { name: `Partial ${uniqueTag('u')}`, phone: uniquePhone('5') } });
    created.users.push(user.id);
    if (balance > 0) {
        await recordTransaction({
            entityType: 'user', entityId: user.id, type: 'credit', amount: balance,
            description: 'test top-up', category: 'other',
        });
    }
    return user.id;
};

const balanceOf = async (userId) => (await getBalance('user', userId)).balance;
const rowOf = (id) => prisma.foodOrder.findUnique({ where: { id }, include: orderInclude });
const ledger = (key) => prisma.transaction.findMany({ where: { idempotencyKey: key } });

test.before(async () => {
    await resetSettings();
    const tag = uniqueTag('PartPay');
    const zone = await prisma.foodZone.create({ data: { name: `${tag} Zone`, coordinates: HERE.ring, isActive: true } });
    created.zones.push(zone.id);
    const restaurant = await prisma.foodRestaurant.create({
        data: {
            restaurantName: `${tag} Kitchen`, ownerName: 'Owner', ownerPhone: uniquePhone('9'),
            status: 'approved', zoneId: zone.id, latitude: HERE.lat, longitude: HERE.lng,
            isAcceptingOrders: true, outsideHoursOverride: true,
        },
    });
    created.restaurants.push(restaurant.id);
    ctx.restaurantId = restaurant.id;
    const category = await prisma.foodCategory.create({ data: { name: `${tag} Mains`, restaurantId: restaurant.id, approvalStatus: 'approved' } });
    created.categories.push(category.id);
    const food = await prisma.foodItem.create({
        data: {
            restaurantId: restaurant.id, categoryId: category.id, categoryName: category.name,
            name: `${tag} Thali`, price: 400, approvalStatus: 'approved', isAvailable: true,
        },
    });
    created.foods.push(food.id);
    ctx.foodId = food.id;
    const fee = await prisma.foodFeeSettings.create({
        data: {
            zoneId: zone.id, isActive: true, deliveryFee: 40, platformFee: 0, platformFeeEnabled: false,
            gstRate: 0, gstEnabled: false, deliveryFeeGstRate: 0, deliveryFeeGstEnabled: false,
            deliveryFeeBands: { create: [{ minDistanceKm: 0, maxDistanceKm: 50, fee: 40, deliveryBoyBasePay: 25 }] },
        },
    });
    created.fees.push(fee.id);
    const partner = await prisma.foodDeliveryPartner.create({
        data: { name: `${tag} Rider`, phone: uniquePhone('7'), status: 'approved' },
    });
    created.partners.push(partner.id);
    ctx.partnerId = partner.id;

    // The plain price of the cart, for comparing against.
    const userId = await makeUser();
    const { order } = await createOrder(userId, cart());
    ctx.total = Number(order.pricing.total);
    ctx.plain = order;
    assert.ok(ctx.total > 300, `cart total ${ctx.total}`);
});

test.after(async () => {
    await resetSettings();
    const orders = await prisma.foodOrder.findMany({ where: { restaurantId: { in: created.restaurants } }, select: { id: true } });
    const ids = orders.map((o) => o.id);
    await prisma.foodTransaction.deleteMany({ where: { orderId: { in: ids } } });
    await prisma.orderItem.deleteMany({ where: { orderId: { in: ids } } });
    await prisma.orderStatusHistory.deleteMany({ where: { orderId: { in: ids } } });
    await prisma.orderDispatchOffer.deleteMany({ where: { orderId: { in: ids } } }).catch(() => {});
    await prisma.transaction.deleteMany({ where: { entityType: 'user', entityId: { in: created.users } } });
    await prisma.wallet.deleteMany({ where: { entityType: 'user', entityId: { in: created.users } } });
    await prisma.foodNotification.deleteMany({ where: { ownerId: { in: [...created.users, ...created.restaurants] } } }).catch(() => {});
    await prisma.foodOrder.deleteMany({ where: { id: { in: ids } } });
    await prisma.foodDeliveryPartner.deleteMany({ where: { id: { in: created.partners } } });
    await prisma.foodFeeSettings.deleteMany({ where: { id: { in: created.fees } } });
    await prisma.foodItem.deleteMany({ where: { id: { in: created.foods } } });
    await prisma.foodCategory.deleteMany({ where: { id: { in: created.categories } } });
    await prisma.foodUser.deleteMany({ where: { id: { in: created.users } } });
    await prisma.foodRestaurant.deleteMany({ where: { id: { in: created.restaurants } } });
    await prisma.foodZone.deleteMany({ where: { id: { in: created.zones } } });
    await prisma.$disconnect();
});

test('switched off, useWallet is refused and an ordinary order is exactly as before', async () => {
    await set('business_payment', { partialPayment: false });
    try {
        const userId = await makeUser(100);
        await assert.rejects(createOrder(userId, cart({ useWallet: true })), /not available right now/);
        assert.equal(await balanceOf(userId), 100);
        assert.equal(await prisma.foodOrder.count({ where: { userId } }), 0);

        const { order } = await createOrder(userId, cart());
        const row = await rowOf(order.id);
        assert.equal(Number(row.walletAmount), 0);
        assert.equal(Number(row.paymentAmountDue), ctx.total);
        assert.equal(row.paymentMethod, 'cash');
        assert.equal(await balanceOf(userId), 100, 'the wallet is untouched');
        assert.equal(order.payment.isPartial, false);
        const pub = await getPublicBusinessSettings();
        assert.equal(pub.payment.partialPayment, false);
    } finally {
        await resetSettings();
    }
});

test('wallet + cash: the wallet part is debited with the order, the rider collects only the rest', async () => {
    const userId = await makeUser(150);
    const { order } = await createOrder(userId, cart({ useWallet: true, walletAmount: 150 }));
    const row = await rowOf(order.id);
    const rest = Math.round((ctx.total - 150) * 100) / 100;

    assert.equal(row.orderStatus, 'created');
    assert.equal(row.paymentMethod, 'cash');
    assert.equal(row.paymentStatus, 'cod_pending');
    assert.equal(Number(row.walletAmount), 150);
    assert.equal(Number(row.paymentAmountDue), rest);
    assert.equal(Number(row.total), ctx.total, 'the total is unchanged');
    assert.equal(await balanceOf(userId), 0);

    const debit = await ledger(walletDebitKey(order.id));
    assert.equal(debit.length, 1);
    assert.equal(Number(debit[0].amount), 150);
    assert.equal(debit[0].type, 'debit');
    assert.equal(debit[0].orderId, order.id);

    // What the apps see.
    const client = normalizeOrderForClient(toOrder(row));
    assert.equal(client.walletAmount, 150);
    assert.deepEqual(
        { walletAmount: client.payment.walletAmount, amountDue: client.payment.amountDue, isPartial: client.payment.isPartial, method: client.payment.method },
        { walletAmount: 150, amountDue: rest, isPartial: true, method: 'cash' },
    );
    assert.equal(sanitizeOrderForDeliveryPartner(toOrder(row)).amountToCollect, rest);

    // The ledger row and the restaurant's share are the same as without a wallet part.
    const tx = await prisma.foodTransaction.findUnique({ where: { orderId: order.id } });
    const plainTx = await prisma.foodTransaction.findUnique({ where: { orderId: ctx.plain.id } });
    assert.equal(Number(tx.walletAmount), 150);
    assert.equal(Number(tx.totalCustomerPaid), ctx.total);
    assert.equal(Number(tx.restaurantShare), Number(plainTx.restaurantShare));
    assert.equal(Number(tx.platformNetProfit), Number(plainTx.platformNetProfit));

    // Delivered: the rider holds the cash part only.
    await prisma.foodOrder.update({
        where: { id: order.id },
        data: { orderStatus: 'delivered', deliveryPhase: 'delivered', deliveredAt: new Date(), paymentStatus: 'paid', dispatchDeliveryPartnerId: ctx.partnerId },
    });
    const cash = await getCashInHandMap([ctx.partnerId]);
    assert.equal(cash.get(ctx.partnerId), rest);
    ctx.deliveredPartial = { id: order.id, rest };
});

test('wallet + razorpay: pending payment, abandoned -> the wallet part comes back once', async () => {
    const userId = await makeUser(100);
    const { order } = await createOrder(userId, cart({ paymentMethod: 'razorpay', useWallet: true }));
    const row = await rowOf(order.id);
    assert.equal(row.orderStatus, 'pending_payment');
    assert.equal(Number(row.walletAmount), 100);
    assert.equal(Number(row.paymentAmountDue), Math.round((ctx.total - 100) * 100) / 100);
    assert.equal(await balanceOf(userId), 0);

    await abandonOnlinePaymentOrder(userId, order.id);
    assert.equal(await rowOf(order.id), null, 'the unpaid order is gone');
    assert.equal(await balanceOf(userId), 100);
    const back = await ledger(walletReturnKey(order.id));
    assert.equal(back.length, 1);
    assert.equal(back[0].type, 'credit');

    // Running a return again (the cleanup, a retry) moves nothing.
    const again = await returnPartialWallet({ id: order.id, userId, paymentMethod: 'razorpay', walletAmount: 100 });
    assert.deepEqual(again, { returned: 0, replayed: true });
    await expireStalePendingPaymentOrders({ force: true });
    assert.equal(await balanceOf(userId), 100);
});

test('an expired or failed pending_payment returns the wallet part, idempotently across runs', async () => {
    const userId = await makeUser(120);
    const { order: expired } = await createOrder(userId, cart({ paymentMethod: 'razorpay', useWallet: true, walletAmount: 60 }));
    const { order: failed } = await createOrder(userId, cart({ paymentMethod: 'razorpay', useWallet: true, walletAmount: 60 }));
    assert.equal(await balanceOf(userId), 0);

    const old = new Date(Date.now() - 31 * 60 * 1000);
    await prisma.foodOrder.update({ where: { id: expired.id }, data: { createdAt: old } });
    await prisma.foodOrder.update({ where: { id: failed.id }, data: { createdAt: old, paymentStatus: 'failed' } });

    await expireStalePendingPaymentOrders({ force: true });
    await expireStalePendingPaymentOrders({ force: true });
    assert.equal(await rowOf(expired.id), null);
    assert.equal(await rowOf(failed.id), null);
    assert.equal(await balanceOf(userId), 120);
    assert.equal((await ledger(walletReturnKey(expired.id))).length, 1);
    assert.equal((await ledger(walletReturnKey(failed.id))).length, 1);
});

test('a pending_payment that was paid meanwhile is not cleaned up and keeps its wallet part', async () => {
    const userId = await makeUser(80);
    const { order } = await createOrder(userId, cart({ paymentMethod: 'razorpay', useWallet: true }));
    await prisma.foodOrder.update({
        where: { id: order.id },
        data: { createdAt: new Date(Date.now() - 31 * 60 * 1000), paymentStatus: 'paid' },
    });
    await expireStalePendingPaymentOrders({ force: true });
    assert.ok(await rowOf(order.id));
    assert.equal(await balanceOf(userId), 0);
    await prisma.foodOrder.update({ where: { id: order.id }, data: { orderStatus: 'created' } });
});

test('cancelling a wallet + cash order returns the wallet part; a second refund does nothing', async () => {
    const userId = await makeUser(90);
    const { order } = await createOrder(userId, cart({ useWallet: true }));
    assert.equal(await balanceOf(userId), 0);

    const cancelled = await cancelOrder(order.id, userId, 'changed my mind');
    assert.equal(cancelled.orderStatus, 'cancelled_by_user');
    assert.equal(await balanceOf(userId), 90);
    const row = await rowOf(order.id);
    assert.equal(row.refundStatus, 'processed');
    assert.equal(Number(row.refundAmount), 90);
    assert.equal(row.paymentStatus, 'cod_pending', 'no cash was collected');

    await assert.rejects(processRefundAdmin(order.id, undefined, null), /already refunded/);
    await returnPartialWallet(row);
    assert.equal(await balanceOf(userId), 90, 'returned once');
    assert.equal((await ledger(walletReturnKey(order.id))).length, 1);
});

test('refunding a paid wallet + razorpay order: wallet part back once, gateway part retried', async () => {
    const userId = await makeUser(70);
    const { order } = await createOrder(userId, cart({ paymentMethod: 'razorpay', useWallet: true }));
    await prisma.foodOrder.update({
        where: { id: order.id },
        data: { orderStatus: 'created', paymentStatus: 'paid', razorpayPaymentId: 'pay_partial_test' },
    });
    // The test server has no gateway, so the online part fails and stays failed.
    await assert.rejects(processRefundAdmin(order.id, undefined, null), /Refund processing failed/);
    assert.equal(await balanceOf(userId), 70);
    let row = await rowOf(order.id);
    assert.equal(row.refundStatus, 'failed');
    assert.equal(row.paymentStatus, 'paid', 'the online part is still to refund');

    await assert.rejects(processRefundAdmin(order.id, undefined, null), /Refund processing failed/);
    assert.equal(await balanceOf(userId), 70, 'the retry does not return the wallet part again');
    assert.equal((await ledger(walletReturnKey(order.id))).length, 1);
    row = await rowOf(order.id);
    assert.equal(Number(row.refundAmount), ctx.total);
});

test('a balance that changed since checkout, or covers everything, is refused before anything is written', async () => {
    const userId = await makeUser(50);
    await assert.rejects(createOrder(userId, cart({ useWallet: true, walletAmount: 80 })), /balance has changed \(₹50 now\)/);
    const empty = await makeUser(0);
    await assert.rejects(createOrder(empty, cart({ useWallet: true })), /wallet balance is empty/);
    const rich = await makeUser(5000);
    await assert.rejects(createOrder(rich, cart({ useWallet: true })), /Choose Wallet as the payment method/);
    await set('business_payment', { partialPaymentMethod: 'digital' });
    try {
        await assert.rejects(createOrder(userId, cart({ useWallet: true })), /only be paid online/);
    } finally {
        await resetSettings();
    }
    assert.equal(await prisma.foodOrder.count({ where: { userId: { in: [userId, empty, rich] } } }), 0);
    assert.equal(await balanceOf(userId), 50);
    assert.equal(await balanceOf(rich), 5000);
});

test('two orders racing for the same balance: one gets it, the other is refused, nothing is overspent', async () => {
    const userId = await makeUser(200);
    const results = await Promise.allSettled([
        createOrder(userId, cart({ useWallet: true })),
        createOrder(userId, cart({ useWallet: true })),
        createOrder(userId, cart({ paymentMethod: 'razorpay', useWallet: true })),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const refused = results.filter((r) => r.status === 'rejected');
    assert.equal(ok.length, 1, JSON.stringify(results.map((r) => r.reason?.message || 'ok')));
    for (const r of refused) assert.match(r.reason.message, /wallet balance (has changed|is empty)/);
    assert.equal(await balanceOf(userId), 0);
    const orders = await prisma.foodOrder.findMany({ where: { userId }, select: { walletAmount: true } });
    assert.equal(orders.length, 1, 'the refused orders were never written');
    assert.equal(Number(orders[0].walletAmount), 200);
    const debits = await prisma.transaction.findMany({ where: { entityType: 'user', entityId: userId, type: 'debit' } });
    assert.equal(debits.length, 1);
});

test('Transaction report: "Wallet + Cash on delivery", and the paid-by columns add up to the order amount', async () => {
    assert.ok(ctx.deliveredPartial, 'the wallet + cash test ran');
    const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
    const base = { from: day(-1), to: day(1), restaurantId: ctx.restaurantId, status: 'delivered' };

    const partial = await getOrderMoneyReport({ ...base, paymentMethod: 'partial' });
    assert.equal(partial.orders.length, 1);
    const [row] = partial.orders;
    assert.equal(row.id, ctx.deliveredPartial.id);
    assert.equal(row.paymentMethodLabel, 'Wallet + Cash on delivery');
    assert.equal(row.amountReceivedBy, 'Admin + Deliveryman');
    assert.equal(row.walletPaidAmount, 150);
    assert.equal(row.otherPaidAmount, ctx.deliveredPartial.rest);
    assert.equal(row.walletPaidAmount + row.otherPaidAmount, row.orderAmount);
    assert.equal(partial.totals.walletPaidAmount + partial.totals.otherPaidAmount, partial.totals.orderAmount);

    // The restaurant earns the same from it as from the plain cash order.
    await prisma.foodOrder.update({
        where: { id: ctx.plain.id },
        data: { orderStatus: 'delivered', deliveryPhase: 'delivered', deliveredAt: new Date(), paymentStatus: 'paid' },
    });
    const all = await getOrderMoneyReport(base);
    const plain = all.orders.find((o) => o.id === ctx.plain.id);
    assert.equal(plain.paymentMethodLabel, 'Cash on delivery');
    assert.equal(plain.walletPaidAmount, 0);
    assert.equal(plain.otherPaidAmount, plain.orderAmount);
    assert.equal(row.storeNetIncome, plain.storeNetIncome);
    assert.equal(row.adminNetIncome, plain.adminNetIncome);
    assert.equal(
        Math.round((all.totals.walletPaidAmount + all.totals.otherPaidAmount) * 100) / 100,
        all.totals.orderAmount,
    );
});

test('admin delete: an unpaid order gives the wallet part back; a wallet-paid order must be refunded first', async () => {
    const pendingUser = await makeUser(80);
    const { order: pending } = await createOrder(pendingUser, cart({ paymentMethod: 'razorpay', useWallet: true }));
    assert.equal(await balanceOf(pendingUser), 0);
    await deleteOrderAdmin(pending.id);
    assert.equal(await rowOf(pending.id), null);
    assert.equal(await balanceOf(pendingUser), 80, 'the wallet part came back');

    const cashUser = await makeUser(120);
    const { order: held } = await createOrder(cashUser, cart({ useWallet: true, walletAmount: 120 }));
    await assert.rejects(() => deleteOrderAdmin(held.id), /Cancel or refund it before deleting/);
    assert.ok(await rowOf(held.id), 'the order is kept');
    assert.equal(await balanceOf(cashUser), 0);
});

test('the scheduled cleanup removes stale unpaid checkouts and returns their wallet part', async () => {
    const userId = await makeUser(60);
    const { order } = await createOrder(userId, cart({ paymentMethod: 'razorpay', useWallet: true }));
    await prisma.foodOrder.update({ where: { id: order.id }, data: { createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000) } });
    await expireStalePendingPaymentOrders({ force: true });
    assert.equal(await rowOf(order.id), null);
    assert.equal(await balanceOf(userId), 60);
});

