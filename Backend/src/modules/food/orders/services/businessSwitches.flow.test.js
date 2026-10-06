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
    expireUnacceptedOrderById,
} from './order.service.js';
import { resolveOrderType } from './orderModes.js';
import { additionalChargeFor, extraPackagingFee, extraPackagingOffer } from './businessRules.js';
import { getRestaurantOrderOptions } from './order-scheduling.service.js';
import { getRestaurantCommissionSnapshot } from './foodTransaction.service.js';
import { saveSystemSettings, getSystemSettings, getPublicBusinessSettings } from '../../admin/services/adminSystemExtras.service.js';
import { FEATURE_KEYS, isFeatureEnabled, updateFeatureSetting } from '../../admin/services/featureSettings.service.js';
import { setRestaurantBillingMode } from '../../admin/services/adminCommission.service.js';
import { getOrderMoneyReport } from '../../admin/services/adminOrderMoneyReport.service.js';
import { invalidateBusinessSettings, assertSelfRegistrationOpen } from '../../shared/businessSettings.js';
import { registerRestaurant, updateRestaurantPackaging } from '../../restaurant/services/restaurant.service.js';
import { registerDeliveryPartner } from '../../delivery/services/delivery.service.js';

/**
 * The Business Settings switches that used to be saved but not applied:
 * home delivery, who confirms the order, extra packaging and additional
 * charges, the subscription business model and self registration -- each
 * through the real entry points, and each off (the default) leaving an order
 * exactly as it was.
 *
 * Money: 2 x 250 = 500 of food, delivery fee 40 + 18% GST (7.2), no item GST,
 * no platform fee, 15% default commission (75), rider band pay 25.
 */
const HERE = testPatch(29);
const AREAS = ['business_info', 'business_deliveryman', 'business_order', 'business_vendor', 'business_customer',
    'business_payment', 'website'];

const created = { zones: [], restaurants: [], users: [], foods: [], categories: [], fees: [], orders: [] };
const ctx = {};
const today = new Date().toLocaleDateString('en-CA');

const set = (area, value) => saveSystemSettings(area, { value });
const resetSettings = async () => {
    await prisma.foodSystemSetting.deleteMany({ where: { key: { in: AREAS } } });
    invalidateBusinessSettings();
};
const close = (actual, expected, label) => assert.ok(Math.abs(Number(actual) - Number(expected)) < 0.005, `${label}: ${actual} != ${expected}`);

const makeUser = async () => {
    const user = await prisma.foodUser.create({ data: { name: 'Switch Tester', phone: uniquePhone('5') } });
    created.users.push(user.id);
    return user.id;
};

