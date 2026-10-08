import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../src/config/prisma.js';
import { mapLegacyCoupon } from './coupons.mjs';

/**
 * The legacy coupon mapping, on rows shaped like the backup's (the two food
 * coupons it holds are the first two cases).
 */
const R7 = 'a'.repeat(24);
const Z1 = 'b'.repeat(24);
const U6 = 'c'.repeat(24);
const maps = {
    restaurants: new Map([['7', R7]]),
    zones: new Map([['1', Z1]]),
    users: new Map([['6', U6]]),
};
const row = (over = {}) => ({
    id: 1, title: 'T', code: 'CODE', start_day: '2026-07-09', expire_day: '2026-07-15',
    min_purchase: '0.00', max_discount: '0.00', discount: '10.00', discount_type: 'percent',
    coupon_type: 'default', limit: null, status: 1, data: '', total_uses: 0,
    created_by: 'admin', customer_id: '["all"]', store_id: null, created_at: new Date('2026-07-09T00:49:43Z'),
    ...over,
});

test.after(() => prisma.$disconnect());

test('a free-delivery coupon for one customer', () => {
    const { data, warnings, skip } = mapLegacyCoupon(row({
        title: '🎉 LAGECH APP STORY OFFER 🎉', code: 'LAGECHAPPSTO', coupon_type: 'free_delivery',
        discount: '0.00', discount_type: '', customer_id: '["6"]',
    }), maps);
    assert.equal(skip, undefined);
    assert.deepEqual(warnings, []);
    assert.equal(data.couponType, 'free_delivery');
    assert.equal(data.discountValue, 0);
    assert.equal(data.customerScope, 'specific');
    assert.deepEqual(data.customerIds, [U6]);
    assert.equal(data.createdByRole, 'ADMIN');
    assert.equal(data.startDate.toISOString(), '2026-07-08T18:30:00.000Z');
    assert.equal(data.endDate.toISOString(), '2026-07-15T18:29:59.999Z');
    assert.equal(data.status, 'active');
});

test("a vendor's default coupon becomes its restaurant's store wise coupon", () => {
    const { data } = mapLegacyCoupon(row({
        code: '10% Discount', created_by: 'vendor', store_id: '7', discount: '10.00', discount_type: 'percent',
    }), maps);
    assert.equal(data.couponCode, '10% DISCOUNT');
    assert.equal(data.couponType, 'store_wise');
    assert.equal(data.restaurantScope, 'selected');
    assert.deepEqual(data.restaurantIds, [R7]);
    assert.equal(data.createdByRole, 'RESTAURANT');
    assert.equal(data.restaurantBearPercentage, 100);
    assert.equal(data.maxDiscount, null, 'max_discount 0 is no cap');
    assert.equal(data.discountType, 'percentage');
});

test('store and zone lists go through the id map', () => {
    const zone = mapLegacyCoupon(row({ coupon_type: 'zone_wise', data: '["1"]' }), maps).data;
    assert.deepEqual(zone.zoneIds, [Z1]);
    const store = mapLegacyCoupon(row({ coupon_type: 'store_wise', data: '["7"]', discount_type: 'amount', limit: 3 }), maps).data;
    assert.deepEqual(store.restaurantIds, [R7]);
    assert.equal(store.discountType, 'flat_price');
    assert.equal(store.perUserLimit, 3);
});

test('a restriction that cannot be mapped is imported switched off, never open', () => {
    const lostZone = mapLegacyCoupon(row({ coupon_type: 'zone_wise', data: '["99"]' }), maps);
    assert.equal(lostZone.data.status, 'inactive');
    assert.ok(lostZone.warnings.some((w) => /zones were imported/.test(w)));

    const lostCustomer = mapLegacyCoupon(row({ customer_id: '["404"]' }), maps);
    assert.equal(lostCustomer.data.customerScope, 'specific');
    assert.deepEqual(lostCustomer.data.customerIds, []);
    assert.equal(lostCustomer.data.status, 'inactive');
});

test('rows that cannot be a coupon are skipped with a reason', () => {
    assert.equal(mapLegacyCoupon(row({ code: '  ' }), maps).skip, 'no code');
    assert.match(mapLegacyCoupon(row({ coupon_type: 'weird' }), maps).skip, /unknown coupon type/);
    assert.equal(mapLegacyCoupon(row({ status: 0 }), maps).data.status, 'inactive');
    assert.equal(mapLegacyCoupon(row({ coupon_type: 'first_order' }), maps).data.isFirstOrderOnly, true);
});
