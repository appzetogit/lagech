import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluateCoupon, effectiveCouponType, requiresFirstOrder, USED_ORDER_WHERE } from './couponRules.js';

/**
 * The coupon rules on their own (no database): the five old-panel types,
 * dates, minimum purchase, the percent cap, the customer restriction and the
 * per-customer limit. order-pricing.service.js supplies the two counts.
 */
const USER = 'a'.repeat(24);
const OTHER = 'b'.repeat(24);
const REST = 'c'.repeat(24);
const REST2 = 'd'.repeat(24);
const ZONE = 'e'.repeat(24);
const ZONE2 = 'f'.repeat(24);
const NOW = new Date('2026-10-10T08:00:00.000Z');

const coupon = (over = {}) => ({
    id: '1'.repeat(24),
    couponCode: 'SAVE',
    couponType: 'default',
    discountType: 'percentage',
    discountValue: 10,
    maxDiscount: null,
    minOrderValue: 0,
    customerScope: 'all',
    customerIds: [],
    restaurantScope: 'all',
    restaurantIds: [],
    zoneIds: [],
    status: 'active',
    showInCart: true,
    startDate: null,
    endDate: null,
    usageLimit: null,
    usedCount: 0,
    perUserLimit: null,
    isFirstOrderOnly: false,
    ...over,
});
const ctx = (over = {}) => ({ now: NOW, userId: USER, restaurantId: REST, zoneId: ZONE, subtotal: 500, deliveryFee: 40, deliveryFeeGst: 7.2, ...over });

test('a default coupon applies to any order', () => {
    const r = evaluateCoupon(coupon(), ctx());
    assert.equal(r.ok, true);
    assert.equal(r.discount, 50);
    assert.equal(r.deliveryFeeWaived, 0);
});

test('an unknown code is rejected with a message', () => {
    const r = evaluateCoupon(null, ctx());
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'not_found');
    assert.match(r.message, /not valid/);
});

test('max discount caps a percent discount; 0 or none means no cap', () => {
    assert.equal(evaluateCoupon(coupon({ discountValue: 50, maxDiscount: 100 }), ctx()).discount, 100);
    assert.equal(evaluateCoupon(coupon({ discountValue: 50, maxDiscount: 0 }), ctx()).discount, 250);
    assert.equal(evaluateCoupon(coupon({ discountValue: 50 }), ctx()).discount, 250);
});

test('an amount discount is never more than the subtotal', () => {
    const r = evaluateCoupon(coupon({ discountType: 'flat_price', discountValue: 900 }), ctx());
    assert.equal(r.discount, 500);
    // And a cap does not apply to an amount.
    assert.equal(evaluateCoupon(coupon({ discountType: 'flat_price', discountValue: 80, maxDiscount: 10 }), ctx()).discount, 80);
});

test('min purchase is checked against the item subtotal', () => {
    const r = evaluateCoupon(coupon({ minOrderValue: 600 }), ctx());
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'min_purchase');
    assert.match(r.message, /₹100 more/);
    assert.equal(evaluateCoupon(coupon({ minOrderValue: 500 }), ctx()).ok, true);
});

test('switched off, not started and expired coupons are rejected with clear messages', () => {
    const off = evaluateCoupon(coupon({ status: 'inactive' }), ctx());
    assert.equal(off.reason, 'inactive');

    const later = evaluateCoupon(coupon({ startDate: new Date('2026-10-12T00:00:00+05:30') }), ctx());
    assert.equal(later.reason, 'not_started');
    assert.match(later.message, /12 Oct 2026/);

    const gone = evaluateCoupon(coupon({ endDate: new Date('2026-10-09T23:59:59.999+05:30') }), ctx());
    assert.equal(gone.reason, 'expired');
    assert.match(gone.message, /expired on 9 Oct 2026/);
});

test('the expire date is usable to the end of that day', () => {
    const lastDay = coupon({ endDate: new Date('2026-10-10T23:59:59.999+05:30') });
    assert.equal(evaluateCoupon(lastDay, ctx()).ok, true);
    // A row saved as a bare midnight (older data) also means the whole day.
    const midnight = coupon({ endDate: new Date('2026-10-10T00:00:00.000Z') });
    assert.equal(evaluateCoupon(midnight, ctx()).ok, true);
});

