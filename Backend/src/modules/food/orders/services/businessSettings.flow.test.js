import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../../config/prisma.js';
import { uniquePhone, uniqueTag } from '../../../../utils/testIds.js';
import { testPatch } from '../../../../utils/testGeo.js';
import { calculateOrder, createOrder, updateOrderStatusRestaurant } from './order.service.js';
import { acceptOrderDelivery, listActiveDeliveries, rejectOrderDelivery } from './order-delivery.service.js';
import { getBusyDeliveryPartnerIds } from './order.helpers.js';
import { saveSystemSettings, getPublicBusinessSettings, getPublicReasons } from '../../admin/services/adminSystemExtras.service.js';
import { invalidateBusinessSettings } from '../../shared/businessSettings.js';
import { createWalletTopupOrder } from '../../user/services/userWallet.service.js';
import { runScheduledRiderDisbursement, RUN_KEY_PREFIX } from '../../admin/services/riderDisbursementSchedule.service.js';

/**
 * Business Settings obeyed by the real entry points: order placement and
 * pricing, the rider order limit, restaurant cancelling, wallet top-up and the
 * scheduled rider disbursement.
 *
 * The settings are global rows in food_system_settings, so every test sets
 * what it needs through the admin save path and the after hook removes them,
 * leaving the defaults for every other test file.
 */
const HERE = testPatch(27);
const AREAS = ['business_info', 'business_deliveryman', 'business_order', 'business_vendor', 'business_customer',
    'business_payment', 'business_refund', 'business_priority', 'business_disbursement', 'business_order_issue_reasons', 'website'];

const created = { zones: [], restaurants: [], users: [], foods: [], categories: [], fees: [], partners: [], orders: [], batches: [] };
const ctx = {};

const set = (area, value) => saveSystemSettings(area, { value });
const resetSettings = async () => {
    await prisma.foodSystemSetting.deleteMany({ where: { key: { in: AREAS } } });
    invalidateBusinessSettings();
};

const makeUser = async () => {
    const user = await prisma.foodUser.create({ data: { name: 'Settings Tester', phone: uniquePhone('5') } });
    created.users.push(user.id);
    return user.id;
};

const address = () => ({
    label: 'Home', fullName: 'Settings Tester', street: '1 Test Street', city: 'Indore', state: 'MP',
    zipCode: '452001', phone: uniquePhone('5'), latitude: HERE.lat, longitude: HERE.lng,
});

const cart = (extra = {}) => ({
    restaurantId: ctx.restaurantId,
    items: [{ itemId: ctx.foodId, quantity: 2 }],
    address: address(),
    deliveryAddress: address(),
    paymentMethod: 'cash',
    ...extra,
});

const place = async (userId, extra = {}) => {
    const quote = await calculateOrder(userId, cart(extra));
    const { order } = await createOrder(userId, cart({ ...extra, pricing: quote.pricing }));
    created.orders.push(order.id);
    return { quote, order, row: await prisma.foodOrder.findUnique({ where: { id: order.id } }) };
};

const makePartner = async (extra = {}) => {
    const partner = await prisma.foodDeliveryPartner.create({
        data: { name: `Settings Rider ${uniqueTag('r')}`, phone: uniquePhone('7'), status: 'approved', ...extra },
    });
    created.partners.push(partner.id);
    return partner;
};

/** An order ready for a rider to accept, made directly. */
const makeDispatchableOrder = async (userId, extra = {}) => {
    const order = await prisma.foodOrder.create({
        data: {
            userId, restaurantId: ctx.restaurantId, orderStatus: 'confirmed', dispatchStatus: 'unassigned',
            paymentMethod: 'razorpay', paymentStatus: 'paid',
            addrStreet: '1 Test Street', addrCity: 'Indore', addrState: 'MP',
            subtotal: 500, total: 540, riderEarning: 25, ...extra,
        },
    });
    created.orders.push(order.id);
    return order;
};

