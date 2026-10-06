import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../../config/prisma.js';
import { uniquePhone, uniqueTag } from '../../../../utils/testIds.js';
import { saveSystemSettings } from '../../admin/services/adminSystemExtras.service.js';
import { invalidateBusinessSettings } from '../../shared/businessSettings.js';
import { updateSupportTicket } from '../../admin/services/adminSupportTicket.service.js';
import { reverseOrderLoyaltyPoints } from '../../user/services/loyaltyPoint.service.js';
import { createOrderIssue, listMyOrderIssues } from '../../user/services/orderIssue.service.js';
import {
    approveRefundRequest,
    createRefundRequest,
    getOrderRefundStatus,
    getRefundRequestAdmin,
    listMyRefundRequests,
    listRefundRequestsAdmin,
    refundEligibility,
    rejectRefundRequest,
    sniffImageType,
    storeImages,
} from './refundRequest.service.js';

/**
 * Customer refund requests and order issue reports, against the real database:
 * who may ask, the money each payment method moves on approval, the loyalty
 * points taken back, and the issue report that becomes a support ticket.
 */
const AREAS = ['business_refund', 'business_order_issue_reasons'];
const created = { users: [], restaurants: [], orders: [] };
const ctx = {};

const set = async (area, value) => {
    await saveSystemSettings(area, { value });
    invalidateBusinessSettings();
};

const makeUser = async () => {
    const user = await prisma.foodUser.create({ data: { name: `${uniqueTag('Rf')} Customer`, phone: uniquePhone('5') } });
    created.users.push(user.id);
    return user;
};

const makeOrder = async (userId, over = {}) => {
    const order = await prisma.foodOrder.create({
        data: {
            userId,
            restaurantId: ctx.restaurant.id,
            order_id: `FOD-${uniqueTag('r')}`.slice(0, 32),
            orderStatus: 'delivered',
            deliveredAt: new Date(Date.now() - 60 * 60 * 1000),
            paymentMethod: 'wallet',
            paymentStatus: 'paid',
            addrStreet: '1 Test Street',
            addrCity: 'Indore',
            addrState: 'MP',
            subtotal: 200,
            total: 200,
            ...over,
        },
    });
    created.orders.push(order.id);
    return order;
};

const walletBalance = async (userId) => {
    const wallet = await prisma.wallet.findUnique({ where: { entityType_entityId: { entityType: 'user', entityId: userId } } });
    return Number(wallet?.balance || 0);
};

test.before(async () => {
    await prisma.foodSystemSetting.deleteMany({ where: { key: { in: AREAS } } });
    invalidateBusinessSettings();
    ctx.restaurant = await prisma.foodRestaurant.create({
        data: { restaurantName: `${uniqueTag('Rf')} Diner`, ownerName: 'Owner', ownerPhone: uniquePhone('9'), status: 'approved' },
    });
    created.restaurants.push(ctx.restaurant.id);
    ctx.user = await makeUser();
    ctx.other = await makeUser();
    await set('business_refund', { refundRequestEnabled: true, requestWindowHours: 24, reasons: [{ text: 'Food was cold' }, { text: 'Hidden', isActive: false }] });
    await set('business_order_issue_reasons', { reasons: [{ text: 'Item missing' }] });
    const refund = await prisma.foodSystemSetting.findUnique({ where: { key: 'business_refund' } });
    ctx.coldId = refund.value.reasons.find((r) => r.text === 'Food was cold').id;
    ctx.hiddenId = refund.value.reasons.find((r) => r.text === 'Hidden').id;
    const issues = await prisma.foodSystemSetting.findUnique({ where: { key: 'business_order_issue_reasons' } });
    ctx.missingId = issues.value.reasons[0].id;
});

test.after(async () => {
    const users = created.users;
    await prisma.foodRefundRequest.deleteMany({ where: { userId: { in: users } } });
    await prisma.foodSupportTicket.deleteMany({ where: { userId: { in: users } } });
    await prisma.foodNotification.deleteMany({ where: { ownerId: { in: users } } });
    await prisma.foodLoyaltyPointTransaction.deleteMany({ where: { userId: { in: users } } });
    await prisma.foodLoyaltyPointAccount.deleteMany({ where: { userId: { in: users } } });
    await prisma.transaction.deleteMany({ where: { entityType: 'user', entityId: { in: users } } });
    await prisma.wallet.deleteMany({ where: { entityType: 'user', entityId: { in: users } } });
    await prisma.foodOrder.deleteMany({ where: { id: { in: created.orders } } });
    await prisma.foodUser.deleteMany({ where: { id: { in: users } } });
    await prisma.foodRestaurant.deleteMany({ where: { id: { in: created.restaurants } } });
    await prisma.foodSystemSetting.deleteMany({ where: { key: { in: AREAS } } });
    invalidateBusinessSettings();
    await prisma.$disconnect();
});

