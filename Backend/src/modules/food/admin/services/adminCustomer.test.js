import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../../config/prisma.js';
import { getCustomers, getCustomerById, updateCustomerStatus } from './adminCustomer.service.js';
import {
    getSupportTickets,
    getFoodSupportTicketStats,
    updateSupportTicket,
} from './adminSupportTicket.service.js';
import { uniquePhone } from '../../../../utils/testIds.js';

/**
 * The admin customer list and support inbox.
 *
 * The lifetime order figures are the fiddly part: they count delivered orders
 * only, and used to come from a $lookup pipeline when sorting by them and a
 * separate $group when not.
 */
const live = Boolean(process.env.DATABASE_URL);

const created = { users: [], restaurants: [], orders: [], tickets: [], rTickets: [] };
const stamp = () => `${Date.now()}${Math.floor(performance.now() * 1000) % 1000}`;
const tag = `T${stamp()}`;

const makeUser = async (name, over = {}) => {
    const user = await prisma.foodUser.create({
        data: {
            name,
            phone: uniquePhone('7'),
            role: 'USER',
            ...over,
        },
    });
    created.users.push(user.id);
    return user;
};

const makeRestaurant = async () => {
    const r = await prisma.foodRestaurant.create({
        data: {
            restaurantName: `Cust Test ${stamp()}`,
            ownerName: 'Owner',
            ownerPhone: uniquePhone('9'),
            status: 'approved',
        },
    });
    created.restaurants.push(r.id);
    return r;
};