test.before(async () => {
    await resetSettings();
    const tag = uniqueTag('Biz');
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
            name: `${tag} Thali`, price: 250, approvalStatus: 'approved', isAvailable: true,
        },
    });
    created.foods.push(food.id);
    ctx.foodId = food.id;
    const fee = await prisma.foodFeeSettings.create({
        data: {
            zoneId: zone.id, isActive: true, deliveryFee: 40, platformFee: 0, platformFeeEnabled: false,
            gstRate: 0, gstEnabled: false, deliveryFeeGstRate: 18, deliveryFeeGstEnabled: true,
            deliveryFeeBands: { create: [{ minDistanceKm: 0, maxDistanceKm: 50, fee: 40, deliveryBoyBasePay: 25 }] },
        },
    });
    created.fees.push(fee.id);
});

test.after(async () => {
    await resetSettings();
    const ids = created.orders;
    await prisma.foodTransaction.deleteMany({ where: { orderId: { in: ids } } });
    await prisma.orderItem.deleteMany({ where: { orderId: { in: ids } } });
    await prisma.orderStatusHistory.deleteMany({ where: { orderId: { in: ids } } });
    await prisma.orderDispatchOffer.deleteMany({ where: { orderId: { in: ids } } }).catch(() => {});
    await prisma.foodOrder.deleteMany({ where: { id: { in: ids } } });
    await prisma.foodDeliveryWithdrawal.deleteMany({ where: { deliveryPartnerId: { in: created.partners } } });
    await prisma.foodDeliveryPayoutBatch.deleteMany({ where: { id: { in: created.batches } } });
    await prisma.transaction.deleteMany({ where: { entityType: 'deliveryBoy', entityId: { in: created.partners } } });
    await prisma.wallet.deleteMany({ where: { entityType: 'deliveryBoy', entityId: { in: created.partners } } });
    await prisma.foodSystemSetting.deleteMany({ where: { key: { startsWith: RUN_KEY_PREFIX } } });
    await prisma.foodDeliveryPartner.deleteMany({ where: { id: { in: created.partners } } });
    await prisma.foodFeeSettings.deleteMany({ where: { id: { in: created.fees } } });
    await prisma.foodItem.deleteMany({ where: { id: { in: created.foods } } });
    await prisma.foodCategory.deleteMany({ where: { id: { in: created.categories } } });
    await prisma.foodUser.deleteMany({ where: { id: { in: created.users } } });
    await prisma.foodRestaurant.deleteMany({ where: { id: { in: created.restaurants } } });
    await prisma.foodZone.deleteMany({ where: { id: { in: created.zones } } });
    await prisma.$disconnect();
});

test('a rider holds up to the maximum assigned order limit, and no more', async () => {
    await resetSettings();
    const userId = await makeUser();
    const rider = await makePartner();
    const [a, b, c] = [await makeDispatchableOrder(userId), await makeDispatchableOrder(userId), await makeDispatchableOrder(userId)];

    // Default limit is 2.
    await acceptOrderDelivery(a.id, rider.id);
    assert.equal((await getBusyDeliveryPartnerIds()).has(rider.id), false, 'one of two: still offered orders');
    await acceptOrderDelivery(b.id, rider.id);
    assert.equal((await getBusyDeliveryPartnerIds()).has(rider.id), true, 'at the limit: dispatch skips them');
    await assert.rejects(() => acceptOrderDelivery(c.id, rider.id), /2 active deliveries/);

    // Accepting one already held is a no-op, whatever the limit.
    const again = await acceptOrderDelivery(a.id, rider.id);
    assert.ok(again);

    // A limit of 1 behaves exactly as before the setting existed.
    await set('business_deliveryman', { maxAssignedOrders: 1 });
    const solo = await makePartner();
    const [d, e] = [await makeDispatchableOrder(userId), await makeDispatchableOrder(userId)];
    await acceptOrderDelivery(d.id, solo.id);
    await assert.rejects(() => acceptOrderDelivery(e.id, solo.id), /You already have an active delivery/);

    // Delivering one frees a slot.
    await set('business_deliveryman', { maxAssignedOrders: 2 });
    await prisma.foodOrder.update({ where: { id: a.id }, data: { orderStatus: 'delivered' } });
    await acceptOrderDelivery(c.id, rider.id);
    const held = await prisma.foodOrder.count({ where: { dispatchDeliveryPartnerId: rider.id, dispatchStatus: 'accepted', orderStatus: 'confirmed' } });
    assert.equal(held, 2);
});

