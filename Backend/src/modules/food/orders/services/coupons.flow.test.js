import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../../config/prisma.js';
import { uniquePhone, uniqueTag } from '../../../../utils/testIds.js';
import { testPatch } from '../../../../utils/testGeo.js';
import { calculateOrder, createOrder } from './order.service.js';
import { getAllOffers, createAdminOffer } from '../../admin/services/adminOffer.service.js';
import { validateCreateOfferDto } from '../../admin/validators/offer.validator.js';
import { listPublicOffers } from '../../restaurant/services/restaurant.service.js';

/**
 * Coupons at checkout, through the real entry points: calculateOrder for the
 * quote and createOrder for the order, with coupons created the way the admin
 * page creates them (validator, then service).
 *
 * Zone A has a fee row: delivery 40 from a band (rider base pay 25), GST 5% on
 * items, 18% on the delivery fee. Restaurant A is in zone A, restaurant B in
 * zone B (no fee row of its own).
 */
const A = testPatch(11);
const B = testPatch(12);
const DAY = 86400000;
const ymd = (ms) => new Date(Date.now() + ms + 5.5 * 3600000).toISOString().slice(0, 10);

const created = { zones: [], restaurants: [], users: [], foods: [], categories: [], offers: [], fees: [] };
const ctx = {};

const makeUser = async () => {
    const user = await prisma.foodUser.create({ data: { name: 'Coupon Tester', phone: uniquePhone('5') } });
    created.users.push(user.id);
    return user.id;
};

const makeCoupon = async (body = {}) => {
    const dto = validateCreateOfferDto({
        title: 'Test coupon',
        couponCode: uniqueTag('CPN'),
        couponType: 'default',
        discountType: 'percent',
        discountValue: 10,
        startDate: ymd(-DAY),
        endDate: ymd(10 * DAY),
        ...body,
    });
    const offer = await createAdminOffer(dto);
    created.offers.push(offer.id);
    return offer;
};

const address = (p) => ({
    label: 'Home', fullName: 'Coupon Tester', street: '1 Test Street', city: 'Indore', state: 'MP',
    zipCode: '452001', phone: uniquePhone('5'), latitude: p.lat, longitude: p.lng,
});

const cart = (which = 'A', { quantity = 2, couponCode, pricing } = {}) => ({
    restaurantId: which === 'A' ? ctx.restA : ctx.restB,
    items: [{ itemId: which === 'A' ? ctx.foodA : ctx.foodB, quantity }],
    address: address(which === 'A' ? A : B),
    deliveryAddress: address(which === 'A' ? A : B),
    paymentMethod: 'cash',
    ...(couponCode ? { couponCode } : {}),
    ...(pricing ? { pricing } : {}),
});

/** Quote, then place the order with the quote's pricing, as the apps do. */
const placeWith = async (userId, couponCode, which = 'A') => {
    const quote = await calculateOrder(userId, cart(which, { couponCode }));
    const { order } = await createOrder(userId, cart(which, { pricing: quote.pricing }));
    return { quote, order };
};

const cancel = (orderId) =>
    prisma.foodOrder.update({ where: { id: orderId }, data: { orderStatus: 'cancelled_by_user' } });

test.before(async () => {
    const tag = uniqueTag('Cpn');
    for (const [key, patch] of [['A', A], ['B', B]]) {
        const zone = await prisma.foodZone.create({ data: { name: `${tag} Zone ${key}`, coordinates: patch.ring, isActive: true } });
        created.zones.push(zone.id);
        ctx[`zone${key}`] = zone.id;

        const restaurant = await prisma.foodRestaurant.create({
            data: {
                restaurantName: `${tag} Kitchen ${key}`, ownerName: 'Owner', ownerPhone: uniquePhone('9'),
                status: 'approved', zoneId: zone.id, latitude: patch.lat, longitude: patch.lng,
                isAcceptingOrders: true, outsideHoursOverride: true,
            },
        });
        created.restaurants.push(restaurant.id);
        ctx[`rest${key}`] = restaurant.id;

        const category = await prisma.foodCategory.create({ data: { name: `${tag} Mains ${key}`, restaurantId: restaurant.id, approvalStatus: 'approved' } });
        created.categories.push(category.id);
        const food = await prisma.foodItem.create({
            data: {
                restaurantId: restaurant.id, categoryId: category.id, categoryName: category.name,
                name: `${tag} Thali ${key}`, price: 250, approvalStatus: 'approved', isAvailable: true,
            },
        });
        created.foods.push(food.id);
        ctx[`food${key}`] = food.id;
    }

    const fee = await prisma.foodFeeSettings.create({
        data: {
            zoneId: ctx.zoneA, isActive: true,
            deliveryFee: 40, platformFee: 0, platformFeeEnabled: false,
            gstRate: 5, gstEnabled: true, deliveryFeeGstRate: 18, deliveryFeeGstEnabled: true,
            deliveryFeeBands: { create: [{ minDistanceKm: 0, maxDistanceKm: 50, fee: 40, deliveryBoyBasePay: 25 }] },
        },
    });
    created.fees.push(fee.id);
});