const address = () => ({
    label: 'Home', fullName: 'Switch Tester', street: '1 Test Street', city: 'Indore', state: 'MP',
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

const placePaid = async (userId, extra = {}) => {
    const placed = await place(userId, { paymentMethod: 'razorpay', ...extra });
    assert.equal(placed.row.orderStatus, 'pending_payment');
    await prisma.foodOrder.update({ where: { id: placed.row.id }, data: { paymentStatus: 'paid' } });
    await finalizeOrderPayment(placed.row.id);
    return { ...placed, row: await prisma.foodOrder.findUnique({ where: { id: placed.row.id } }) };
};

const setPackaging = (data) => prisma.foodRestaurant.update({ where: { id: ctx.restaurantId }, data });

test.before(async () => {
    await resetSettings();
    ctx.subscriptionFlag = await isFeatureEnabled(FEATURE_KEYS.RESTAURANT_SUBSCRIPTION, true);
    const tag = uniqueTag('Switch');
    const zone = await prisma.foodZone.create({ data: { name: `${tag} Zone`, coordinates: HERE.ring, isActive: true } });
    created.zones.push(zone.id);
    const restaurant = await prisma.foodRestaurant.create({
        data: {
            restaurantName: `${tag} Kitchen`, ownerName: 'Owner', ownerPhone: uniquePhone('9'),
            status: 'approved', zoneId: zone.id, latitude: HERE.lat, longitude: HERE.lng,
            addressLine1: '5 Market Road', city: 'Indore', state: 'MP', isAcceptingOrders: true,
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
    await updateFeatureSetting(FEATURE_KEYS.RESTAURANT_SUBSCRIPTION, { isEnabled: ctx.subscriptionFlag });
    // Let any background rider hunt started by an automatic confirmation finish.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const ids = created.orders;
    await prisma.foodTransactionHistory.deleteMany({ where: { transaction: { orderId: { in: ids } } } }).catch(() => {});
    await prisma.foodTransaction.deleteMany({ where: { orderId: { in: ids } } });
    await prisma.orderItem.deleteMany({ where: { orderId: { in: ids } } });
    await prisma.orderStatusHistory.deleteMany({ where: { orderId: { in: ids } } });
    await prisma.orderDispatchOffer.deleteMany({ where: { orderId: { in: ids } } }).catch(() => {});
    await prisma.foodOrder.deleteMany({ where: { id: { in: ids } } });
    await prisma.foodFeeSettings.deleteMany({ where: { id: { in: created.fees } } });
    await prisma.foodItem.deleteMany({ where: { id: { in: created.foods } } });
    await prisma.foodCategory.deleteMany({ where: { id: { in: created.categories } } });
    await prisma.foodUser.deleteMany({ where: { id: { in: created.users } } });
    await prisma.foodRestaurant.deleteMany({ where: { id: { in: created.restaurants } } });
    await prisma.foodZone.deleteMany({ where: { id: { in: created.zones } } });
    await prisma.$disconnect();
});

// ─── Pure rules ──────────────────────────────────────────────────────────────

test('rules: extra packaging, additional charge and order types', () => {
    const on = { extraPackagingCharge: true };
    const kitchen = { extraPackagingEnabled: true, extraPackagingAmount: 15, extraPackagingRequired: false };
    assert.equal(extraPackagingFee(on, kitchen, false), 0, 'optional and not asked for');
    assert.equal(extraPackagingFee(on, kitchen, true), 15);
    assert.equal(extraPackagingFee(on, { ...kitchen, extraPackagingRequired: true }), 15, 'required: always');
    assert.equal(extraPackagingFee({ extraPackagingCharge: false }, { ...kitchen, extraPackagingRequired: true }, true), 0, 'global switch off');
    assert.equal(extraPackagingFee(on, { ...kitchen, extraPackagingEnabled: false }, true), 0, 'restaurant has none');
    assert.equal(extraPackagingFee(on, { ...kitchen, extraPackagingAmount: 0 }, true), 0);
    assert.deepEqual(extraPackagingOffer(on, kitchen), { amount: 15, required: false, applied: false });
    assert.equal(extraPackagingOffer({}, kitchen), null);

    assert.deepEqual(additionalChargeFor({ additionalCharge: { enabled: false, name: 'X', amount: 10 } }), { amount: 0, name: '' });
    assert.deepEqual(additionalChargeFor({ additionalCharge: { enabled: true, name: '', amount: 10 } }), { amount: 10, name: 'Additional charge' });
    assert.deepEqual(additionalChargeFor({ additionalCharge: { enabled: true, name: 'Service charge', amount: 12.5 } }), { amount: 12.5, name: 'Service charge' });
    assert.deepEqual(additionalChargeFor({ additionalCharge: { enabled: true, name: 'Zero', amount: 0 } }), { amount: 0, name: '' });

    assert.equal(resolveOrderType(undefined, { orderRules: { homeDelivery: true, takeaway: false } }), 'delivery');
    assert.throws(() => resolveOrderType('delivery', { orderRules: { homeDelivery: false, takeaway: true } }), /Home delivery is not available/);
    assert.equal(resolveOrderType('takeaway', { orderRules: { homeDelivery: false, takeaway: true } }), 'takeaway');
    assert.throws(() => resolveOrderType('takeaway', { orderRules: { homeDelivery: false, takeaway: false } }), /Ordering is not available/);
    assert.throws(() => resolveOrderType('delivery', { orderRules: { homeDelivery: false, takeaway: false } }), /Ordering is not available/);
});

// ─── Defaults ────────────────────────────────────────────────────────────────

test('defaults: no extra charges, the restaurant confirms, sign-up open', async () => {
    await resetSettings();
    await setPackaging({ extraPackagingEnabled: true, extraPackagingAmount: 15, extraPackagingRequired: true });
    const userId = await makeUser();
    const { quote, row } = await place(userId, { extraPackaging: true });
    close(quote.pricing.packagingFee, 0, 'packaging off globally');
    close(quote.pricing.additionalCharge, 0, 'no additional charge');
    assert.equal(quote.pricing.extraPackaging, null);
    close(row.total, 547.2, 'total as before');
    close(row.platformFee, 0, 'platform fee');
    close(row.additionalCharge, 0, 'additional charge column');
    assert.equal(row.orderStatus, 'created', 'waits for the restaurant');
    assert.ok(row.acceptanceDeadlineAt, 'acceptance window running');

    const pub = await getPublicBusinessSettings();
    assert.equal(pub.order.confirmedBy, 'restaurant');
    assert.equal(pub.order.extraPackagingCharge, false);
    assert.equal(pub.order.additionalCharge, null);
    assert.equal(pub.restaurant.selfRegistration, true);
    assert.equal(pub.rider.selfRegistration, true);
    await assertSelfRegistrationOpen('restaurant');
    await assertSelfRegistrationOpen('rider');
    await assert.rejects(() => updateRestaurantPackaging(ctx.restaurantId, { enabled: true, amount: 20 }), /not allowed/);
    await setPackaging({ extraPackagingEnabled: false, extraPackagingAmount: 0, extraPackagingRequired: false });
});

// ─── Home delivery ───────────────────────────────────────────────────────────

test('home delivery off: delivery refused, takeaway still works', async () => {
    await resetSettings();
    await assert.rejects(() => set('business_order', { homeDelivery: false, takeaway: false }), /at least one/);
    await set('business_order', { homeDelivery: false, takeaway: true });
    const userId = await makeUser();
    await assert.rejects(() => calculateOrder(userId, cart()), /Home delivery is not available/);
    await assert.rejects(() => createOrder(userId, cart({ pricing: { subtotal: 500, total: 547.2 } })), /Home delivery is not available/);
    const quote = await calculateOrder(userId, cart({ orderType: 'takeaway', paymentMethod: 'razorpay' }));
    assert.equal(quote.pricing.orderType, 'takeaway');
    close(quote.pricing.total, 500, 'takeaway: no delivery fee');
    const options = await getRestaurantOrderOptions(ctx.restaurantId);
    assert.deepEqual(options.orderTypes, { delivery: false, takeaway: true });
    await resetSettings();
});

// ─── Extra packaging and additional charge ───────────────────────────────────

test('extra packaging and additional charge: priced, split and reported', async () => {
    await resetSettings();
    await set('business_order', { extraPackagingCharge: true });
    await set('business_info', { additionalCharge: { enabled: true, name: 'Service charge', amount: 10 } });

    await assert.rejects(() => updateRestaurantPackaging(ctx.restaurantId, { enabled: true }), /Enter the packaging charge/);
    await assert.rejects(() => updateRestaurantPackaging(ctx.restaurantId, { amount: 900 }), /between 0 and 500/);
    const profile = await updateRestaurantPackaging(ctx.restaurantId, { enabled: true, amount: 15, required: false });
    assert.deepEqual(profile.extraPackaging, { enabled: true, amount: 15, required: false });

    const options = await getRestaurantOrderOptions(ctx.restaurantId);
    assert.deepEqual(options.extraPackaging, { amount: 15, required: false });
    assert.deepEqual(options.additionalCharge, { amount: 10, name: 'Service charge' });
    const pub = await getPublicBusinessSettings();
    assert.deepEqual(pub.order.additionalCharge, { amount: 10, name: 'Service charge' });
    assert.equal(pub.order.extraPackagingCharge, true);

    const userId = await makeUser();
    // Not asked for: only the additional charge.
    const plainQuote = await calculateOrder(userId, cart());
    close(plainQuote.pricing.packagingFee, 0, 'packaging not asked for');
    close(plainQuote.pricing.additionalCharge, 10, 'additional charge');
    assert.equal(plainQuote.pricing.additionalChargeName, 'Service charge');
    close(plainQuote.pricing.platformFee, 10, 'part of the platform fee');
    close(plainQuote.pricing.total, 557.2, 'total with the additional charge');
    assert.deepEqual(plainQuote.pricing.extraPackaging, { amount: 15, required: false, applied: false });

    // Asked for.
    const { quote, row, order } = await place(userId, { extraPackaging: true });
    close(quote.pricing.packagingFee, 15, 'quoted packaging');
    close(quote.pricing.total, 572.2, 'quoted total');
    close(row.packagingFee, 15, 'packaging column');
    close(row.additionalCharge, 10, 'additional charge column');
    assert.equal(row.additionalChargeName, 'Service charge');
    close(row.platformFee, 10, 'platform fee column');
    close(row.total, 572.2, 'charged total');
    close(row.restaurantCommission, 75, 'commission on the food only');
    close(order.pricing.additionalCharge, 10, 'order response carries the charge');
    assert.equal(order.pricing.additionalChargeName, 'Service charge');

    const tx = await prisma.foodTransaction.findUnique({ where: { orderId: row.id } });
    close(tx.restaurantShare, 500 + 15 - 75, 'packaging goes to the restaurant');
    close(tx.platformNetProfit, 10 + 40 + 7.2 + 75 - 25, 'additional charge goes to the platform');

    // Required by the restaurant: charged without asking.
    await setPackaging({ extraPackagingRequired: true });
    const required = await place(userId);
    close(required.row.packagingFee, 15, 'required packaging');
    close(required.row.total, 572.2, 'required total');

    // Transaction report: both columns, and the orders reconcile.
    for (const id of [row.id, required.row.id]) {
        await prisma.foodOrder.update({ where: { id }, data: { orderStatus: 'delivered', deliveryPhase: 'delivered', deliveredAt: new Date() } });
    }
    const report = await getOrderMoneyReport({ restaurantId: ctx.restaurantId, status: 'delivered', from: today, to: today, limit: 500 });
    const reported = report.orders.find((r) => r.id === row.id);
    close(reported.extraPackagingAmount, 15, 'report packaging');
    close(reported.additionalCharge, 10, 'report additional charge');
    close(reported.orderAmount, 572.2, 'report order amount');
    close(reported.orderAmount, reported.storeNetIncome + reported.adminNetIncome + reported.deliverymanEarning + reported.vatTax, 'reconciles');
    close(reported.adminNetIncome,
        reported.adminCommission + reported.commissionOnDeliveryCharge + reported.additionalCharge + reported.deliveryChargeGst - reported.adminDiscount,
        'admin net decomposes');
    close(reported.storeNetIncome, 440, 'restaurant net includes packaging');

    // Global switch off again: nothing charged though the restaurant still has it on.
    await set('business_order', { extraPackagingCharge: false });
    await set('business_info', { additionalCharge: { enabled: false, name: 'Service charge', amount: 10 } });
    const off = await calculateOrder(userId, cart({ extraPackaging: true }));
    close(off.pricing.packagingFee, 0, 'off: no packaging');
    close(off.pricing.additionalCharge, 0, 'off: no additional charge');
    close(off.pricing.total, 547.2, 'off: total as before');
    await setPackaging({ extraPackagingEnabled: false, extraPackagingAmount: 0, extraPackagingRequired: false });
    await resetSettings();
});

// ─── Who confirms the order ──────────────────────────────────────────────────

test('deliveryman confirms: delivery orders are confirmed at once, no acceptance timer; takeaway still waits', async () => {
    await resetSettings();
    await set('business_order', { orderConfirmedBy: 'deliveryman', takeaway: true });
    const userId = await makeUser();

    const cash = await place(userId);
    assert.equal(cash.row.orderStatus, 'confirmed', 'confirmed on placement');
    assert.equal(cash.row.acceptanceDeadlineAt, null, 'no acceptance window');
    assert.ok(cash.row.restaurantNotifiedAt, 'the restaurant is still alerted');
    assert.equal(cash.order.orderStatus, 'confirmed', 'the placed order says so');
    const history = await prisma.orderStatusHistory.findMany({ where: { orderId: cash.row.id }, orderBy: { at: 'asc' } });
    assert.ok(history.some((h) => h.from === 'created' && h.to === 'confirmed' && h.byRole === 'SYSTEM'), 'recorded as automatic');

    // The acceptance timer cannot cancel it.
    assert.equal(await expireUnacceptedOrderById(cash.row.id), 0);
    assert.equal((await prisma.foodOrder.findUnique({ where: { id: cash.row.id } })).orderStatus, 'confirmed');
    // The restaurant still moves it on.
    const preparing = await updateOrderStatusRestaurant(cash.row.id, ctx.restaurantId, 'preparing');
    assert.equal(preparing.orderStatus, 'preparing');

    const online = await placePaid(userId);
    assert.equal(online.row.orderStatus, 'confirmed', 'confirmed when the payment is');
    assert.equal(online.row.acceptanceDeadlineAt, null);

    const takeaway = await placePaid(userId, { orderType: 'takeaway', address: undefined, deliveryAddress: undefined });
    assert.equal(takeaway.row.orderStatus, 'created', 'a takeaway is still accepted by the restaurant');
    assert.ok(takeaway.row.acceptanceDeadlineAt);

    assert.equal((await getPublicBusinessSettings()).order.confirmedBy, 'deliveryman');

    // Back to the default: the restaurant confirms.
    await set('business_order', { orderConfirmedBy: 'restaurant' });
    const again = await place(userId);
    assert.equal(again.row.orderStatus, 'created');
    assert.ok(again.row.acceptanceDeadlineAt);
    await resetSettings();
});

// ─── Self registration ───────────────────────────────────────────────────────

test('self registration off: public restaurant and rider sign-up refused with a message', async () => {
    await resetSettings();
    await set('business_vendor', { restaurantSelfRegistration: false });
    await set('business_deliveryman', { riderSelfRegistration: false });

    await assert.rejects(() => registerRestaurant({ ownerPhone: uniquePhone('9'), restaurantName: 'Closed' }, {}), (err) => {
        assert.equal(err.statusCode, 403);
        assert.match(err.message, /Restaurant sign-up is closed/);
        return true;
    });
    await assert.rejects(() => registerDeliveryPartner({ name: 'Closed', phone: uniquePhone('7') }, {}, {}), (err) => {
        assert.equal(err.statusCode, 403);
        assert.match(err.message, /Delivery partner sign-up is closed/);
        return true;
    });
    const pub = await getPublicBusinessSettings();
    assert.equal(pub.restaurant.selfRegistration, false);
    assert.equal(pub.rider.selfRegistration, false);

    await resetSettings();
    await assertSelfRegistrationOpen('restaurant');
    await assertSelfRegistrationOpen('rider');
});

// ─── Business models ─────────────────────────────────────────────────────────

test('subscription model: the switch is the Restaurant Subscription flag; off puts subscription restaurants on commission', async () => {
    await resetSettings();
    await updateFeatureSetting(FEATURE_KEYS.RESTAURANT_SUBSCRIPTION, { isEnabled: true });
    const sub = await prisma.foodRestaurant.create({
        data: {
            restaurantName: `${uniqueTag('Plan')} Kitchen`, ownerName: 'Owner', ownerPhone: uniquePhone('9'),
            status: 'approved', latitude: HERE.lat, longitude: HERE.lng, billingMode: 'subscription',
        },
    });
    created.restaurants.push(sub.id);

    assert.equal((await getSystemSettings('business_info')).value.subscriptionModel, true, 'reads the flag (on by default)');
    // On: a subscription restaurant pays no commission per order.
    close((await getRestaurantCommissionSnapshot({ restaurantId: sub.id, subtotal: 500 })).commissionAmount, 0, 'on: no commission');

    await assert.rejects(() => set('business_info', { commissionModel: false, subscriptionModel: false }), /at least one/);
    // A save that does not send the switch leaves the flag alone.
    await set('business_info', { defaultCommissionPercent: 15 });
    assert.equal(await isFeatureEnabled(FEATURE_KEYS.RESTAURANT_SUBSCRIPTION, true), true);

    const saved = await set('business_info', { subscriptionModel: false });
    assert.equal(saved.value.subscriptionModel, false);
    assert.equal(await isFeatureEnabled(FEATURE_KEYS.RESTAURANT_SUBSCRIPTION, true), false, 'the flag follows the switch');
    assert.equal((await getSystemSettings('business_info')).value.subscriptionModel, false);
    assert.equal((await getPublicBusinessSettings()).business.subscriptionModel, false);
    // Off: the same restaurant is on commission (default 15% of 500).
    const snap = await getRestaurantCommissionSnapshot({ restaurantId: sub.id, subtotal: 500 });
    close(snap.commissionAmount, 75, 'off: commission');
    assert.equal(snap.billingMode, 'commission_overall');
    await assert.rejects(() => setRestaurantBillingMode(sub.id, 'subscription'), /subscription business model is off/);
    // Commission cannot be switched off while subscription is off.
    await assert.rejects(() => set('business_info', { commissionModel: false }), /at least one/);

    // Commission off, subscription on: restaurants must be on a plan.
    await set('business_info', { commissionModel: false, subscriptionModel: true });
    await assert.rejects(() => setRestaurantBillingMode(sub.id, 'commission_overall'), /must be on a subscription/);
    const ok = await setRestaurantBillingMode(sub.id, 'subscription');
    assert.equal(ok.billingMode, 'subscription');

    await resetSettings();
    await updateFeatureSetting(FEATURE_KEYS.RESTAURANT_SUBSCRIPTION, { isEnabled: ctx.subscriptionFlag });
});
