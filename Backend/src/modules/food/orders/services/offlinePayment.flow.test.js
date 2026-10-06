import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../../config/prisma.js';
import { uniquePhone, uniqueTag } from '../../../../utils/testIds.js';
import { testPatch } from '../../../../utils/testGeo.js';
import {
    createOrder,
    listOrdersUser,
    listOrdersAdmin,
    listOrdersRestaurant,
    abandonOnlinePaymentOrder,
    verifyOfflinePaymentAdmin,
    rejectOfflinePaymentAdmin,
} from './order.service.js';
import { buildOfflinePaymentRecord, decideOfflinePayment } from './offlinePayment.util.js';
import { saveSystemSettings, getPublicOfflinePaymentMethods } from '../../admin/services/adminSystemExtras.service.js';
import { getSidebarBadges } from '../../admin/services/adminDashboard.service.js';

/**
 * Offline payment end to end: the admin sets up a method, the customer checks
 * out with it, and the admin verifies or rejects the payment. Through the real
 * entry points, like order.flow.test.js.
 */
const HERE = testPatch(31);
const AREA = 'offline_payment';

const created = { zones: [], restaurants: [], users: [], foods: [], categories: [] };
let restaurantId = null;
let userId = null;
let foodId = null;
let methodId = null;
let previous = null;

const settingsWith = (overrides = {}) => ({
    enabled: true,
    methods: [
        {
            ...(methodId ? { id: methodId } : {}),
            name: 'Bank transfer',
            paymentInfo: [{ label: 'Account number', value: '001122334455' }, { label: 'IFSC', value: 'TEST0000001' }],
            fields: [{ label: 'Transaction id', required: true }, { label: 'Paid from bank' }],
        },
        {
            name: 'Old UPI',
            isActive: false,
            paymentInfo: [{ label: 'UPI id', value: 'old@upi' }],
            fields: [{ label: 'UTR', required: true }],
        },
    ],
    ...overrides,
});

const cart = (offlinePayment) => ({
    restaurantId,
    items: [{ itemId: foodId, quantity: 1 }],
    address: {
        label: 'Home',
        fullName: 'Offline Customer',
        street: '1 Test Street',
        city: 'Indore',
        state: 'MP',
        zipCode: '452001',
        phone: uniquePhone('5'),
        latitude: HERE.lat,
        longitude: HERE.lng,
    },
    paymentMethod: 'offline',
    offlinePayment,
});

const placeOffline = async () => {
    const { order } = await createOrder(userId, cart({ methodId, fields: { transaction_id: 'TXN123456' } }));
    return order._id || order.id;
};

test.before(async () => {
    previous = await prisma.foodSystemSetting.findUnique({ where: { key: AREA } });
    const tag = uniqueTag('Offline');

    const zone = await prisma.foodZone.create({ data: { name: `${tag} Zone`, coordinates: HERE.ring, isActive: true } });
    created.zones.push(zone.id);
    const restaurant = await prisma.foodRestaurant.create({
        data: {
            restaurantName: `${tag} Kitchen`,
            ownerName: 'Owner',
            ownerPhone: uniquePhone('9'),
            status: 'approved',
            zoneId: zone.id,
            latitude: HERE.lat,
            longitude: HERE.lng,
            isAcceptingOrders: true,
            outsideHoursOverride: true,
        },
    });
    created.restaurants.push(restaurant.id);
    restaurantId = restaurant.id;
    const category = await prisma.foodCategory.create({ data: { name: `${tag} Mains`, restaurantId, approvalStatus: 'approved' } });
    created.categories.push(category.id);
    const food = await prisma.foodItem.create({
        data: {
            restaurantId,
            categoryId: category.id,
            categoryName: category.name,
            name: `${tag} Thali`,
            price: 300,
            approvalStatus: 'approved',
            isAvailable: true,
        },
    });
    created.foods.push(food.id);
    foodId = food.id;
    const user = await prisma.foodUser.create({ data: { name: `${tag} Customer`, phone: uniquePhone('5') } });
    created.users.push(user.id);
    userId = user.id;

    const saved = await saveSystemSettings(AREA, { value: settingsWith() });
    methodId = saved.value.methods[0].id;
});