test.after(async () => {
    const orders = await prisma.foodOrder.findMany({ where: { restaurantId: { in: created.restaurants } }, select: { id: true } });
    const ids = orders.map((o) => o.id);
    await prisma.foodTransaction.deleteMany({ where: { orderId: { in: ids } } });
    await prisma.orderItem.deleteMany({ where: { orderId: { in: ids } } });
    await prisma.orderStatusHistory.deleteMany({ where: { orderId: { in: ids } } });
    await prisma.foodOrder.deleteMany({ where: { id: { in: ids } } });
    await prisma.foodOfferUsage.deleteMany({ where: { offerId: { in: created.offers } } });
    await prisma.foodOffer.deleteMany({ where: { id: { in: created.offers } } });
    await prisma.foodFeeSettings.deleteMany({ where: { id: { in: created.fees } } });
    await prisma.foodItem.deleteMany({ where: { id: { in: created.foods } } });
    await prisma.foodCategory.deleteMany({ where: { id: { in: created.categories } } });
    await prisma.foodUser.deleteMany({ where: { id: { in: created.users } } });
    await prisma.foodRestaurant.deleteMany({ where: { id: { in: created.restaurants } } });
    await prisma.foodZone.deleteMany({ where: { id: { in: created.zones } } });
    await prisma.$disconnect();
});

test('a default coupon takes its discount off the item subtotal', async () => {
    const userId = await makeUser();
    const c = await makeCoupon({ discountValue: 20, maxDiscount: 60 });
    const { pricing } = await calculateOrder(userId, cart('A', { couponCode: c.couponCode.toLowerCase() }));

    assert.equal(pricing.subtotal, 500);
    assert.equal(pricing.discount, 60, '20% of 500 is 100, capped at 60');
    assert.equal(pricing.appliedCoupon.code, c.couponCode);
    assert.equal(pricing.appliedCoupon.couponType, 'default');
    assert.equal(pricing.couponError, null);
    // Item GST is on the discounted value: 5% of 440.
    assert.equal(pricing.tax, 22);
    assert.equal(pricing.deliveryFee, 40);
});

test('a rejected code says why, and the quote is priced without it', async () => {
    const userId = await makeUser();
    const c = await makeCoupon({ minOrderValue: 800 });
    const { pricing } = await calculateOrder(userId, cart('A', { couponCode: c.couponCode }));
    assert.equal(pricing.discount, 0);
    assert.equal(pricing.appliedCoupon, null);
    assert.equal(pricing.couponErrorReason, 'min_purchase');
    assert.match(pricing.couponError, /minimum purchase ₹800/);

    const unknown = await calculateOrder(userId, cart('A', { couponCode: 'NO-SUCH-CODE' }));
    assert.equal(unknown.pricing.couponErrorReason, 'not_found');
});

