import test from 'node:test';
import assert from 'node:assert/strict';

import { toOrder, fromOrder } from './order.mapper.js';

/**
 * Pure shape checks — no database. Everything downstream (order.helpers.js, the
 * delivery/restaurant/admin services, the socket payloads, both frontends) reads
 * orders by nested path, so a mapper regression breaks all of it silently.
 */

const row = {
    id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
    order_id: 'FOD-1234567890',
    userId: 'bbbbbbbbbbbbbbbbbbbbbbbb',
    restaurantId: 'cccccccccccccccccccccccc',
    orderStatus: 'picked_up',

    addrLabel: 'Home',
    addrName: '',
    addrFullName: 'A Customer',
    addrStreet: '12 Example Road',
    addrAdditionalDetails: 'Flat 3',
    addrCity: 'Pune',
    addrState: 'MH',
    addrZipCode: '411001',
    addrPhone: '9999999999',
    addrLat: 18.52,
    addrLng: 73.85,

    subtotal: '450.00',
    tax: '22.50',
    packagingFee: '10.00',
    deliveryFee: '35.00',
    deliveryFeeGst: '6.30',
    platformFee: '5.00',
    quickDeliveryFee: '0.00',
    deliveryMode: 'basic',
    restaurantCommission: '67.50',
    discount: '50.00',
    couponCode: 'SAVE50',
    total: '478.80',
    currency: 'INR',
    distanceKm: '3.20',
    roadDistanceKm: '4.10',
    roadDurationMins: 14,

    paymentMethod: 'razorpay',
    paymentStatus: 'paid',
    paymentAmountDue: '0.00',
    razorpayOrderId: 'order_ABC',
    razorpayPaymentId: 'pay_XYZ',
    razorpaySignature: 'sig',
    qr: null,
    refundStatus: 'none',
    refundAmount: '0.00',
    refundId: '',
    refundProcessedAt: null,

    dispatchStatus: 'accepted',
    dispatchDeliveryPartnerId: 'dddddddddddddddddddddddd',
    dispatchAssignedAt: new Date('2026-01-01T10:00:00Z'),
    dispatchAcceptedAt: new Date('2026-01-01T10:01:00Z'),
    dispatchingAt: null,

    deliveryPhase: 'en_route_to_delivery',
    deliveryStatus: '',
    reachedPickupAt: new Date('2026-01-01T10:10:00Z'),
    reachedDropAt: null,
    pickedUpAt: new Date('2026-01-01T10:12:00Z'),
    deliveredAt: null,

    restaurantRating: 5,
    restaurantRatingComment: 'great',
    restaurantRatedAt: new Date('2026-01-01T11:00:00Z'),
    partnerRating: null,
    partnerRatingComment: '',
    partnerRatedAt: null,
    customerRating: null,
    customerRatingComment: '',
    customerRatedAt: null,

    dropOtpRequired: true,
    dropOtpVerified: false,

    riderLat: 18.53,
    riderLng: 73.86,

    riderEarning: '40.00',
    platformProfit: '-12.50',
    tripDistanceKm: '4.10',
    tripDurationMins: 14,

    items: [
        { id: 'i1', itemId: 'f1', name: 'Biryani', price: '250.00', variantPrice: '0.00', otherPrice: '300.00', quantity: 1, addons: [] },
        { id: 'i2', itemId: 'f2', name: 'Naan', price: '100.00', variantPrice: '0.00', otherPrice: '0.00', quantity: 2, addons: [] }
    ],
    itemRatings: [{ itemId: 'f1', name: 'Biryani', rating: 5, comment: '', ratedAt: new Date('2026-01-01T11:00:00Z') }],
    statusHistory: [{ id: 'h1', at: new Date('2026-01-01T09:59:00Z'), byRole: 'USER', from: null, to: 'created', note: '' }],
    dispatchOffers: [{ partnerId: 'dddddddddddddddddddddddd', at: new Date('2026-01-01T10:00:00Z'), action: 'offered' }]
};