test('eligibility: mode, delivery, payment, window, open and finished requests', () => {
    const on = { refundRequestEnabled: true, requestWindowHours: 24 };
    const now = new Date('2026-10-06T12:00:00Z');
    const order = {
        orderStatus: 'delivered', paymentStatus: 'paid', total: 300, refundStatus: 'none', refundAmount: 0,
        deliveredAt: new Date('2026-10-06T00:00:00Z'),
    };
    assert.deepEqual(refundEligibility(order, on, [], now).maxAmount, 300);
    assert.equal(refundEligibility(order, { ...on, refundRequestEnabled: false }, [], now).eligible, false);
    assert.match(refundEligibility({ ...order, orderStatus: 'preparing' }, on, [], now).message, /once the order is delivered/);
    assert.match(refundEligibility({ ...order, paymentStatus: 'cod_pending' }, on, [], now).message, /no payment/);
    assert.match(refundEligibility({ ...order, paymentStatus: 'refunded' }, on, [], now).message, /already been refunded/);
    assert.match(refundEligibility(order, on, [{ status: 'pending' }], now).message, /already being reviewed/);
    assert.match(refundEligibility(order, on, [{ status: 'approved' }], now).message, /already being reviewed/);
    assert.equal(refundEligibility(order, on, [{ status: 'rejected' }], now).eligible, true, 'a rejected request may be asked again');
    const late = new Date('2026-10-07T00:00:01Z');
    assert.match(refundEligibility(order, on, [], late).message, /within 24 hours of delivery/);
    assert.equal(refundEligibility(order, { ...on, requestWindowHours: 0 }, [], late).eligible, true, '0 = no limit');
});

test('photos are recognised by their bytes, not the declared type; at most three', async () => {
    const pad = Buffer.alloc(16);
    assert.equal(sniffImageType(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), pad])), 'image/jpeg');
    assert.equal(sniffImageType(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), pad])), 'image/png');
    assert.equal(sniffImageType(Buffer.concat([Buffer.from('RIFF0000WEBP'), pad])), 'image/webp');
    assert.equal(sniffImageType(Buffer.from('<html><script>alert(1)</script>')), null);
    const fake = { buffer: Buffer.from('not an image at all, honestly'), mimetype: 'image/jpeg' };
    await assert.rejects(() => storeImages([fake], 'food/test'), /must be JPEG/);
    await assert.rejects(() => storeImages([fake, fake, fake, fake], 'food/test'), /At most 3/);
    assert.deepEqual(await storeImages([], 'food/test'), []);
});