test('switched off, expired and not-yet-started coupons are refused', async () => {
    const userId = await makeUser();
    const off = await makeCoupon();
    await prisma.foodOffer.update({ where: { id: off.id }, data: { status: 'inactive' } });
    const later = await makeCoupon({ startDate: ymd(3 * DAY), endDate: ymd(5 * DAY) });
    const old = await makeCoupon();
    await prisma.foodOffer.update({ where: { id: old.id }, data: { endDate: new Date(Date.now() - DAY) } });

    const reasons = [];
    for (const c of [off, later, old]) {
        const { pricing } = await calculateOrder(userId, cart('A', { couponCode: c.couponCode }));
        assert.equal(pricing.discount, 0);
        reasons.push(pricing.couponErrorReason);
    }
    assert.deepEqual(reasons, ['inactive', 'not_started', 'expired']);
});

test('store wise applies only at its restaurant', async () => {
    const userId = await makeUser();
    const c = await makeCoupon({ couponType: 'store_wise', restaurantId: ctx.restA });
    assert.equal((await calculateOrder(userId, cart('A', { couponCode: c.couponCode }))).pricing.discount, 50);
    const b = await calculateOrder(userId, cart('B', { couponCode: c.couponCode }));
    assert.equal(b.pricing.couponErrorReason, 'wrong_restaurant');
});

test('zone wise applies only to orders in its zone', async () => {
    const userId = await makeUser();
    const c = await makeCoupon({ couponType: 'zone_wise', zoneIds: [ctx.zoneA] });
    assert.equal((await calculateOrder(userId, cart('A', { couponCode: c.couponCode }))).pricing.discount, 50);
    const b = await calculateOrder(userId, cart('B', { couponCode: c.couponCode }));
    assert.equal(b.pricing.couponErrorReason, 'wrong_zone');

    // The public list shows it for zone A's restaurant only.
    const listA = await listPublicOffers({ restaurantId: ctx.restA, userId });
    const listB = await listPublicOffers({ restaurantId: ctx.restB, userId });
    assert.ok(listA.allOffers.some((o) => o.id === c.id));
    assert.ok(!listB.allOffers.some((o) => o.id === c.id));
});

test('free delivery waives the delivery fee and its GST; the rider is paid the same', async () => {
    const userId = await makeUser();
    const c = await makeCoupon({ couponType: 'free_delivery', discountType: '', discountValue: '' });
    assert.equal(Number(c.discountValue), 0);

    const plain = await calculateOrder(userId, cart('A'));
    const { quote, order } = await placeWith(userId, c.couponCode);

    assert.equal(plain.pricing.deliveryFee, 40);
    assert.equal(plain.pricing.deliveryFeeGst, 7.2);
    assert.equal(quote.pricing.deliveryFee, 0);
    assert.equal(quote.pricing.deliveryFeeGst, 0);
    assert.equal(quote.pricing.originalDeliveryFee, 40);
    assert.equal(quote.pricing.deliveryFeeWaived, 47.2);
    assert.equal(quote.pricing.discount, 0, 'no item discount');
    assert.equal(quote.pricing.tax, plain.pricing.tax, 'item GST unchanged');
    assert.equal(quote.pricing.platformFee, plain.pricing.platformFee, 'platform fee unchanged');
    assert.equal(quote.pricing.total, Math.round((plain.pricing.total - 47.2) * 100) / 100);
    assert.equal(quote.pricing.appliedCoupon.freeDelivery, true);
    assert.equal(quote.pricing.appliedCoupon.savings, 47.2);

    const row = await prisma.foodOrder.findUnique({ where: { id: order.id || order._id } });
    assert.equal(row.couponId, c.id);
    assert.equal(Number(row.couponDeliveryWaiver), 47.2);
    assert.equal(Number(row.deliveryFee), 0);
    assert.equal(Number(row.riderEarning), 25, 'rider pay comes from the band, not the waived fee');
    assert.equal(order.pricing.deliveryFeeWaived, 47.2);

    // The platform absorbs it: its profit is the coupon-free order's minus the waiver.
    const tx = await prisma.foodTransaction.findUnique({ where: { orderId: row.id } });
    assert.equal(Number(tx.riderShare), 25);
    assert.equal(Number(tx.restaurantDiscountShare), 0, 'the restaurant pays nothing towards it');
});