test('the rider app gets every delivery it holds and the live limit', async () => {
    await resetSettings();
    const userId = await makeUser();
    const rider = await makePartner();
    const [a, b] = [await makeDispatchableOrder(userId), await makeDispatchableOrder(userId)];

    let active = await listActiveDeliveries(rider.id);
    assert.deepEqual([active.orders.length, active.orderLimit, active.canAcceptMore], [0, 2, true]);

    await acceptOrderDelivery(a.id, rider.id);
    await acceptOrderDelivery(b.id, rider.id);
    active = await listActiveDeliveries(rider.id);
    assert.equal(active.orders.length, 2);
    assert.deepEqual(new Set(active.orders.map((o) => String(o.id || o._id))), new Set([a.id, b.id]));
    assert.equal(active.canAcceptMore, false);

    // The limit is the admin's setting, read live.
    await set('business_deliveryman', { maxAssignedOrders: 3 });
    active = await listActiveDeliveries(rider.id);
    assert.deepEqual([active.orderLimit, active.canAcceptMore], [3, true]);
    await resetSettings();
});

test('a rider may decline an offer, but cancels an accepted order only when the admin allows it', async () => {
    await resetSettings();
    const userId = await makeUser();
    const rider = await makePartner();

    // An offer (assigned, not accepted) can always be declined.
    const offered = await makeDispatchableOrder(userId, { dispatchStatus: 'assigned', dispatchDeliveryPartnerId: rider.id });
    await rejectOrderDelivery(offered.id, rider.id);
    assert.equal((await prisma.foodOrder.findUnique({ where: { id: offered.id } })).dispatchStatus, 'unassigned');

    // Accepted: refused while the switch is off (the default).
    const held = await makeDispatchableOrder(userId);
    await acceptOrderDelivery(held.id, rider.id);
    await assert.rejects(() => rejectOrderDelivery(held.id, rider.id, { reason: 'Bike broke' }), /turned off/);
    assert.equal((await prisma.foodOrder.findUnique({ where: { id: held.id } })).dispatchDeliveryPartnerId, rider.id);

    // Switched on: the order goes back for re-assignment, with the reason recorded.
    await set('business_deliveryman', { riderCanCancelOrder: true });
    await rejectOrderDelivery(held.id, rider.id, { reason: 'Bike broke' });
    const after = await prisma.foodOrder.findUnique({ where: { id: held.id } });
    assert.equal(after.dispatchDeliveryPartnerId, null);
    assert.equal(after.dispatchStatus, 'unassigned');
    const history = await prisma.orderStatusHistory.findMany({ where: { orderId: held.id } });
    assert.ok(history.some((h) => /Cancelled by delivery partner: Bike broke/.test(h.note)), 'the reason is recorded');

    // Never after pickup, whatever the switch says.
    const picked = await makeDispatchableOrder(userId);
    await acceptOrderDelivery(picked.id, rider.id);
    await prisma.foodOrder.update({ where: { id: picked.id }, data: { orderStatus: 'picked_up', pickedUpAt: new Date() } });
    await assert.rejects(() => rejectOrderDelivery(picked.id, rider.id), /already been picked up/);
    await resetSettings();
});