test('a wallet order: request, one open at a time, partial approval to the wallet, points taken back', async () => {
    const order = await makeOrder(ctx.user.id, { total: 200 });
    // The order earned 10 points; 6 were already converted, 4 are left.
    await prisma.foodLoyaltyPointAccount.create({ data: { userId: ctx.user.id, points: 4, totalEarned: 10, totalConverted: 6 } });
    await prisma.foodLoyaltyPointTransaction.create({
        data: { userId: ctx.user.id, type: 'credit', points: 10, balanceAfter: 10, source: 'order', orderId: order.id, idempotencyKey: `loyalty_earn:${order.id}` },
    });

    await assert.rejects(() => createRefundRequest(ctx.other.id, order.id, { reasonId: ctx.coldId }), /Order not found/);
    await assert.rejects(() => createRefundRequest(ctx.user.id, order.id, { reasonId: ctx.hiddenId }), /from the list/);
    await assert.rejects(() => createRefundRequest(ctx.user.id, order.id, {}), /Choose a reason/);

    const status = await getOrderRefundStatus(ctx.user.id, order.order_id);
    assert.equal(status.eligible, true);
    assert.equal(status.maxAmount, 200);
    assert.equal(status.refundTo, 'wallet');

    const request = await createRefundRequest(ctx.user.id, order.order_id, { reasonId: ctx.coldId, note: 'Stone cold' });
    assert.equal(request.status, 'pending');
    assert.equal(request.reason, 'Food was cold');
    assert.equal(request.requestedAmount, 200);
    await assert.rejects(() => createRefundRequest(ctx.user.id, order.id, { reason: 'Again' }), /already being reviewed/);
    // The partial unique index holds even if the service check is bypassed.
    await assert.rejects(() => prisma.foodRefundRequest.create({
        data: { orderId: order.id, userId: ctx.user.id, restaurantId: ctx.restaurant.id, reason: 'x', requestedAmount: 1 },
    }));

    await assert.rejects(() => approveRefundRequest(request.id, null, { amount: 250 }), /At most ₹200/);
    await assert.rejects(() => approveRefundRequest(request.id, null, { amount: 0 }), /above zero/);

    const before = await walletBalance(ctx.user.id);
    const approved = await approveRefundRequest(request.id, null, { amount: 80, note: 'Half the thali' });
    assert.equal(approved.status, 'refunded');
    assert.equal(approved.refundedAmount, 80);
    assert.equal(approved.refundMethod, 'wallet');
    assert.equal(await walletBalance(ctx.user.id), before + 80);

    const row = await prisma.foodOrder.findUnique({ where: { id: order.id } });
    assert.equal(row.paymentStatus, 'refunded');
    assert.equal(row.refundStatus, 'processed');
    assert.equal(Number(row.refundAmount), 80);

    // Points: 10 earned, only 4 left, so 4 are taken and the balance stops at 0.
    const account = await prisma.foodLoyaltyPointAccount.findUnique({ where: { userId: ctx.user.id } });
    assert.equal(account.points, 0);
    const again = await reverseOrderLoyaltyPoints(order.id);
    assert.equal(again.reversed, false, 'reversal is once per order');
    const reversals = await prisma.foodLoyaltyPointTransaction.findMany({ where: { orderId: order.id, source: 'refund' } });
    assert.equal(reversals.length, 1);
    assert.equal(reversals[0].points, 4);

    await assert.rejects(() => approveRefundRequest(request.id, null, {}), /already refunded/);
    const after = await getOrderRefundStatus(ctx.user.id, order.id);
    assert.equal(after.eligible, false);
    assert.equal(after.request.status, 'refunded');

    const push = await prisma.foodNotification.findFirst({ where: { ownerId: ctx.user.id, category: 'refund_processed' } });
    assert.ok(push, 'the customer is told (inbox copy of the push)');
});

test('cash on delivery and a verified offline payment are refunded to the wallet, once', async () => {
    const cod = await makeOrder(ctx.user.id, { paymentMethod: 'cash', total: 150 });
    const offline = await makeOrder(ctx.user.id, {
        paymentMethod: 'offline', total: 120,
        offlinePayment: { status: 'verified', methodName: 'Bank transfer' },
    });
    const unpaidCod = await makeOrder(ctx.user.id, { paymentMethod: 'cash', paymentStatus: 'cod_pending' });
    await assert.rejects(() => createRefundRequest(ctx.user.id, unpaidCod.id, { reason: 'Bad' }), /no payment to refund/);

    const start = await walletBalance(ctx.user.id);
    const a = await createRefundRequest(ctx.user.id, cod.id, { reason: 'Wrong dish' });
    const b = await createRefundRequest(ctx.user.id, offline.id, { reasonId: ctx.coldId });
    const doneA = await approveRefundRequest(a.id, null, {});
    const doneB = await approveRefundRequest(b.id, null, { amount: 120 });
    assert.equal(doneA.refundedAmount, 150);
    assert.equal(doneA.refundMethod, 'wallet');
    assert.equal(doneB.refundMethod, 'wallet');
    assert.equal(await walletBalance(ctx.user.id), start + 270);

    const credits = await prisma.transaction.findMany({ where: { idempotencyKey: { in: [`refund_request:${a.id}`, `refund_request:${b.id}`] } } });
    assert.equal(credits.length, 2);
    assert.ok(credits.every((t) => t.category === 'order_refund'));
    assert.equal((await prisma.foodOrder.findUnique({ where: { id: offline.id } })).paymentStatus, 'refunded');
});

