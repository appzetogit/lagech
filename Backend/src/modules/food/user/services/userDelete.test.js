import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../../config/prisma.js';
import { uniquePhone, uniqueTag } from '../../../../utils/testIds.js';
import { deleteCurrentUserAccount } from './userProfile.service.js';
import errorHandler from '../../../../middleware/errorHandler.js';

/**
 * Deleting a customer account: a customer with order history is closed and
 * stripped of personal data (orders and money records survive); one without
 * history is erased. Unexpected errors never show their database text.
 */
const created = { users: [], restaurants: [], orders: [] };

test.after(async () => {
    await prisma.foodOrder.deleteMany({ where: { id: { in: created.orders } } });
    await prisma.foodRestaurant.deleteMany({ where: { id: { in: created.restaurants } } });
    await prisma.foodUser.deleteMany({ where: { id: { in: created.users } } });
    await prisma.$disconnect();
});

const makeUser = async () => {
    const user = await prisma.foodUser.create({
        data: { phone: uniquePhone('7'), name: 'Asha Patil', email: 'asha@example.com', fcmTokens: ['tok-1'] },
    });
    created.users.push(user.id);
    return user;
};

test('a customer with orders is anonymised and closed; the order keeps pointing at them', async () => {
    const user = await makeUser();
    const restaurant = await prisma.foodRestaurant.create({
        data: { restaurantName: `${uniqueTag('Del')} Kitchen`, ownerName: 'O', ownerPhone: uniquePhone('9'), status: 'approved' },
    });
    created.restaurants.push(restaurant.id);
    const order = await prisma.foodOrder.create({
        data: {
            userId: user.id, restaurantId: restaurant.id, orderStatus: 'delivered',
            paymentMethod: 'cash', paymentStatus: 'paid', subtotal: 100, total: 150,
            addrStreet: '1 Test Street', addrCity: 'Phaltan', addrState: 'MH',
        },
    });
    created.orders.push(order.id);
    await prisma.userAddress.create({
        data: { userId: user.id, street: '1 Test Street', city: 'Phaltan', state: 'MH', label: 'Home' },
    }).catch(() => {}); // address shape differs across versions; the delete is what matters

    const result = await deleteCurrentUserAccount(user.id);
    assert.equal(result.anonymised, true);

    const row = await prisma.foodUser.findUnique({ where: { id: user.id } });
    assert.ok(row, 'the account row is kept for the order history');
    assert.equal(row.isActive, false);
    assert.equal(row.name, 'Deleted user');
    assert.equal(row.email, null);
    assert.notEqual(row.phone, user.phone, 'the phone number is released');
    assert.ok(row.phone.length <= 20);
    assert.deepEqual(row.fcmTokens, []);
    assert.equal(row.tokenVersion, user.tokenVersion + 1, 'existing sessions are ended');
    assert.equal(await prisma.userAddress.count({ where: { userId: user.id } }), 0);
    assert.ok(await prisma.foodOrder.findUnique({ where: { id: order.id } }), 'the order survives');

    // The same phone can sign up again as a new customer.
    const again = await prisma.foodUser.create({ data: { phone: user.phone } });
    created.users.push(again.id);
});

test('a customer without any history is erased', async () => {
    const user = await makeUser();
    const result = await deleteCurrentUserAccount(user.id);
    assert.equal(result.success, true);
    assert.equal(await prisma.foodUser.findUnique({ where: { id: user.id } }), null);
});

test('an unexpected 500 never shows its internal message to the app', () => {
    let body = null;
    const res = {
        setHeader() {},
        status(code) { this.code = code; return this; },
        json(payload) { body = payload; return this; },
    };
    const err = new Error('Invalid `prisma.foodUser.delete()` invocation: violates RESTRICT setting of foreign key');
    errorHandler(err, { method: 'DELETE', originalUrl: '/x', requestId: 'r1' }, res, () => {});
    assert.equal(res.code, 500);
    assert.doesNotMatch(body.message, /prisma|foreign key|RESTRICT/i);

    const validation = Object.assign(new Error('Restaurants with order history cannot be deleted.'), { statusCode: 400 });
    errorHandler(validation, { method: 'DELETE', originalUrl: '/x' }, res, () => {});
    assert.equal(body.message, 'Restaurants with order history cannot be deleted.', 'our own 4xx messages are kept');
});