test.after(async () => {
    const orders = await prisma.foodOrder.findMany({ where: { restaurantId: { in: created.restaurants } }, select: { id: true } });
    const ids = orders.map((o) => o.id);
    await prisma.foodTransaction.deleteMany({ where: { orderId: { in: ids } } });
    await prisma.orderItem.deleteMany({ where: { orderId: { in: ids } } });
    await prisma.orderStatusHistory.deleteMany({ where: { orderId: { in: ids } } });
    await prisma.foodOrder.deleteMany({ where: { id: { in: ids } } });
    await prisma.foodNotification.deleteMany({ where: { ownerId: { in: [...created.users, ...created.restaurants] } } });
    await prisma.foodItem.deleteMany({ where: { id: { in: created.foods } } });
    await prisma.foodCategory.deleteMany({ where: { id: { in: created.categories } } });
    await prisma.foodUser.deleteMany({ where: { id: { in: created.users } } });
    await prisma.foodRestaurant.deleteMany({ where: { id: { in: created.restaurants } } });
    await prisma.foodZone.deleteMany({ where: { id: { in: created.zones } } });
    if (previous) {
        await prisma.foodSystemSetting.update({ where: { key: AREA }, data: { value: previous.value } });
    } else {
        await prisma.foodSystemSetting.deleteMany({ where: { key: AREA } });
    }
    await prisma.$disconnect();
});

test('the record checks the method and the fields, and freezes the method', () => {
    const settings = {
        enabled: true,
        methods: [
            { id: 'a'.repeat(16), name: 'Bank', isActive: true, paymentInfo: [{ label: 'A/c', value: '1' }], fields: [{ key: 'txn', label: 'Txn', type: 'text', required: true }] },
            { id: 'b'.repeat(16), name: 'Off', isActive: false, paymentInfo: [], fields: [] },
        ],
    };
    const now = new Date('2026-10-06T10:00:00Z');
    const record = buildOfflinePaymentRecord(settings, { methodId: 'a'.repeat(16), fields: { txn: ' T1 ', junk: 'x' }, note: 'paid' }, now);
    assert.deepEqual(record, {
        status: 'pending',
        methodId: 'a'.repeat(16),
        methodName: 'Bank',
        paymentInfo: [{ label: 'A/c', value: '1' }],
        fields: [{ key: 'txn', label: 'Txn', value: 'T1' }],
        customerNote: 'paid',
        submittedAt: now.toISOString(),
    });
    assert.throws(() => buildOfflinePaymentRecord({ ...settings, enabled: false }, { methodId: 'a'.repeat(16) }), /not available/);
    assert.throws(() => buildOfflinePaymentRecord(settings, { methodId: 'b'.repeat(16) }), /not available/);
    assert.throws(() => buildOfflinePaymentRecord(settings, {}), /Choose an offline payment method/);
    assert.throws(() => buildOfflinePaymentRecord(settings, { methodId: 'a'.repeat(16), fields: {} }), /Txn is required/);

    assert.throws(() => decideOfflinePayment(record, 'rejected', { note: ' ' }), /Say why/);
    const verified = decideOfflinePayment(record, 'verified', { adminId: 'x', now });
    assert.equal(verified.status, 'verified');
    assert.equal(verified.decidedBy, 'x');
    assert.equal(verified.methodName, 'Bank');
});

test('checkout lists only active methods, and nothing while switched off', async () => {
    const listed = await getPublicOfflinePaymentMethods();
    assert.equal(listed.enabled, true);
    assert.deepEqual(listed.methods.map((m) => m.name), ['Bank transfer']);
    assert.deepEqual(listed.methods[0].fields.map((f) => [f.key, f.required]), [['transaction_id', true], ['paid_from_bank', false]]);

    await saveSystemSettings(AREA, { value: settingsWith({ enabled: false }) });
    assert.deepEqual(await getPublicOfflinePaymentMethods(), { enabled: false, methods: [] });
    await assert.rejects(() => placeOffline(), /Offline payment is not available/);
    await saveSystemSettings(AREA, { value: settingsWith() });
});