test('rejecting needs a note, tells the customer, and lets them ask again; mode and window are enforced', async () => {
    const order = await makeOrder(ctx.user.id, { total: 90 });
    const request = await createRefundRequest(ctx.user.id, order.id, { reason: 'Late' });
    await assert.rejects(() => rejectRefundRequest(request.id, null, {}), /Say why/);
    const rejected = await rejectRefundRequest(request.id, null, { note: 'Delivered on time per rider' });
    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.adminNote, 'Delivered on time per rider');
    await assert.rejects(() => approveRefundRequest(request.id, null, {}), /already rejected/);
    await assert.rejects(() => rejectRefundRequest(request.id, null, { note: 'x' }), /already rejected/);

    const mine = await listMyRefundRequests(ctx.user.id, { status: 'rejected' });
    assert.ok(mine.requests.some((r) => r.id === request.id && r.adminNote));
    const second = await createRefundRequest(ctx.user.id, order.id, { reason: 'Late, really' });
    assert.equal(second.status, 'pending');

    const old = await makeOrder(ctx.user.id, { deliveredAt: new Date(Date.now() - 30 * 3600 * 1000) });
    await assert.rejects(() => createRefundRequest(ctx.user.id, old.id, { reason: 'Old' }), /within 24 hours/);
    const preparing = await makeOrder(ctx.user.id, { orderStatus: 'preparing', deliveredAt: null });
    await assert.rejects(() => createRefundRequest(ctx.user.id, preparing.id, { reason: 'x' }), /once the order is delivered/);

    await set('business_refund', { refundRequestEnabled: false });
    await assert.rejects(() => createRefundRequest(ctx.user.id, old.id, { reason: 'x' }), /not available/);
    await set('business_refund', { refundRequestEnabled: true, requestWindowHours: 0 });
    const late = await createRefundRequest(ctx.user.id, old.id, { reason: 'Old but allowed' });
    assert.equal(late.status, 'pending');
});

test('the admin list filters by status, restaurant and search, and the detail carries the order', async () => {
    const pending = await listRefundRequestsAdmin({ status: 'pending', restaurantId: ctx.restaurant.id });
    assert.ok(pending.requests.length >= 2);
    assert.ok(pending.requests.every((r) => r.status === 'pending' && r.restaurant.id === ctx.restaurant.id));
    assert.ok(pending.counts.refunded >= 3, 'counts ignore the status filter');
    const one = pending.requests[0];
    const found = await listRefundRequestsAdmin({ search: one.orderDisplayId });
    assert.equal(found.requests[0].id, one.id);
    const detail = await getRefundRequestAdmin(one.id);
    assert.equal(detail.order.id, one.orderId);
    assert.ok(detail.order.pricing.total > 0);
    assert.equal(detail.customer.id, ctx.user.id);
    const today = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
    const dated = await listRefundRequestsAdmin({ from: today, to: today, restaurantId: ctx.restaurant.id });
    assert.equal(dated.pagination.total, pending.counts.all);
});

test('an order issue report is a support ticket with the reason and photos; the admin reply reaches the customer', async () => {
    const order = await makeOrder(ctx.user.id, { orderStatus: 'preparing', deliveredAt: null });
    await assert.rejects(() => createOrderIssue(ctx.user.id, order.id, {}), /from the list/);
    await assert.rejects(() => createOrderIssue(ctx.other.id, order.id, { reasonId: ctx.missingId }), /Order not found/);
    const pendingPay = await makeOrder(ctx.user.id, { orderStatus: 'pending_payment' });
    await assert.rejects(() => createOrderIssue(ctx.user.id, pendingPay.id, { reasonId: ctx.missingId }), /not been placed/);

    const issue = await createOrderIssue(ctx.user.id, order.order_id, { reasonId: ctx.missingId, note: 'No raita' });
    assert.equal(issue.reason, 'Item missing');
    assert.equal(issue.status, 'open');
    await assert.rejects(() => createOrderIssue(ctx.user.id, order.id, { reasonId: ctx.missingId }), /already reported/);

    const ticket = await prisma.foodSupportTicket.findUnique({ where: { id: issue.id } });
    assert.equal(ticket.type, 'order');
    assert.equal(ticket.restaurantId, ctx.restaurant.id);

    await updateSupportTicket(issue.id, { adminResponse: 'Refunded the raita', status: 'resolved' });
    const { issues } = await listMyOrderIssues(ctx.user.id, { orderRef: order.id });
    assert.equal(issues.length, 1);
    assert.equal(issues[0].status, 'resolved');
    assert.equal(issues[0].adminResponse, 'Refunded the raita');
    const inbox = await prisma.foodNotification.findMany({ where: { ownerId: ctx.user.id, title: 'Support Ticket Response' } });
    assert.equal(inbox.length, 1, 'one inbox entry per reply, not two');

    // Resolved, so a new problem can be reported.
    const next = await createOrderIssue(ctx.user.id, order.id, { reasonId: ctx.missingId });
    assert.equal(next.status, 'open');
    assert.equal((await listMyOrderIssues(ctx.user.id)).pagination.total, 2);
});