test('first order: only while the customer has no placed order; a cancelled one does not count', async () => {
    const userId = await makeUser();
    const c = await makeCoupon({ couponType: 'first_order', discountValue: 10 });

    const { order } = await placeWith(userId, c.couponCode);
    assert.equal(Number(order.pricing.discount), 50, 'applies on the first order');

    const second = await calculateOrder(userId, cart('A', { couponCode: c.couponCode }));
    assert.equal(second.pricing.couponErrorReason, 'not_first_order');

    await cancel(order.id || order._id);
    const again = await calculateOrder(userId, cart('A', { couponCode: c.couponCode }));
    assert.equal(again.pricing.discount, 50, 'the cancelled order gave the first order back');

    // An order left unpaid at the gateway does not count either.
    await prisma.foodOrder.update({ where: { id: order.id || order._id }, data: { orderStatus: 'pending_payment' } });
    assert.equal((await calculateOrder(userId, cart('A', { couponCode: c.couponCode }))).pricing.discount, 50);
});

test('a coupon for named customers works only for them', async () => {
    const allowed = await makeUser();
    const other = await makeUser();
    const c = await makeCoupon({ customerIds: [allowed] });
    assert.equal(c.customerScope, 'specific');

    assert.equal((await calculateOrder(allowed, cart('A', { couponCode: c.couponCode }))).pricing.discount, 50);
    assert.equal((await calculateOrder(other, cart('A', { couponCode: c.couponCode }))).pricing.couponErrorReason, 'not_eligible');
});

test('limit for the same user counts orders, and a cancelled order gives the use back', async () => {
    const userId = await makeUser();
    const c = await makeCoupon({ perUserLimit: 1 });

    const { order } = await placeWith(userId, c.couponCode);
    assert.equal(Number(order.pricing.discount), 50);

    const blocked = await calculateOrder(userId, cart('A', { couponCode: c.couponCode }));
    assert.equal(blocked.pricing.couponErrorReason, 'user_limit_reached');

    // Hidden from this customer's coupon list too.
    const listed = await listPublicOffers({ restaurantId: ctx.restA, userId });
    assert.ok(!listed.allOffers.some((o) => o.id === c.id));

    await cancel(order.id || order._id);
    assert.equal((await calculateOrder(userId, cart('A', { couponCode: c.couponCode }))).pricing.discount, 50);

    // A failed online payment does not use it up either.
    await prisma.foodOrder.update({
        where: { id: order.id || order._id },
        data: { orderStatus: 'created', paymentStatus: 'failed' },
    });
    assert.equal((await calculateOrder(userId, cart('A', { couponCode: c.couponCode }))).pricing.discount, 50);
});

test('Total Uses is the number of orders that used the coupon', async () => {
    const c = await makeCoupon();
    const u1 = await makeUser();
    const u2 = await makeUser();
    const u3 = await makeUser();
    await placeWith(u1, c.couponCode);
    await placeWith(u2, c.couponCode);
    const { order } = await placeWith(u3, c.couponCode);
    await cancel(order.id || order._id);
    // An order with the code typed in but not applied is not a use.
    await createOrder(u3, cart('A', { pricing: { subtotal: 500, total: 500, couponCode: 'NOT-A-CODE' } }));

    const { offers } = await getAllOffers({ search: c.couponCode });
    const row = offers.find((o) => o.id === c.id);
    assert.equal(row.totalUses, 2, 'two placed orders; the cancelled one does not count');
    assert.equal(row.couponType, 'default');
    assert.equal(row.title, 'Test coupon');
});

test('an order the customer was promised a saving on is refused if the coupon no longer applies', async () => {
    const userId = await makeUser();
    const c = await makeCoupon();
    const quote = await calculateOrder(userId, cart('A', { couponCode: c.couponCode }));
    assert.equal(quote.pricing.discount, 50);

    // The admin switches it off between the quote and the order.
    await prisma.foodOffer.update({ where: { id: c.id }, data: { status: 'inactive' } });
    await assert.rejects(
        () => createOrder(userId, cart('A', { pricing: quote.pricing })),
        /This coupon is not active\. Please review your cart/,
    );

    // A client echoing a code that never applied (discount 0) still orders, as before.
    const { order } = await createOrder(userId, cart('A', { pricing: { ...quote.pricing, discount: 0 } }));
    assert.equal(Number(order.pricing.discount), 0);
    assert.equal(order.pricing.couponId, null);
});
