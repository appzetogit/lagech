import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../../config/prisma.js';
import { uniquePhone, uniqueTag } from '../../../../utils/testIds.js';
import { testPatch } from '../../../../utils/testGeo.js';
import {
    calculateOrder,
    createOrder,
    finalizeOrderPayment,
    updateOrderStatusRestaurant,
    handoverTakeawayRestaurant,
    listOrdersRestaurant,
    getOrderById,
    expireUnacceptedOrderById,
    assignDeliveryPartnerAdmin,
} from './order.service.js';
import { acceptOrderDelivery } from './order-delivery.service.js';
import { tryAutoAssign } from './order-dispatch.service.js';
import { getRestaurantOrderOptions, releaseScheduledOrders } from './order-scheduling.service.js';
import { saveSystemSettings, getPublicBusinessSettings } from '../../admin/services/adminSystemExtras.service.js';
import { invalidateBusinessSettings } from '../../shared/businessSettings.js';
import { getOrderMoneyReport } from '../../admin/services/adminOrderMoneyReport.service.js';
import { getDeliveryPartnerEarnings } from '../../delivery/services/delivery.service.js';

/**
 * Scheduled orders, takeaway and rider tips through the real entry points:
 * pricing, placement, the restaurant's flow, dispatch, the scheduled release,
 * the ledger, rider earnings and the Transaction report -- and that with every
 * switch off an order is exactly what it was before they existed.
 *
 * Money in every case: 2 x 250 = 500 of food, delivery fee 40 + 18% GST (7.2),
 * no item GST, no platform fee, 15% default commission (75), rider band pay 25.
 */
const HERE = testPatch(23);
const AREAS = ['business_info', 'business_deliveryman', 'business_order', 'business_vendor', 'business_customer',
    'business_payment', 'website'];

const created = { zones: [], restaurants: [], users: [], foods: [], categories: [], fees: [], partners: [], orders: [] };
const ctx = {};
const today = new Date().toISOString().slice(0, 10);

const set = (area, value) => saveSystemSettings(area, { value });
const resetSettings = async () => {
    await prisma.foodSystemSetting.deleteMany({ where: { key: { in: AREAS } } });
    invalidateBusinessSettings();
};
const close = (actual, expected, label) => assert.ok(Math.abs(Number(actual) - Number(expected)) < 0.005, `${label}: ${actual} != ${expected}`);

const makeUser = async () => {
    const user = await prisma.foodUser.create({ data: { name: 'Modes Tester', phone: uniquePhone('5') } });
    created.users.push(user.id);
    return user.id;
};

