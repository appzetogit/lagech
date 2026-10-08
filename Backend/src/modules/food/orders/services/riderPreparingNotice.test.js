import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../../config/prisma.js';
import { setIOForTests, rooms } from '../../../../config/socket.js';
import { uniquePhone, uniqueTag } from '../../../../utils/testIds.js';
import { updateOrderStatusRestaurant } from './order.service.js';

/**
 * When the restaurant starts preparing, the assigned rider gets an
 * order_status_update at once (the rider app refreshes on it).
 */
const created = { restaurants: [], users: [], partners: [], orders: [] };
const emitted = [];
const fakeIO = { to: (room) => ({ emit: (event, payload) => emitted.push({ room, event, payload }) }) };

test.before(() => setIOForTests(fakeIO));

test.after(async () => {
    setIOForTests(null);
    await prisma.foodOrder.deleteMany({ where: { id: { in: created.orders } } });
    await prisma.foodDeliveryPartner.deleteMany({ where: { id: { in: created.partners } } });
    await prisma.foodRestaurant.deleteMany({ where: { id: { in: created.restaurants } } });
    await prisma.foodUser.deleteMany({ where: { id: { in: created.users } } });
    await prisma.$disconnect();
});

const setup = async ({ withRider = true } = {}) => {
    const restaurant = await prisma.foodRestaurant.create({
        data: { restaurantName: `${uniqueTag('Prep')} Kitchen`, ownerName: 'O', ownerPhone: uniquePhone('9'), status: 'approved', isAcceptingOrders: true },
    });
    created.restaurants.push(restaurant.id);
    const user = await prisma.foodUser.create({ data: { phone: uniquePhone('7') } });
    created.users.push(user.id);
    let rider = null;
    if (withRider) {
        rider = await prisma.foodDeliveryPartner.create({ data: { name: 'Rider', phone: uniquePhone('8'), status: 'approved' } });
        created.partners.push(rider.id);
    }
    const order = await prisma.foodOrder.create({
        data: {
            userId: user.id, restaurantId: restaurant.id, orderStatus: 'confirmed',
            paymentMethod: 'cash', paymentStatus: 'cod_pending', subtotal: 100, total: 150,
            addrStreet: '1 Test Street', addrCity: 'Phaltan', addrState: 'MH',
            ...(rider ? { dispatchStatus: 'accepted', dispatchDeliveryPartnerId: rider.id } : {}),
        },
    });
    created.orders.push(order.id);
    return { restaurant, rider, order };
};

test('moving an order to preparing tells the assigned rider at once', async () => {
    const { restaurant, rider, order } = await setup();
    emitted.length = 0;

    await updateOrderStatusRestaurant(order.id, restaurant.id, 'preparing');

    const toRider = emitted.filter((e) => e.room === rooms.delivery(rider.id) && e.event === 'order_status_update');
    assert.equal(toRider.length, 1, JSON.stringify(emitted.map((e) => [e.room, e.event])));
    assert.equal(toRider[0].payload.orderId, order.id);
    assert.equal(toRider[0].payload.orderStatus, 'preparing');
});

test('no rider assigned yet: nothing is sent to a rider room', async () => {
    const { restaurant, order } = await setup({ withRider: false });
    emitted.length = 0;
    await updateOrderStatusRestaurant(order.id, restaurant.id, 'preparing');
    assert.equal(emitted.filter((e) => e.event === 'order_status_update' && String(e.room).startsWith('delivery')).length, 0);
});