test('store wise: only the named restaurant', () => {
    const c = coupon({ couponType: 'store_wise', restaurantScope: 'selected', restaurantIds: [REST] });
    assert.equal(evaluateCoupon(c, ctx()).ok, true);
    const elsewhere = evaluateCoupon(c, ctx({ restaurantId: REST2 }));
    assert.equal(elsewhere.reason, 'wrong_restaurant');
    // The older single-column form still works.
    const single = coupon({ restaurantScope: 'selected', restaurantId: REST });
    assert.equal(evaluateCoupon(single, ctx()).ok, true);
    assert.equal(evaluateCoupon(single, ctx({ restaurantId: REST2 })).ok, false);
});

test('zone wise: only orders in a named zone', () => {
    const c = coupon({ couponType: 'zone_wise', zoneIds: [ZONE] });
    assert.equal(evaluateCoupon(c, ctx()).ok, true);
    assert.equal(evaluateCoupon(c, ctx({ zoneId: ZONE2 })).reason, 'wrong_zone');
    // An order with no zone cannot be shown to be in one.
    assert.equal(evaluateCoupon(c, ctx({ zoneId: null })).reason, 'wrong_zone');
});

test('free delivery waives the delivery fee and its GST, and nothing else', () => {
    const c = coupon({ couponType: 'free_delivery', discountType: 'flat_price', discountValue: 0 });
    const r = evaluateCoupon(c, ctx());
    assert.equal(r.ok, true);
    assert.equal(r.discount, 0, 'no item discount');
    assert.equal(r.deliveryFeeWaived, 47.2);
    // Min purchase still applies to it.
    assert.equal(evaluateCoupon({ ...c, minOrderValue: 999 }, ctx()).reason, 'min_purchase');
});

test('first order: only while the customer has no counted order', () => {
    const c = coupon({ couponType: 'first_order', isFirstOrderOnly: true });
    assert.equal(evaluateCoupon(c, ctx({ priorOrders: 0 })).ok, true);
    const r = evaluateCoupon(c, ctx({ priorOrders: 1 }));
    assert.equal(r.reason, 'not_first_order');
    assert.equal(evaluateCoupon(c, ctx({ userId: null, priorOrders: 0 })).reason, 'login_required');
});

test('the older first-time flags still mean first order', () => {
    assert.equal(requiresFirstOrder(coupon({ customerScope: 'first_time' })), true);
    assert.equal(requiresFirstOrder(coupon({ isFirstOrderOnly: true })), true);
    assert.equal(effectiveCouponType(coupon({ isFirstOrderOnly: true })), 'first_order');
    assert.equal(effectiveCouponType(coupon({ restaurantScope: 'selected' })), 'store_wise');
    assert.equal(effectiveCouponType(coupon()), 'default');
});

test('customer restriction: only the named customers', () => {
    const c = coupon({ customerScope: 'specific', customerIds: [USER] });
    assert.equal(evaluateCoupon(c, ctx()).ok, true);
    assert.equal(evaluateCoupon(c, ctx({ userId: OTHER })).reason, 'not_eligible');
    assert.equal(evaluateCoupon(c, ctx({ userId: undefined })).reason, 'login_required');
    // An empty list lets nobody in.
    assert.equal(evaluateCoupon(coupon({ customerScope: 'specific', customerIds: [] }), ctx()).ok, false);
});

test('limit for the same user counts that customer\'s uses', () => {
    const c = coupon({ perUserLimit: 2 });
    assert.equal(evaluateCoupon(c, ctx({ userUses: 1 })).ok, true);
    const r = evaluateCoupon(c, ctx({ userUses: 2 }));
    assert.equal(r.reason, 'user_limit_reached');
    assert.match(r.message, /maximum number of times/);
});

test('the overall usage limit still applies; 0 means unlimited', () => {
    assert.equal(evaluateCoupon(coupon({ usageLimit: 5, usedCount: 5 }), ctx()).reason, 'limit_reached');
    assert.equal(evaluateCoupon(coupon({ usageLimit: 0, usedCount: 5 }), ctx()).ok, true);
});

test('cancelled, unpaid and failed-payment orders do not count', () => {
    assert.deepEqual(
        [...USED_ORDER_WHERE.orderStatus.notIn].sort(),
        ['cancelled_by_admin', 'cancelled_by_restaurant', 'cancelled_by_user', 'pending_payment'],
    );
    assert.deepEqual(USED_ORDER_WHERE.paymentStatus, { not: 'failed' });
});
