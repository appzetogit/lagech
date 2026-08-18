import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../../config/prisma.js';
import { uniquePhone, uniqueTag } from '../../../../utils/testIds.js';
import { testPatch } from '../../../../utils/testGeo.js';
import {
    calculateOrder,
    createOrder,
    getOrderById,
    cancelOrder,
    listOrdersUser,
} from './order.service.js';

/**
 * The order lifecycle, through the real entry points.
 *
 * Everything here goes through createOrder() with the DTO a controller passes,
 * rather than through hand-built rows. Fixtures assembled from the schema
 * instead of from the call site are what produced a confident wrong claim
 * earlier in this work: a raw Prisma row made the ledger writer look broken
 * when production maps the row first and it was fine.
 */
const HERE = testPatch(7);

const created = { zones: [], restaurants: [], users: [], foods: [], categories: [], orders: [] };
let restaurantId = null;
let userId = null;
let foodId = null;
let tag = null;

const address = () => ({
    label: 'Home',
    fullName: 'Test Customer',
    street: '1 Test Street',
    city: 'Indore',
    state: 'MP',
    zipCode: '452001',
    phone: uniquePhone('5'),
    latitude: HERE.lat,
    longitude: HERE.lng,
});

test.before(async () => {
    tag = uniqueTag('Flow');

    const zone = await prisma.foodZone.create({
        data: { name: `${tag} Zone`, coordinates: HERE.ring, isActive: true },
    });
    created.zones.push(zone.id);

    const restaurant = await prisma.foodRestaurant.create({
        data: {
            restaurantName: `${tag} Kitchen`,
            ownerName: 'Owner',
            ownerPhone: uniquePhone('9'),
            status: 'approved',
            zoneId: zone.id,
            latitude: HERE.lat,
            longitude: HERE.lng,
            isAcceptingOrders: true,
            // Hours are wall-clock dependent; the override keeps the fixture
            // deterministic whatever time the suite runs at.
            outsideHoursOverride: true,
        },
    });
    created.restaurants.push(restaurant.id);
    restaurantId = restaurant.id;

    const category = await prisma.foodCategory.create({
        data: { name: `${tag} Mains`, restaurantId, approvalStatus: 'approved' },
    });
    created.categories.push(category.id);

    const food = await prisma.foodItem.create({
        data: {
            restaurantId,
            categoryId: category.id,
            categoryName: category.name,
            name: `${tag} Biryani`,
            price: 250,
            approvalStatus: 'approved',
            isAvailable: true,
        },
    });
    created.foods.push(food.id);
    foodId = food.id;

    const user = await prisma.foodUser.create({
        data: { name: `${tag} Customer`, phone: uniquePhone('5') },
    });
    created.users.push(user.id);
    userId = user.id;
});

test.after(async () => {
    const orders = await prisma.foodOrder.findMany({
        where: { restaurantId: { in: created.restaurants } }, select: { id: true },
    });
    const ids = orders.map((o) => o.id);
    await prisma.foodTransaction.deleteMany({ where: { orderId: { in: ids } } });
    await prisma.orderItem.deleteMany({ where: { orderId: { in: ids } } });
    await prisma.orderStatusHistory.deleteMany({ where: { orderId: { in: ids } } });
    await prisma.foodOrder.deleteMany({ where: { id: { in: ids } } });
    await prisma.foodItem.deleteMany({ where: { id: { in: created.foods } } });
    await prisma.foodCategory.deleteMany({ where: { id: { in: created.categories } } });
    await prisma.foodUser.deleteMany({ where: { id: { in: created.users } } });
    await prisma.foodRestaurant.deleteMany({ where: { id: { in: created.restaurants } } });
    await prisma.foodZone.deleteMany({ where: { id: { in: created.zones } } });
    await prisma.$disconnect();
});

const cartOf = (quantity = 2) => ({
    restaurantId,
    items: [{ itemId: foodId, quantity }],
    address: address(),
    paymentMethod: 'cash',
});

test('the cart totals before anything is written', async () => {
    const quote = await calculateOrder(userId, cartOf(2));

    assert.ok(quote, 'a quote comes back');
    // Two of a 250 dish. Everything else layers on top of this.
    assert.equal(Number(quote.pricing.subtotal), 500);
    assert.ok(Number(quote.pricing.total) >= 500, 'the total is at least the subtotal');
    assert.equal(quote.items.length, 1);
});