const address = () => ({
    label: 'Home', fullName: 'Modes Tester', street: '1 Test Street', city: 'Indore', state: 'MP',
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
    const result = await createOrder(userId, cart({ ...extra, pricing: quote.pricing }));
    created.orders.push(result.order.id);
    return { quote, order: result.order, row: await prisma.foodOrder.findUnique({ where: { id: result.order.id } }) };
};

/** An online order, paid the way the gateway webhook confirms it. */
const placePaid = async (userId, extra = {}) => {
    const placed = await place(userId, { paymentMethod: 'razorpay', ...extra });
    assert.equal(placed.row.orderStatus, 'pending_payment');
    await prisma.foodOrder.update({ where: { id: placed.row.id }, data: { paymentStatus: 'paid' } });
    await finalizeOrderPayment(placed.row.id);
    return { ...placed, row: await prisma.foodOrder.findUnique({ where: { id: placed.row.id } }) };
};

const makePartner = async () => {
    const partner = await prisma.foodDeliveryPartner.create({
        data: { name: `Modes Rider ${uniqueTag('r')}`, phone: uniquePhone('7'), status: 'approved' },
    });
    created.partners.push(partner.id);
    return partner;
};

const deliver = (id, extra = {}) => prisma.foodOrder.update({
    where: { id },
    data: { orderStatus: 'delivered', deliveryPhase: 'delivered', deliveredAt: new Date(), ...extra },
});

const reportRows = async () => {
    const report = await getOrderMoneyReport({ restaurantId: ctx.restaurantId, status: 'delivered', from: today, to: today, limit: 500 });
    return { report, byId: new Map(report.orders.map((row) => [row.id, row])) };
};

test.before(async () => {
    await resetSettings();
    const tag = uniqueTag('Modes');
    const zone = await prisma.foodZone.create({ data: { name: `${tag} Zone`, coordinates: HERE.ring, isActive: true } });
    created.zones.push(zone.id);
    const restaurant = await prisma.foodRestaurant.create({
        data: {
            restaurantName: `${tag} Kitchen`, ownerName: 'Owner', ownerPhone: uniquePhone('9'),
            status: 'approved', zoneId: zone.id, latitude: HERE.lat, longitude: HERE.lng,
            addressLine1: '5 Market Road', city: 'Indore', state: 'MP',
            isAcceptingOrders: true,
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
    await prisma.foodTransactionHistory.deleteMany({ where: { transaction: { orderId: { in: ids } } } }).catch(() => {});
    await prisma.foodTransaction.deleteMany({ where: { orderId: { in: ids } } });
    await prisma.orderItem.deleteMany({ where: { orderId: { in: ids } } });
    await prisma.orderStatusHistory.deleteMany({ where: { orderId: { in: ids } } });
    await prisma.orderDispatchOffer.deleteMany({ where: { orderId: { in: ids } } }).catch(() => {});
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

// ─── All three switches off ──────────────────────────────────────────────────

test('switches off: an order is exactly what it was before these features', async () => {
    await resetSettings();
    const userId = await makeUser();
    const { quote, row } = await place(userId);

    assert.equal(quote.pricing.orderType, 'delivery');
    assert.equal(quote.pricing.riderTip, 0);
    close(quote.pricing.total, 547.2, 'quote total');
    assert.equal(row.orderType, 'delivery');
    close(row.riderTip, 0, 'riderTip');
    assert.equal(row.releaseAt, null);
    assert.equal(row.deliveryOtp, '', 'no code until a rider picks up');
    close(row.total, 547.2, 'total');
    close(row.deliveryFee, 40, 'fee');
    close(row.deliveryFeeGst, 7.2, 'fee GST');
    close(row.riderEarning, 25, 'rider band pay');
    assert.ok(row.restaurantNotifiedAt, 'the restaurant is alerted at once');
    const window = row.acceptanceDeadlineAt.getTime() - row.createdAt.getTime();
    const expected = row.acceptanceWindowSeconds * 1000;
    assert.ok(Math.abs(window - expected) < 10 * 1000, `acceptance window from placement (${window} ms)`);

    const tx = await prisma.foodTransaction.findUnique({ where: { orderId: row.id } });
    close(tx.riderShare, 25, 'riderShare');
    close(tx.riderTip, 0, 'tx riderTip');
    close(tx.platformNetProfit, 40 + 7.2 + 75 - 25, 'platform net');
    close(tx.restaurantShare, 425, 'restaurant share');

    // Each feature refuses while off.
    await assert.rejects(() => createOrder(userId, cart({ riderTip: 20 })), /Tips are not available/);
    await assert.rejects(() => calculateOrder(userId, cart({ riderTip: 20 })), /Tips are not available/);
    await assert.rejects(() => createOrder(userId, cart({ orderType: 'takeaway', paymentMethod: 'razorpay' })), /Takeaway is not available/);
    const later = new Date(Date.now() + 3 * 3600 * 1000).toISOString();
    await assert.rejects(() => createOrder(userId, cart({ scheduledAt: later })), /Scheduled orders are not available/);

    const options = await getRestaurantOrderOptions(ctx.restaurantId);
    assert.deepEqual(options.orderTypes, { delivery: true, takeaway: false });
    assert.equal(options.schedule.enabled, false);
    assert.equal(options.tips.enabled, false);
    const pub = await getPublicBusinessSettings();
    assert.equal(pub.tips.enabled, false);
    assert.equal(pub.order.takeaway, false);
});

// ─── Rider tips ──────────────────────────────────────────────────────────────

test('tips: added to the total, all of it the rider\'s, nothing to the platform or restaurant', async () => {
    await resetSettings();
    await set('business_deliveryman', { tipsEnabled: true });
    const userId = await makeUser();

    await assert.rejects(() => createOrder(userId, cart({ riderTip: 501 })), /at most ₹500/);

    const plain = await place(userId);
    const tipped = await place(userId, { riderTip: 50 });
    close(tipped.quote.pricing.riderTip, 50, 'quoted tip');
    close(tipped.quote.pricing.total, 597.2, 'quoted total includes the tip');
    close(tipped.row.total, 597.2, 'charged total');
    close(tipped.row.riderTip, 50, 'tip column');
    close(tipped.row.riderEarning, 75, 'band pay 25 + tip 50');

    const [txPlain, txTip] = await Promise.all([
        prisma.foodTransaction.findUnique({ where: { orderId: plain.row.id } }),
        prisma.foodTransaction.findUnique({ where: { orderId: tipped.row.id } }),
    ]);
    close(txTip.riderShare, 75, 'riderShare includes the tip');
    close(txTip.riderTip, 50, 'tx tip');
    close(txTip.platformNetProfit, txPlain.platformNetProfit, 'platform net unchanged by a tip');
    close(txTip.restaurantShare, txPlain.restaurantShare, 'restaurant share unchanged by a tip');
    close(txTip.commissionAmount, txPlain.commissionAmount, 'commission unchanged by a tip');
    close(tipped.row.platformProfit, plain.row.platformProfit, 'order platformProfit unchanged by a tip');

    // The rider who delivers it sees the tip in their earnings.
    const rider = await makePartner();
    await updateOrderStatusRestaurant(tipped.row.id, ctx.restaurantId, 'confirmed');
    await acceptOrderDelivery(tipped.row.id, rider.id);
    await deliver(tipped.row.id);
    const earnings = await getDeliveryPartnerEarnings(rider.id, { period: 'all' });
    close(earnings.summary.totalEarnings, 75, 'rider earnings include the tip');
    close(earnings.summary.tips, 50, 'of which tips');

    // Transaction report: its own Tip column, and the order still reconciles.
    await deliver(plain.row.id);
    const { byId } = await reportRows();
    const t = byId.get(tipped.row.id);
    const p = byId.get(plain.row.id);
    close(t.riderTip, 50, 'report tip');
    close(t.deliverymanEarning, 75, 'report rider incl. tip');
    close(t.commissionOnDeliveryCharge, 15, 'fee 40 - trip pay 25; the tip is not from the fee');
    close(t.adminNetIncome, p.adminNetIncome, 'admin income excludes the tip');
    close(t.storeNetIncome, p.storeNetIncome, 'restaurant income excludes the tip');
    close(t.orderAmount, t.storeNetIncome + t.adminNetIncome + t.deliverymanEarning + t.vatTax, 'tipped order reconciles');
    close(p.riderTip, 0, 'no tip on the plain order');
    close(p.orderAmount, p.storeNetIncome + p.adminNetIncome + p.deliverymanEarning + p.vatTax, 'plain order reconciles');
    close(t.adminNetIncome,
        t.adminCommission + t.commissionOnDeliveryCharge + t.additionalCharge + t.deliveryChargeGst - t.adminDiscount,
        'admin net decomposes');
    await resetSettings();
});

// ─── Takeaway ────────────────────────────────────────────────────────────────

test('takeaway: no delivery fee or rider, paid in the app, handed over against the pickup code', async () => {
    await resetSettings();
    await set('business_order', { takeaway: true });
    await set('business_deliveryman', { tipsEnabled: true });
    const userId = await makeUser();

    await assert.rejects(() => createOrder(userId, cart({ orderType: 'takeaway' })), /paid in the app/);
    await assert.rejects(() => createOrder(userId, cart({ orderType: 'takeaway', paymentMethod: 'razorpay', riderTip: 20 })), /no delivery partner/);

    const quote = await calculateOrder(userId, cart({ orderType: 'takeaway' }));
    close(quote.pricing.deliveryFee, 0, 'no delivery fee');
    close(quote.pricing.deliveryFeeGst, 0, 'no delivery GST');
    close(quote.pricing.total, 500, 'food only');

    // No address needed: the restaurant's is recorded.
    const { address: _ignored, ...noAddress } = cart({ orderType: 'takeaway', paymentMethod: 'razorpay' });
    const result = await createOrder(userId, { ...noAddress, pricing: quote.pricing });
    created.orders.push(result.order.id);
    assert.match(result.order.pickupCode, /^\d{4}$/);
    await prisma.foodOrder.update({ where: { id: result.order.id }, data: { paymentStatus: 'paid' } });
    await finalizeOrderPayment(result.order.id);
    const row = await prisma.foodOrder.findUnique({ where: { id: result.order.id } });
    assert.equal(row.orderType, 'takeaway');
    assert.equal(row.orderStatus, 'created');
    assert.equal(row.addrStreet, '5 Market Road');
    close(row.total, 500, 'total');
    close(row.deliveryFee, 0, 'fee');
    close(row.riderEarning, 0, 'no rider pay');
    close(row.restaurantCommission, 75, 'commission still applies');
    const code = row.deliveryOtp;

    // The customer sees the code; the restaurant never does.
    const mine = await getOrderById(row.id, { userId });
    assert.equal(mine.pickupCode, code);
    const list = await listOrdersRestaurant(ctx.restaurantId, { limit: 50 });
    const listed = list.orders.find((o) => String(o.id || o._id) === row.id);
    assert.ok(listed, 'the restaurant lists it');
    assert.equal(listed.orderType, 'takeaway');
    assert.equal(listed.deliveryOtp, undefined);
    const detail = await getOrderById(row.id, { restaurantId: ctx.restaurantId });
    assert.equal(detail.deliveryOtp, undefined);

    // Accepting dispatches nobody; no rider can take it, nor the admin assign one.
    await updateOrderStatusRestaurant(row.id, ctx.restaurantId, 'confirmed');
    assert.equal(await tryAutoAssign(row.id), null);
    const rider = await makePartner();
    await assert.rejects(() => acceptOrderDelivery(row.id, rider.id), /takeaway order/);
    await assert.rejects(() => assignDeliveryPartnerAdmin(row.id, rider.id, null), /no delivery partner/);
    await updateOrderStatusRestaurant(row.id, ctx.restaurantId, 'preparing');
    await updateOrderStatusRestaurant(row.id, ctx.restaurantId, 'ready_for_pickup');
    await assert.rejects(() => updateOrderStatusRestaurant(row.id, ctx.restaurantId, 'delivered'), /pickup code/);

    // Handover: a wrong code changes nothing, the right one delivers it.
    const wrong = code === '1111' ? '2222' : '1111';
    await assert.rejects(() => handoverTakeawayRestaurant(row.id, ctx.restaurantId, wrong), /does not match/);
    assert.equal((await prisma.foodOrder.findUnique({ where: { id: row.id } })).orderStatus, 'ready_for_pickup');
    await handoverTakeawayRestaurant(row.id, ctx.restaurantId, code);
    const done = await prisma.foodOrder.findUnique({ where: { id: row.id } });
    assert.equal(done.orderStatus, 'delivered');
    assert.ok(done.deliveredAt);
    assert.equal(done.dispatchDeliveryPartnerId, null);
    assert.equal(done.dropOtpVerified, true);
    await assert.rejects(() => handoverTakeawayRestaurant(row.id, ctx.restaurantId, code), /already been handed over/);

    const tx = await prisma.foodTransaction.findUnique({ where: { orderId: row.id } });
    assert.equal(tx.status, 'captured');
    close(tx.riderShare, 0, 'riderShare');
    close(tx.restaurantShare, 425, 'restaurant gets food less commission');
    close(tx.platformNetProfit, 75, 'platform gets the commission');

    const { byId } = await reportRows();
    const r = byId.get(row.id);
    close(r.deliverymanEarning, 0, 'report rider');
    close(r.deliveryCharge, 0, 'report fee');
    close(r.orderAmount, r.storeNetIncome + r.adminNetIncome + r.deliverymanEarning + r.vatTax, 'takeaway reconciles');

    // The restaurant's own switch.
    await prisma.foodRestaurant.update({ where: { id: ctx.restaurantId }, data: { takeawayEnabled: false } });
    await assert.rejects(() => calculateOrder(userId, cart({ orderType: 'takeaway' })), /does not offer takeaway/);
    assert.equal((await getRestaurantOrderOptions(ctx.restaurantId)).orderTypes.takeaway, false);
    await prisma.foodRestaurant.update({ where: { id: ctx.restaurantId }, data: { takeawayEnabled: true } });
    assert.equal((await getRestaurantOrderOptions(ctx.restaurantId)).orderTypes.takeaway, true);

    // Home delivery off: only takeaway.
    await set('business_order', { takeaway: true, homeDelivery: false });
    await assert.rejects(() => createOrder(userId, cart()), /Home delivery is not available/);
    await resetSettings();
});

// ─── Scheduled orders ────────────────────────────────────────────────────────

test('scheduled: placed and paid now, held from the restaurant and riders until shortly before', async () => {
    await resetSettings();
    await set('business_order', { scheduledOrder: true, scheduleSlotMinutes: 30 });
    const userId = await makeUser();

    const options = await getRestaurantOrderOptions(ctx.restaurantId);
    assert.equal(options.schedule.enabled, true);
    assert.equal(options.schedule.slotMinutes, 30);
    const slots = options.schedule.days.flatMap((d) => d.slots);
    assert.ok(slots.length > 0, 'a restaurant with no hours set has slots');
    for (const slot of slots) {
        assert.ok(new Date(slot.scheduledAt).getTime() >= Date.now() + 44 * 60 * 1000, 'lead time');
    }

    await assert.rejects(() => createOrder(userId, cart({ scheduledAt: new Date(Date.now() + 15 * 60 * 1000).toISOString() })), /at least/);
    await assert.rejects(() => createOrder(userId, cart({ scheduledAt: new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString() })), /today or tomorrow/);

    const at = new Date(Date.now() + 3 * 3600 * 1000);
    const { row, order } = await place(userId, { scheduledAt: at.toISOString() });
    assert.equal(order.isScheduled, true);
    assert.equal(row.orderStatus, 'created');
    assert.equal(row.scheduledAt.getTime(), at.getTime());
    assert.equal(row.releaseAt.getTime(), at.getTime() - 40 * 60 * 1000, 'released 40 minutes before');
    assert.equal(row.acceptanceDeadlineAt.getTime(), row.releaseAt.getTime() + row.acceptanceWindowSeconds * 1000, 'the acceptance window opens at release');
    assert.equal(row.restaurantNotifiedAt, null, 'the restaurant is not rung yet');
    close(row.total, 547.2, 'priced as any order');
    const tx = await prisma.foodTransaction.findUnique({ where: { orderId: row.id } });
    assert.ok(tx, 'paid / recorded now');

    // The acceptance timer cannot cancel it early.
    await expireUnacceptedOrderById(row.id);
    assert.equal((await prisma.foodOrder.findUnique({ where: { id: row.id } })).orderStatus, 'created');

    // Accepted early: no rider is dispatched and none can take it before release.
    await updateOrderStatusRestaurant(row.id, ctx.restaurantId, 'confirmed');
    assert.equal(await tryAutoAssign(row.id), null);
    const rider = await makePartner();
    await assert.rejects(() => acceptOrderDelivery(row.id, rider.id), /not open for delivery yet/);
    await releaseScheduledOrders();
    let held = await prisma.foodOrder.findUnique({ where: { id: row.id } });
    assert.equal(held.dispatchStatus, 'unassigned');
    assert.ok(held.updatedAt < held.releaseAt, 'untouched by the release job before its time');

    // Its time comes: the release job starts the rider hunt, once.
    await prisma.$executeRaw`UPDATE food_orders SET "releaseAt" = NOW() - INTERVAL '1 minute', "updatedAt" = NOW() - INTERVAL '10 minutes' WHERE id = ${row.id}`;
    await releaseScheduledOrders();
    held = await prisma.foodOrder.findUnique({ where: { id: row.id } });
    assert.ok(held.updatedAt > held.releaseAt, 'the hunt touched the row');
    assert.equal(held.dispatchingAt, null, 'the hunt released its lock');
    const touched = held.updatedAt.getTime();
    await releaseScheduledOrders();
    assert.equal((await prisma.foodOrder.findUnique({ where: { id: row.id } })).updatedAt.getTime(), touched, 'not started twice');
    // Released: a rider may now take it.
    await acceptOrderDelivery(row.id, rider.id);
    assert.equal((await prisma.foodOrder.findUnique({ where: { id: row.id } })).dispatchDeliveryPartnerId, rider.id);

    // Not accepted early: the release rings the restaurant, once.
    const second = await place(userId, { scheduledAt: at.toISOString() });
    assert.equal(second.row.restaurantNotifiedAt, null);
    await prisma.$executeRaw`UPDATE food_orders SET "releaseAt" = NOW() - INTERVAL '1 minute' WHERE id = ${second.row.id}`;
    await releaseScheduledOrders();
    const rung = await prisma.foodOrder.findUnique({ where: { id: second.row.id } });
    assert.ok(rung.restaurantNotifiedAt, 'rung at release');
    assert.equal(rung.orderStatus, 'created');

    // An online scheduled order: the window opens at release, not at payment.
    const online = await placePaid(userId, { scheduledAt: at.toISOString() });
    assert.equal(online.row.orderStatus, 'created');
    assert.equal(online.row.acceptanceDeadlineAt.getTime(), online.row.releaseAt.getTime() + online.row.acceptanceWindowSeconds * 1000);
    assert.equal(online.row.restaurantNotifiedAt, null);

    // An order for "now" with scheduling on is untouched by it.
    const now = await place(userId);
    assert.equal(now.row.releaseAt, null);
    assert.ok(now.row.restaurantNotifiedAt);
    await resetSettings();
});