test('an offline order waits for the admin, visible to the customer and the admin only', async () => {
    await assert.rejects(() => createOrder(userId, cart({ methodId, fields: {} })), /Transaction id is required/);

    const id = await placeOffline();
    const row = await prisma.foodOrder.findUnique({ where: { id } });
    assert.equal(row.paymentMethod, 'offline');
    assert.equal(row.orderStatus, 'pending_payment');
    assert.equal(row.paymentStatus, 'created');
    assert.equal(row.offlinePayment.status, 'pending');
    assert.equal(row.offlinePayment.methodName, 'Bank transfer');
    assert.deepEqual(row.offlinePayment.fields, [{ key: 'transaction_id', label: 'Transaction id', value: 'TXN123456' }]);
    // No ledger row until the money is confirmed.
    assert.equal(await prisma.foodTransaction.count({ where: { orderId: id } }), 0);

    const mine = await listOrdersUser(userId, {});
    assert.ok(mine.data.some((o) => (o._id || o.id) === id), 'the customer sees it');
    const tab = await listOrdersAdmin({ status: 'offline-payments', limit: 100, search: row.order_id });
    assert.ok(tab.orders.some((o) => (o._id || o.id) === id), 'it is in the Offline Payments tab');
    const all = await listOrdersAdmin({ status: 'all', limit: 100, search: row.order_id });
    assert.ok(all.orders.some((o) => (o._id || o.id) === id), 'and in All orders');
    const kitchen = await listOrdersRestaurant(restaurantId, {});
    assert.ok(!kitchen.data.some((o) => (o._id || o.id) === id), 'the restaurant does not see it yet');

    const badges = await getSidebarBadges();
    assert.ok(badges.offlinePayments >= 1);

    // The customer cannot throw it away; they may already have paid.
    await assert.rejects(() => abandonOnlinePaymentOrder(userId, id), /being verified/);
});

test('verifying sends the order to the restaurant as a paid order, once', async () => {
    const id = await placeOffline();
    const order = await verifyOfflinePaymentAdmin(id, null, 'Seen in bank statement');
    assert.equal(order.orderStatus, 'created');

    const row = await prisma.foodOrder.findUnique({ where: { id } });
    assert.equal(row.paymentStatus, 'paid');
    assert.equal(row.offlinePayment.status, 'verified');
    assert.equal(row.offlinePayment.adminNote, 'Seen in bank statement');
    assert.ok(row.acceptanceDeadlineAt, 'the restaurant acceptance timer runs');

    const tx = await prisma.foodTransaction.findUnique({ where: { orderId: id } });
    assert.ok(tx, 'the ledger row is written');
    assert.equal(tx.paymentMethod, 'offline');
    assert.equal(tx.status, 'captured');

    const kitchen = await listOrdersRestaurant(restaurantId, {});
    assert.ok(kitchen.data.some((o) => (o._id || o.id) === id), 'the restaurant sees it now');

    await assert.rejects(() => verifyOfflinePaymentAdmin(id, null), /already been verified or rejected/);
    await assert.rejects(() => rejectOfflinePaymentAdmin(id, null, 'late'), /already been verified or rejected/);
});

test('rejecting fails the payment and cancels the order, with a reason', async () => {
    const id = await placeOffline();
    await assert.rejects(() => rejectOfflinePaymentAdmin(id, null, ''), /Say why/);

    const order = await rejectOfflinePaymentAdmin(id, null, 'No such transaction');
    assert.equal(order.orderStatus, 'cancelled_by_admin');
    const row = await prisma.foodOrder.findUnique({ where: { id } });
    assert.equal(row.paymentStatus, 'failed');
    assert.equal(row.offlinePayment.status, 'rejected');
    assert.equal(row.offlinePayment.adminNote, 'No such transaction');
    assert.equal(await prisma.foodTransaction.count({ where: { orderId: id } }), 0);

    await assert.rejects(() => verifyOfflinePaymentAdmin(id, null), /already been verified or rejected/);
});

test('only offline orders can be verified', async () => {
    const { order } = await createOrder(userId, { ...cart(undefined), paymentMethod: 'cash' });
    await assert.rejects(() => verifyOfflinePaymentAdmin(order._id || order.id, null), /not paid offline/);
});
