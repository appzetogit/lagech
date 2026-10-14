import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../../config/prisma.js';
import { uniquePhone, uniqueTag } from '../../../../utils/testIds.js';
import { getAdminOrderDetailsExtras, pickLastLocation } from './adminOrderDetails.service.js';

/**
 * The admin Order Details page's extras, against the real database: the
 * previous/next arrows, the customer/store order counts, the deliveryman's
 * delivered count and last location.
 */
const created = { users: [], restaurants: [], partners: [], orders: [] };
const ctx = {};

// Far in the future, so no other order sits between these three.
const at = (sec) => new Date(Date.UTC(2099, 0, 1, 0, 0, sec));

const makeOrder = async (over = {}) => {
    const order = await prisma.foodOrder.create({
        data: {
            userId: ctx.user.id,
            restaurantId: ctx.restaurant.id,
            order_id: `FOD-${uniqueTag('d')}`.slice(0, 32),
            orderStatus: 'confirmed',
            paymentMethod: 'cash',
            paymentStatus: 'cod_pending',
            addrStreet: '1 Test Street',
            addrCity: 'Phaltan',
            addrState: 'MH',
            subtotal: 190,
            total: 240,
            ...over,
        },
    });
    created.orders.push(order.id);
    return order;
};

test.before(async () => {
    ctx.restaurant = await prisma.foodRestaurant.create({
        data: {
            restaurantName: `${uniqueTag('Od')} Cafe`, ownerName: 'Owner', ownerPhone: uniquePhone('9'),
            ownerEmail: 'owner@example.test', status: 'approved', area: 'Nalari bag', city: 'Phaltan',
        },
    });
    created.restaurants.push(ctx.restaurant.id);
    ctx.user = await prisma.foodUser.create({ data: { name: `${uniqueTag('Od')} Customer`, phone: uniquePhone('5'), email: 'c@example.test' } });
    created.users.push(ctx.user.id);
    ctx.partner = await prisma.foodDeliveryPartner.create({
        data: { name: 'Rider O', phone: uniquePhone('7'), status: 'approved', lastLat: 17.99, lastLng: 74.43, lastLocationAt: new Date() },
    });
    created.partners.push(ctx.partner.id);

    ctx.older = await makeOrder({ createdAt: at(1), orderStatus: 'delivered', dispatchDeliveryPartnerId: ctx.partner.id, dispatchStatus: 'accepted' });
    ctx.order = await makeOrder({ createdAt: at(2), dispatchDeliveryPartnerId: ctx.partner.id, dispatchStatus: 'assigned' });
    // An unpaid online checkout is not in the admin list, so not a neighbour either.
    ctx.unpaid = await makeOrder({ createdAt: at(3), orderStatus: 'pending_payment', paymentMethod: 'razorpay', paymentStatus: 'created' });
    ctx.newer = await makeOrder({ createdAt: at(4) });
});

test.after(async () => {
    await prisma.foodOrder.deleteMany({ where: { id: { in: created.orders } } });
    await prisma.foodDeliveryPartner.deleteMany({ where: { id: { in: created.partners } } });
    await prisma.foodUser.deleteMany({ where: { id: { in: created.users } } });
    await prisma.foodRestaurant.deleteMany({ where: { id: { in: created.restaurants } } });
    await prisma.$disconnect();
});

test('last location: the rider\'s own ping first, then the one on the order', () => {
    const when = new Date('2026-10-14T10:00:00Z');
    assert.deepEqual(pickLastLocation({ lastLat: 1, lastLng: 2, lastLocationAt: when }, { riderLat: 3, riderLng: 4 }), { lat: 1, lng: 2, at: when, source: 'partner' });
    assert.deepEqual(pickLastLocation({ lastLat: null, lastLng: null }, { riderLat: 3, riderLng: 4 }), { lat: 3, lng: 4, at: null, source: 'order' });
    assert.equal(pickLastLocation(null, { riderLat: null, riderLng: null }), null);
});

test('previous/next skip unpaid checkouts; counts and cards come with the order', async () => {
    const d = await getAdminOrderDetailsExtras(ctx.order.id);
    assert.equal(d.previousOrder.id, ctx.older.id);
    assert.equal(d.nextOrder.id, ctx.newer.id, 'the unpaid checkout in between is skipped');
    assert.equal(d.nextOrder.orderId, ctx.newer.order_id);

    assert.equal(d.customer.id, ctx.user.id);
    assert.equal(d.customer.orderCount, 3);
    assert.equal(d.restaurant.orderCount, 3);
    assert.equal(d.restaurant.email, 'owner@example.test');
    assert.equal(d.restaurant.address, 'Nalari bag, Phaltan');

    assert.equal(d.deliveryPartner.id, ctx.partner.id);
    assert.equal(d.deliveryPartner.deliveredCount, 1);
    assert.equal(d.lastLocation.source, 'partner');
    assert.equal(d.lastLocation.lat, 17.99);
});

test('found by display id too; no rider means no rider card or location', async () => {
    const d = await getAdminOrderDetailsExtras(ctx.newer.order_id);
    assert.equal(d.previousOrder.id, ctx.order.id);
    assert.equal(d.deliveryPartner, null);
    assert.equal(d.lastLocation, null);
    await assert.rejects(() => getAdminOrderDetailsExtras('FOD-does-not-exist'), /not found/i);
});