test('two accepts racing from one rider cannot pass the limit', async () => {
    await resetSettings();
    await set('business_deliveryman', { maxAssignedOrders: 1 });
    const userId = await makeUser();
    const rider = await makePartner();
    const orders = [await makeDispatchableOrder(userId), await makeDispatchableOrder(userId), await makeDispatchableOrder(userId)];
    const results = await Promise.allSettled(orders.map((o) => acceptOrderDelivery(o.id, rider.id)));
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    const held = await prisma.foodOrder.count({ where: { dispatchDeliveryPartnerId: rider.id, dispatchStatus: 'accepted' } });
    assert.equal(held, 1);
});

test('maintenance, payment switches and scheduled orders refuse at placement', async () => {
    await resetSettings();
    const userId = await makeUser();

    await set('website', { maintenanceMode: true, maintenanceMessage: 'Back at 6 pm' });
    await assert.rejects(() => createOrder(userId, cart()), /Back at 6 pm/);
    await set('website', { maintenanceMode: false });

    await set('business_payment', { cod: false, digital: true });
    await assert.rejects(() => createOrder(userId, cart()), /Cash on Delivery is not available/);
    await set('business_payment', { cod: true, digital: false });
    await assert.rejects(() => createOrder(userId, cart({ paymentMethod: 'razorpay' })), /Online payment is not available/);
    await set('business_customer', { walletEnabled: false });
    await assert.rejects(() => createOrder(userId, cart({ paymentMethod: 'wallet' })), /Wallet payment is not available/);
    await set('business_payment', {});

    const later = new Date(Date.now() + 3 * 3600 * 1000).toISOString();
    await assert.rejects(() => createOrder(userId, cart({ scheduledAt: later })), /Scheduled orders are not available/);

    const pub = await getPublicBusinessSettings();
    assert.equal(pub.payment.cod, true);
    assert.equal(pub.payment.wallet, false);
    assert.equal(pub.order.scheduledOrder, false);
    assert.equal(pub.maintenance.maintenanceMode, false);
    assert.equal(pub.rider.maxAssignedOrders, 2);
});

test('free delivery over an amount, percentage rider pay and the default commission', async () => {
    await resetSettings();
    await set('business_order', { freeDelivery: { enabled: true, minSubtotal: 400 } });
    await set('business_info', { riderPayMode: 'percentage', deliveryChargeCommissionPercent: 20, defaultCommissionPercent: 15 });
    const userId = await makeUser();

    const { quote, row } = await place(userId);
    assert.equal(quote.pricing.subtotal, 500);
    assert.equal(quote.pricing.deliveryFee, 0);
    assert.equal(quote.pricing.freeDeliveryWaived, 47.2, 'fee 40 + 18% GST');
    assert.equal(quote.pricing.deliveryFeeWaived, 0, 'not a coupon waiver');
    assert.equal(Number(row.deliveryFee), 0);
    assert.equal(Number(row.freeDeliveryWaiver), 47.2);
    assert.equal(Number(row.riderEarning), 32, '80% of the 40 fee, waived or not');
    assert.equal(Number(row.restaurantCommission), 75, '15% default on a restaurant with no commission row');
    const tx = await prisma.foodTransaction.findUnique({ where: { orderId: row.id } });
    assert.equal(Number(tx.riderShare), 32);
    assert.equal(Number(tx.platformNetProfit), 75 - 32, 'commission less rider pay; no fee was charged');

    // Below the threshold and in band mode: charged, rider paid the band.
    await set('business_info', { defaultCommissionPercent: 0 });
    const small = await place(userId, { items: [{ itemId: ctx.foodId, quantity: 1 }] });
    assert.equal(Number(small.row.deliveryFee), 40);
    assert.equal(Number(small.row.freeDeliveryWaiver), 0);
    assert.equal(Number(small.row.riderEarning), 25);
    assert.equal(Number(small.row.restaurantCommission), 0);
});