test('flat row rebuilds the nested shape callers read by path', () => {
    const order = toOrder(row);

    assert.equal(order.pricing.total, 478.8);
    assert.equal(order.pricing.couponCode, 'SAVE50');
    assert.equal(order.payment.method, 'razorpay');
    assert.equal(order.payment.status, 'paid');
    assert.equal(order.payment.razorpay.paymentId, 'pay_XYZ');
    assert.equal(order.payment.refund.status, 'none');
    assert.equal(order.dispatch.deliveryPartnerId, 'dddddddddddddddddddddddd');
    assert.equal(order.dispatch.status, 'accepted');
    assert.equal(order.deliveryState.currentPhase, 'en_route_to_delivery');
    assert.ok(order.deliveryState.pickedUpAt instanceof Date);
    assert.equal(order.deliveryAddress.street, '12 Example Road');
    assert.equal(order.ratings.restaurant.rating, 5);
    assert.equal(order.ratings.deliveryPartner, undefined);
    assert.equal(order.ratings.items[0].itemId, 'f1');
    assert.equal(order.deliveryVerification.dropOtp.required, true);
});

test('money comes back as numbers, not Decimal strings', () => {
    const order = toOrder(row);

    assert.equal(typeof order.pricing.total, 'number');
    assert.equal(typeof order.items[0].price, 'number');
    assert.equal(order.items[0].price, 250);
    // Negative platform profit must survive — it is real, not an error state.
    assert.equal(order.platformProfit, -12.5);
});

test('geo points come back as GeoJSON in [lng, lat] order', () => {
    const order = toOrder(row);

    assert.deepEqual(order.lastRiderLocation, { type: 'Point', coordinates: [73.86, 18.53] });
    assert.deepEqual(order.deliveryAddress.location, { type: 'Point', coordinates: [73.85, 18.52] });
});

test('a missing rider fix yields no point rather than a broken one', () => {
    const order = toOrder({ ...row, riderLat: null, riderLng: null });
    assert.equal(order.lastRiderLocation, undefined);
});

test('orderId falls back to the row id when there is no display id', () => {
    assert.equal(toOrder(row).orderId, 'FOD-1234567890');
    assert.equal(toOrder({ ...row, order_id: null }).orderId, 'aaaaaaaaaaaaaaaaaaaaaaaa');
});

test('nested writes flatten back to columns', () => {
    const data = fromOrder({
        orderStatus: 'delivered',
        pricing: { total: 500, deliveryFee: 40 },
        payment: { status: 'paid', razorpay: { paymentId: 'pay_1' } },
        dispatch: { status: 'accepted', deliveryPartnerId: 'd1' },
        deliveryState: { currentPhase: 'delivered', deliveredAt: new Date('2026-01-01T12:00:00Z') },
        deliveryAddress: { street: 'x', location: { type: 'Point', coordinates: [73.85, 18.52] } },
        lastRiderLocation: { type: 'Point', coordinates: [73.86, 18.53] }
    });

    assert.equal(data.orderStatus, 'delivered');
    assert.equal(data.total, 500);
    assert.equal(data.deliveryFee, 40);
    assert.equal(data.paymentStatus, 'paid');
    assert.equal(data.razorpayPaymentId, 'pay_1');
    assert.equal(data.dispatchDeliveryPartnerId, 'd1');
    assert.equal(data.deliveryPhase, 'delivered');
    assert.equal(data.addrStreet, 'x');
    assert.equal(data.addrLat, 18.52);
    assert.equal(data.addrLng, 73.85);
    assert.equal(data.riderLat, 18.53);
});

test('a partial write emits only the keys given', () => {
    const data = fromOrder({ payment: { status: 'failed' } });

    assert.deepEqual(Object.keys(data), ['paymentStatus']);
});

test('relations are never written through the mapper', () => {
    // items/statusHistory are child tables; letting the mapper touch them would
    // turn every partial update into a delete-and-recreate.
    const data = fromOrder({ items: [{ name: 'x' }], statusHistory: [{ to: 'created' }], orderStatus: 'created' });

    assert.equal(data.items, undefined);
    assert.equal(data.statusHistory, undefined);
    assert.equal(data.orderStatus, 'created');
});

test('round-trips without losing the nested values', () => {
    const order = toOrder(row);
    const flat = fromOrder(order);

    assert.equal(flat.total, 478.8);
    assert.equal(flat.paymentStatus, 'paid');
    assert.equal(flat.dispatchStatus, 'accepted');
    assert.equal(flat.addrCity, 'Pune');
    assert.equal(flat.restaurantRating, 5);
    assert.equal(flat.riderLat, 18.53);
});
