import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../../config/prisma.js';
import { recordTransaction } from '../../../../core/payments/transaction.service.js';
import { getCustomerById, getCustomerOrders } from './adminCustomer.service.js';
import { uniquePhone } from '../../../../utils/testIds.js';

/**
 * The admin Customer Details page (the old panel's customer view): the
 * customer with their stat cards and saved addresses, and their own order list
 * with search. Everything is created under a unique tag and removed afterwards.
 */
const tag = `T${Date.now()}`;
const created = { users: [], restaurants: [], orders: [] };

let user;
let other;
let restaurant;
const orders = {};

const makeOrder = async (owner, { total, orderStatus, displayId }) => {
    const order = await prisma.foodOrder.create({
        data: {
            order_id: displayId,
            userId: owner.id,
            restaurantId: restaurant.id,
            orderStatus,
            paymentMethod: 'cash',
            addrStreet: '1 Test Street',
            addrCity: 'Indore',
            addrState: 'MP',
            subtotal: total,
            total,
        },
    });
    created.orders.push(order.id);
    return order;
};

test.before(async () => {
    user = await prisma.foodUser.create({ data: { name: `${tag} Asha`, phone: uniquePhone('7'), role: 'USER' } });
    other = await prisma.foodUser.create({ data: { name: `${tag} Other`, phone: uniquePhone('7'), role: 'USER' } });
    created.users.push(user.id, other.id);
    restaurant = await prisma.foodRestaurant.create({
        data: { restaurantName: `${tag} Cafe`, ownerName: 'Owner', ownerPhone: uniquePhone('9'), status: 'approved' },
    });
    created.restaurants.push(restaurant.id);

    const id = (n) => `FOD-${tag.slice(-8)}${n}`;
    orders.delivered = await makeOrder(user, { total: 200, orderStatus: 'delivered', displayId: id(1) });
    orders.processing = await makeOrder(user, { total: 240, orderStatus: 'preparing', displayId: id(2) });
    // Abandoned at the payment step: never placed, so neither counted nor listed.
    orders.unpaid = await makeOrder(user, { total: 999, orderStatus: 'pending_payment', displayId: id(3) });
    orders.someoneElse = await makeOrder(other, { total: 50, orderStatus: 'delivered', displayId: id(4) });

    await prisma.userAddress.createMany({
        data: [
            { userId: user.id, label: 'Office', street: '2 Work Road', city: 'Indore', state: 'MP' },
            { userId: user.id, label: 'Home', street: '1 Home Lane', city: 'Indore', state: 'MP', isDefault: true },
        ],
    });
    await recordTransaction({
        entityType: 'user',
        entityId: user.id,
        type: 'credit',
        amount: 75,
        description: 'Test credit',
        category: 'adjustment',
        idempotencyKey: `${tag}:details-credit`,
        metadata: { source: 'admin_add_fund' },
    });
    await prisma.foodLoyaltyPointAccount.create({ data: { userId: user.id, points: 30, totalEarned: 30 } });
});

test.after(async () => {
    await prisma.foodOrder.deleteMany({ where: { id: { in: created.orders } } });
    await prisma.transaction.deleteMany({ where: { entityType: 'user', entityId: { in: created.users } } });
    await prisma.wallet.deleteMany({ where: { entityType: 'user', entityId: { in: created.users } } });
    await prisma.foodLoyaltyPointAccount.deleteMany({ where: { userId: { in: created.users } } });
    await prisma.userAddress.deleteMany({ where: { userId: { in: created.users } } });
    await prisma.foodUser.deleteMany({ where: { id: { in: created.users } } });
    await prisma.foodRestaurant.deleteMany({ where: { id: { in: created.restaurants } } });
    await prisma.$disconnect();
});

test('the detail carries the stat cards, wallet, points and addresses', async () => {
    const detail = await getCustomerById(user.id);

    // Every placed order, as the old panel's Total order card counts them...
    assert.equal(detail.placedOrderCount, 2);
    assert.equal(detail.placedOrderAmount, 440);
    // ...while the list's lifetime figures stay delivered-only.
    assert.equal(detail.totalOrder, 1);
    assert.equal(detail.totalOrderAmount, 200);

    assert.equal(detail.walletBalance, 75);
    assert.equal(detail.loyaltyPoint, 30);

    assert.equal(detail.addresses.length, 2);
    assert.equal(detail.addresses[0].isDefault, true, 'the default address comes first');
    assert.equal(detail.addresses[0].street, '1 Home Lane');
});

test('a customer with nothing yet reports zeros', async () => {
    const detail = await getCustomerById(other.id);
    assert.equal(detail.walletBalance, 0);
    assert.equal(detail.loyaltyPoint, 0);
    assert.deepEqual(detail.addresses, []);
    assert.equal(detail.placedOrderCount, 1);
});

test('the order list holds only this customer\'s placed orders, newest first', async () => {
    const { orders: list, pagination } = await getCustomerOrders(user.id, {});
    assert.equal(pagination.total, 2);
    assert.deepEqual(list.map((o) => o.id), [orders.processing.id, orders.delivered.id]);
    assert.equal(list[0].orderId, orders.processing.order_id);
    assert.equal(list[0].total, 240);
    assert.equal(list[0].restaurantName, restaurant.restaurantName);
});

test('the order list searches by order id and pages', async () => {
    const found = await getCustomerOrders(user.id, { search: orders.delivered.order_id.toLowerCase() });
    assert.deepEqual(found.orders.map((o) => o.id), [orders.delivered.id]);

    // Another customer's order id finds nothing here.
    const foreign = await getCustomerOrders(user.id, { search: orders.someoneElse.order_id });
    assert.equal(foreign.pagination.total, 0);

    const paged = await getCustomerOrders(user.id, { limit: 1, page: 2 });
    assert.deepEqual(paged.orders.map((o) => o.id), [orders.delivered.id]);
    assert.equal(paged.pagination.pages, 2);
});

test('an unknown or malformed customer is null', async () => {
    assert.equal(await getCustomerOrders('a'.repeat(24)), null);
    assert.equal(await getCustomerOrders('not-an-id'), null);
});