test('a cash order is written with the money the quote promised', async () => {
    const quote = await calculateOrder(userId, cartOf(2));
    const { order } = await createOrder(userId, cartOf(2));

    assert.ok(order, 'an order comes back');
    assert.match(order.orderId, /^FOD-/, 'it gets a readable display id');
    created.orders.push(order._id || order.id);

    // What the customer was quoted is what the order records.
    assert.equal(Number(order.pricing.subtotal), Number(quote.pricing.subtotal));
    assert.equal(Number(order.pricing.total), Number(quote.pricing.total));
    assert.equal(order.paymentMethod || order.payment?.method, 'cash');

    // And the columns behind that view agree with it.
    const row = await prisma.foodOrder.findUnique({ where: { id: order._id || order.id } });
    assert.equal(Number(row.subtotal), 500);
    assert.equal(Number(row.total), Number(order.pricing.total));
    assert.equal(row.restaurantId, restaurantId);
    assert.equal(row.userId, userId);
});

test('the order carries its items', async () => {
    const { order } = await createOrder(userId, cartOf(3));
    const id = order._id || order.id;
    created.orders.push(id);

    const items = await prisma.orderItem.findMany({ where: { orderId: id } });
    assert.equal(items.length, 1, 'one line for one dish');
    assert.equal(items[0].quantity, 3);
    assert.equal(Number(items[0].price), 250);
});

test('a cash order books its ledger row', async () => {
    const { order } = await createOrder(userId, cartOf(1));
    const id = order._id || order.id;
    created.orders.push(id);

    // The row every finance report and settlement reads.
    const tx = await prisma.foodTransaction.findUnique({ where: { orderId: id } });
    assert.ok(tx, 'a transaction is written for a cash order');
    assert.equal(Number(tx.totalCustomerPaid), Number(order.pricing.total));
    assert.equal(tx.paymentMethod, 'cash');
    assert.ok(Number(tx.restaurantShare) > 0, 'the restaurant is credited something');
});

test('the customer can read their order back', async () => {
    const { order } = await createOrder(userId, cartOf(1));
    const id = order._id || order.id;
    created.orders.push(id);

    const fetched = await getOrderById(id, { userId });
    assert.equal(fetched.orderId, order.orderId);
    assert.equal(Number(fetched.pricing.total), Number(order.pricing.total));

    const { data } = await listOrdersUser(userId, {});
    assert.ok(data.some((o) => (o._id || o.id) === id), 'it appears in their list');
});

test('cancelling refunds the right amount and blocks a second cancel', async () => {
    const { order } = await createOrder(userId, cartOf(2));
    const id = order._id || order.id;
    created.orders.push(id);

    const cancelled = await cancelOrder(id, userId, 'changed my mind');
    assert.match(String(cancelled.order?.orderStatus ?? cancelled.orderStatus), /cancelled/);

    const row = await prisma.foodOrder.findUnique({ where: { id } });
    assert.match(row.orderStatus, /^cancelled/);
    // A cash order was never charged, so there is nothing to refund.
    assert.equal(Number(row.refundAmount), 0);

    // Cancelling twice must not run the refund path again.
    await assert.rejects(() => cancelOrder(id, userId, 'again'), /cannot be cancelled/i);
});

test('another customer cannot see or cancel this order', async () => {
    const { order } = await createOrder(userId, cartOf(1));
    const id = order._id || order.id;
    created.orders.push(id);

    const stranger = await prisma.foodUser.create({ data: { phone: uniquePhone('5') } });
    created.users.push(stranger.id);

    await assert.rejects(() => cancelOrder(id, stranger.id, 'not mine'), /not found/i);

    const { data } = await listOrdersUser(stranger.id, {});
    assert.ok(!data.some((o) => (o._id || o.id) === id), 'it is not in a stranger\'s list');
});

test('an order for a dish that is not on the menu is refused', async () => {
    // A well-formed id for a dish that does not exist — not a malformed key,
    // which would fail for the wrong reason and prove nothing.
    await assert.rejects(
        () => createOrder(userId, { ...cartOf(1), items: [{ itemId: 'a'.repeat(24), quantity: 1 }] }),
    );
    await assert.rejects(() => createOrder(userId, { ...cartOf(1), items: [] }));
    await assert.rejects(() => createOrder(userId, { ...cartOf(1), restaurantId: 'not-an-id' }));
});