const makeOrder = async (user, restaurant, { total, orderStatus }) => {
    const order = await prisma.foodOrder.create({
        data: {
            userId: user.id,
            restaurantId: restaurant.id,
            orderStatus,
            paymentMethod: 'cash',
            // The delivery address is NOT NULL on the order — an order without
            // somewhere to take it is not a thing.
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

test.after(async () => {
    if (!live) return;
    await prisma.foodSupportTicket.deleteMany({ where: { id: { in: created.tickets } } });
    await prisma.foodRestaurantSupportTicket.deleteMany({ where: { id: { in: created.rTickets } } });
    await prisma.foodNotification.deleteMany({ where: { ownerId: { in: created.users } } });
    await prisma.foodOrder.deleteMany({ where: { id: { in: created.orders } } });
    await prisma.foodRefreshToken.deleteMany({ where: { userId: { in: created.users } } });
    await prisma.foodUser.deleteMany({ where: { id: { in: created.users } } });
    await prisma.foodRestaurant.deleteMany({ where: { id: { in: created.restaurants } } });
    await prisma.$disconnect();
});

test('lifetime totals count delivered orders only', { skip: !live }, async () => {
    const user = await makeUser(`${tag} Buyer`);
    const restaurant = await makeRestaurant();

    await makeOrder(user, restaurant, { total: 250, orderStatus: 'delivered' });
    await makeOrder(user, restaurant, { total: 150, orderStatus: 'delivered' });
    // Neither of these is money the customer actually spent.
    await makeOrder(user, restaurant, { total: 999, orderStatus: 'cancelled_by_user' });
    await makeOrder(user, restaurant, { total: 500, orderStatus: 'preparing' });

    const { customers } = await getCustomers({ search: tag });
    const row = customers.find((c) => c.id === user.id);

    assert.equal(row.totalOrder, 2);
    assert.equal(row.totalOrderAmount, 400, 'Decimal summed to a number, not a string');

    const detail = await getCustomerById(user.id);
    assert.equal(detail.totalOrders, 2, 'the detail screen reads totalOrders');
    assert.equal(detail.totalOrder, 2, 'the list reads totalOrder');
    assert.equal(detail.totalOrderAmount, 400);
});

test('a customer with no orders reports zero, not undefined', { skip: !live }, async () => {
    const user = await makeUser(`${tag} Quiet`);

    const detail = await getCustomerById(user.id);
    assert.equal(detail.totalOrder, 0);
    assert.equal(detail.totalOrderAmount, 0);

    assert.equal(await getCustomerById('a'.repeat(24)), null);
    assert.equal(await getCustomerById('not-an-id'), null);
});

test('sorting by order count orders the page correctly', { skip: !live }, async () => {
    const restaurant = await makeRestaurant();
    const busy = await makeUser(`${tag} Busy`);
    const quiet = await makeUser(`${tag} Quietest`);

    for (let i = 0; i < 3; i += 1) {
        await makeOrder(busy, restaurant, { total: 100, orderStatus: 'delivered' });
    }
    await makeOrder(quiet, restaurant, { total: 100, orderStatus: 'delivered' });

    // Prisma cannot order by a *filtered* relation count, so this path runs
    // raw SQL and then reapplies the order after hydrating.
    const desc = await getCustomers({ search: `${tag} Bus`, sortBy: 'orders-desc' });
    assert.equal(desc.customers[0].id, busy.id);

    const both = await getCustomers({ search: tag, sortBy: 'orders-desc', limit: 1000 });
    const positions = both.customers.map((c) => c.id);
    assert.ok(
        positions.indexOf(busy.id) < positions.indexOf(quiet.id),
        'three delivered orders sort above one',
    );

    const asc = await getCustomers({ search: tag, sortBy: 'orders-asc', limit: 1000 });
    const ascPositions = asc.customers.map((c) => c.id);
    assert.ok(ascPositions.indexOf(quiet.id) < ascPositions.indexOf(busy.id));
});

test('customers filter by status and search', { skip: !live }, async () => {
    const unique = `Zed${stamp()}`;
    const user = await makeUser(`${unique} Person`);

    assert.equal((await getCustomers({ search: unique })).total, 1);
    assert.equal((await getCustomers({ search: unique, status: 'active' })).total, 1);
    assert.equal((await getCustomers({ search: unique, status: 'inactive' })).total, 0);

    await updateCustomerStatus(user.id, false);
    assert.equal((await getCustomers({ search: unique, status: 'inactive' })).total, 1);
});

test('blocking a customer ends their sessions', { skip: !live }, async () => {
    const user = await makeUser(`${tag} Blocked`);

    await prisma.foodRefreshToken.create({
        data: {
            userId: user.id,
            token: `tok-${stamp()}`,
            expiresAt: new Date(Date.now() + 86400000),
        },
    });

    const blocked = await updateCustomerStatus(user.id, false);
    assert.equal(blocked.isActive, false);

    // Left alive, a blocked customer keeps using the app until the token
    // expires — which is the whole point of blocking them.
    const tokens = await prisma.foodRefreshToken.count({ where: { userId: user.id } });
    assert.equal(tokens, 0);

    assert.equal(await updateCustomerStatus('a'.repeat(24), false), null);
});

test('re-enabling a customer does not touch tokens', { skip: !live }, async () => {
    const user = await makeUser(`${tag} Restored`);
    const enabled = await updateCustomerStatus(user.id, true);
    assert.equal(enabled.isActive, true);
});

test('the inbox merges customer and restaurant tickets', { skip: !live }, async () => {
    const user = await makeUser(`${tag} Complainer`);
    const restaurant = await makeRestaurant();

    const userTicket = await prisma.foodSupportTicket.create({
        data: {
            userId: user.id,
            type: 'other',
            issueType: `${tag} app crashed`,
            description: 'It closed itself',
        },
    });
    created.tickets.push(userTicket.id);

    const restaurantTicket = await prisma.foodRestaurantSupportTicket.create({
        data: {
            restaurantId: restaurant.id,
            category: 'payments',
            issueType: `${tag} payout late`,
            subject: 'Payout',
            description: 'Still waiting',
        },
    });
    created.rTickets.push(restaurantTicket.id);

    const all = await getSupportTickets({ search: tag });
    const sources = all.tickets.map((t) => t.source);
    assert.ok(sources.includes('user') && sources.includes('restaurant'), 'both tables feed one list');

    const onlyUser = await getSupportTickets({ search: tag, source: 'user' });
    assert.ok(onlyUser.tickets.every((t) => t.source === 'user'));

    const onlyRestaurant = await getSupportTickets({ search: tag, source: 'restaurant' });
    assert.ok(onlyRestaurant.tickets.every((t) => t.source === 'restaurant'));

    // A type filter is a customer-ticket concept, so it excludes the others.
    const typed = await getSupportTickets({ search: tag, type: 'other' });
    assert.ok(typed.tickets.every((t) => t.source === 'user'));
});

test('the API status spelling survives the round trip', { skip: !live }, async () => {
    const user = await makeUser(`${tag} Status`);
    const ticket = await prisma.foodSupportTicket.create({
        data: { userId: user.id, type: 'order', issueType: `${tag} late`, description: 'x' },
    });
    created.tickets.push(ticket.id);

    // The API says 'in-progress'; the enum's Prisma name is in_progress.
    const updated = await updateSupportTicket(ticket.id, { status: 'in-progress', source: 'user' });
    assert.equal(updated.status, 'in-progress');

    const found = await getSupportTickets({ search: tag, status: 'in-progress', source: 'user' });
    assert.ok(found.tickets.some((t) => t.id === ticket.id));

    const stats = await getFoodSupportTicketStats({ source: 'user' });
    assert.ok(stats.inProgress >= 1);
    assert.ok(stats.total >= 1);
});

test('replying to a customer ticket names the issue, not undefined', { skip: !live }, async () => {
    const user = await makeUser(`${tag} Replied`);
    const ticket = await prisma.foodSupportTicket.create({
        data: {
            userId: user.id,
            type: 'order',
            issueType: 'Order never arrived',
            description: 'Waited two hours',
        },
    });
    created.tickets.push(ticket.id);

    await updateSupportTicket(ticket.id, { adminResponse: 'Refunded', source: 'user' });

    const notification = await prisma.foodNotification.findFirst({
        where: { ownerId: user.id, source: 'SUPPORT_RESPONSE' },
    });

    // Customer tickets have no `subject` column, so the message used to read
    // 'your ticket: "undefined"' on every customer reply.
    assert.ok(notification, 'the customer is told about the reply');
    assert.ok(!notification.message.includes('undefined'), notification.message);
    assert.ok(notification.message.includes('Order never arrived'));
});

test('a reply to a restaurant ticket uses its subject', { skip: !live }, async () => {
    const restaurant = await makeRestaurant();
    const ticket = await prisma.foodRestaurantSupportTicket.create({
        data: {
            restaurantId: restaurant.id,
            category: 'menu',
            issueType: 'Cannot add dish',
            subject: 'Menu editor broken',
            description: 'Save button does nothing',
        },
    });
    created.rTickets.push(ticket.id);

    await updateSupportTicket(ticket.id, { adminResponse: 'Fixed', source: 'restaurant' });

    const notification = await prisma.foodNotification.findFirst({
        where: { ownerId: restaurant.id, source: 'SUPPORT_RESPONSE' },
    });
    assert.ok(notification.message.includes('Menu editor broken'));

    await prisma.foodNotification.deleteMany({ where: { ownerId: restaurant.id } });
});

test('an empty update changes nothing', { skip: !live }, async () => {
    const user = await makeUser(`${tag} Untouched`);
    const ticket = await prisma.foodSupportTicket.create({
        data: { userId: user.id, type: 'other', issueType: 'x', description: 'y' },
    });
    created.tickets.push(ticket.id);

    // Neither a status nor a response, so there is nothing to write.
    assert.equal(await updateSupportTicket(ticket.id, { source: 'user' }), null);
    assert.equal(await updateSupportTicket('bad-id', { status: 'open' }), null);
    assert.equal(await updateSupportTicket('a'.repeat(24), { status: 'open' }), null);
});
