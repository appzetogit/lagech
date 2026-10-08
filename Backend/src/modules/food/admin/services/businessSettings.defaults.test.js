import test from 'node:test';
import assert from 'node:assert/strict';

import { BUSINESS_SETTINGS_AREAS, BUSINESS_AREA_CATALOG, PRIORITY_SECTIONS, cleanReasons } from './businessSettings.defaults.js';

const clean = (area, value = {}) => BUSINESS_SETTINGS_AREAS[area](value);

test('every business area cleans {} to the old panel values', () => {
    for (const area of Object.keys(BUSINESS_SETTINGS_AREAS)) {
        assert.ok(clean(area), area);
        assert.ok(BUSINESS_AREA_CATALOG[area], `${area} has a catalog`);
    }
    assert.deepEqual(clean('business_info'), {
        commissionModel: true,
        subscriptionModel: false,
        defaultCommissionPercent: 15,
        deliveryChargeCommissionPercent: 20,
        riderPayMode: 'bands',
        currency: 'INR',
        currencyDecimals: 0,
        additionalCharge: { enabled: false, name: '', amount: 0 },
    });
    assert.equal(clean('business_deliveryman').maxAssignedOrders, 2);
    assert.equal(clean('business_deliveryman').riderCanCancelOrder, false);
    assert.equal(clean('business_order').scheduledOrder, false);
    assert.equal(clean('business_order').homeDelivery, true);
    assert.equal(clean('business_order').orderConfirmedBy, 'restaurant');
    assert.deepEqual(clean('business_payment'), { cod: true, digital: true, partialPayment: true, partialPaymentMethod: 'both' });
    assert.equal(clean('business_customer').walletEnabled, true);
    assert.equal(clean('business_customer').addFundEnabled, false);
    assert.equal(clean('business_vendor').restaurantCanCancelOrder, false);
    assert.equal(clean('business_vendor').dishApprovalRequired, true, 'kept on: dishes have always needed approval here');
    assert.deepEqual(clean('business_disbursement').rider, { enabled: true, runTime: '01:01', minAmount: 1, waitingDays: 1 });
    assert.deepEqual(clean('business_refund'), { refundRequestEnabled: true, requestWindowHours: 24, reasons: [] });
});

test('numbers are range-checked, blanks fall back', () => {
    assert.equal(clean('business_deliveryman', { maxAssignedOrders: '3' }).maxAssignedOrders, 3);
    assert.equal(clean('business_deliveryman', { maxAssignedOrders: '' }).maxAssignedOrders, 2);
    assert.throws(() => clean('business_deliveryman', { maxAssignedOrders: 0 }), /between 1 and 10/);
    assert.throws(() => clean('business_deliveryman', { maxAssignedOrders: 1.5 }), /whole number/);
    assert.throws(() => clean('business_info', { defaultCommissionPercent: 101 }), /between 0 and 100/);
    assert.throws(() => clean('business_info', { deliveryChargeCommissionPercent: 'x' }), /must be a number/);
    assert.equal(clean('business_info', { riderPayMode: 'nonsense' }).riderPayMode, 'bands');
    assert.equal(clean('business_info', { riderPayMode: 'percentage' }).riderPayMode, 'percentage');
    assert.equal(clean('business_info', { currency: 'USD' }).currency, 'INR', 'the currency is fixed');
});

test('switch combinations that would leave nothing to use are refused', () => {
    assert.throws(() => clean('business_payment', { cod: false, digital: false }), /at least one/);
    assert.throws(() => clean('business_order', { homeDelivery: false, takeaway: false }), /at least one/);
    assert.throws(() => clean('business_order', { freeDelivery: { enabled: true, minSubtotal: 0 } }), /free/);
    assert.throws(() => clean('business_customer', { newCustomerDiscount: { enabled: true, value: 0 } }), /discount/);
    assert.throws(() => clean('business_customer', { newCustomerDiscount: { type: 'percent', value: 120 } }), /between 0 and 100/);
    assert.throws(() => clean('business_disbursement', { rider: { runTime: '25:00' } }), /HH:MM/);
});

test('reason lists keep ids, drop blanks and refuse duplicates', () => {
    const first = cleanReasons(['Food was cold', { text: '  ' }, { text: 'Item missing', isActive: false }], 'reasons');
    assert.equal(first.length, 2);
    assert.match(first[0].id, /^[a-f0-9]{12}$/);
    assert.equal(first[1].isActive, false);
    const again = cleanReasons(first, 'reasons');
    assert.deepEqual(again.map((r) => r.id), first.map((r) => r.id));
    assert.throws(() => cleanReasons(['Late', 'late'], 'reasons'), /listed twice/);
    const area = clean('business_order_issue_reasons', { reasons: ['Wrong item'] });
    assert.equal(area.reasons[0].text, 'Wrong item');
});

test('priority setup: default unless custom, sort limited to the section', () => {
    const value = clean('business_priority', {
        sections: { search: { mode: 'custom', sort: 'newest' }, allRestaurants: { mode: 'custom', sort: 'bogus' } },
    });
    assert.deepEqual(Object.keys(value.sections), PRIORITY_SECTIONS.map((s) => s.key));
    assert.deepEqual(value.sections.search, { mode: 'custom', sort: 'newest' });
    assert.equal(value.sections.allRestaurants.sort, 'rating', 'an unknown sort falls back to the first');
    assert.equal(value.sections.recommended.mode, 'default');
});