test('the new customer discount applies once, on the first order, at the platform\'s cost', async () => {
    await resetSettings();
    await set('business_customer', { newCustomerDiscount: { enabled: true, type: 'amount', value: 100, validityDays: 30 } });
    const userId = await makeUser();

    const first = await place(userId);
    assert.equal(first.quote.pricing.newCustomerDiscount, 100);
    assert.equal(first.quote.pricing.discount, 100);
    assert.equal(Number(first.row.newCustomerDiscount), 100);
    assert.equal(Number(first.row.total), 500 - 100 + 47.2);
    const tx = await prisma.foodTransaction.findUnique({ where: { orderId: first.row.id } });
    assert.equal(Number(tx.adminDiscountShare), 100);
    assert.equal(Number(tx.restaurantDiscountShare), 0);

    const second = await place(userId);
    assert.equal(second.quote.pricing.newCustomerDiscount, 0);
    assert.equal(Number(second.row.discount), 0);
});

test('a restaurant cannot cancel an accepted order unless allowed', async () => {
    await resetSettings();
    const userId = await makeUser();
    const order = await makeDispatchableOrder(userId, { paymentMethod: 'cash', paymentStatus: 'cod_pending' });
    await assert.rejects(
        () => updateOrderStatusRestaurant(order.id, ctx.restaurantId, 'cancelled_by_restaurant', ''),
        /already accepted/,
    );
    await set('business_vendor', { restaurantCanCancelOrder: true });
    const done = await updateOrderStatusRestaurant(order.id, ctx.restaurantId, 'cancelled_by_restaurant', '');
    assert.equal(done.orderStatus, 'cancelled_by_restaurant');
});

test('wallet top-up follows the add fund switch', async () => {
    await resetSettings();
    const userId = await makeUser();
    await assert.rejects(() => createWalletTopupOrder(userId, 100), /not available/);
    await set('business_customer', { addFundEnabled: true });
    const res = await createWalletTopupOrder(userId, 100);
    assert.ok(res);
});

test('reason lists reach the apps, active ones only', async () => {
    await resetSettings();
    await set('business_refund', { reasons: [{ text: 'Food was cold' }, { text: 'Hidden', isActive: false }] });
    const { reasons } = await getPublicReasons('business_refund');
    assert.deepEqual(reasons.map((r) => r.text), ['Food was cold']);
    assert.match(reasons[0].id, /^[a-f0-9]{12}$/);
});

test('the scheduled rider disbursement runs once a day and holds back recent earnings', async () => {
    await resetSettings();
    await set('business_disbursement', { rider: { enabled: true, runTime: '00:00', minAmount: 1, waitingDays: 1 } });
    const userId = await makeUser();

    const settled = await makePartner({ upiId: 'settled@upi' });
    await prisma.wallet.create({ data: { entityType: 'deliveryBoy', entityId: settled.id, balance: 300, totalEarnings: 300 } });
    // Earned only on an order placed today: inside the waiting days.
    const recent = await makePartner({ upiId: 'recent@upi' });
    await makeDispatchableOrder(userId, {
        orderStatus: 'delivered', dispatchStatus: 'accepted', dispatchDeliveryPartnerId: recent.id, riderEarning: 200,
    });

    const now = new Date();
    const first = await runScheduledRiderDisbursement({ now });
    assert.equal(first.created, true, JSON.stringify(first));
    created.batches.push(first.batch.id);
    const lines = await prisma.foodDeliveryWithdrawal.findMany({ where: { batchId: first.batch.id } });
    assert.equal(lines.find((l) => l.deliveryPartnerId === settled.id)?.amount?.toString(), '300');
    assert.equal(lines.find((l) => l.deliveryPartnerId === recent.id), undefined, 'held back');

    const second = await runScheduledRiderDisbursement({ now });
    assert.equal(second.created, false);
    assert.match(second.reason, /already ran/);

    await set('business_disbursement', { rider: { enabled: false } });
    assert.equal((await runScheduledRiderDisbursement({ now })).reason, 'not due');
});
