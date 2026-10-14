import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../config/prisma.js';
import { uniquePhone, uniqueTag } from '../../utils/testIds.js';
import {
    getRestaurantNotificationSettings,
    updateRestaurantNotificationSetting,
    isRestaurantNotificationOn,
    invalidateRestaurantNotificationSettings,
} from './restaurantNotificationSettings.js';
import { sendNotificationToOwner } from './firebase.service.js';
import { deliverEmail, setEmailTransportForTests } from './transactionalEmail.js';

/**
 * A restaurant's Notification Setup against the database: saving a switch,
 * and the push and mail gates reading it.
 */

const tag = uniqueTag('NotifSetup');
let restaurant = null;

test.before(async () => {
    restaurant = await prisma.foodRestaurant.create({
        data: { restaurantName: `${tag} Kitchen`, ownerName: 'Owner', ownerPhone: uniquePhone('9'), status: 'approved' },
    });
});

test.after(async () => {
    setEmailTransportForTests(null);
    await prisma.foodNotification.deleteMany({ where: { ownerId: restaurant.id } });
    await prisma.foodRestaurantNotificationSetting.deleteMany({ where: { restaurantId: restaurant.id } });
    await prisma.foodRestaurant.deleteMany({ where: { id: restaurant.id } });
    invalidateRestaurantNotificationSettings();
    await prisma.$disconnect();
});

test('no row: every offered channel is on', async () => {
    const { events } = await getRestaurantNotificationSettings(restaurant.id);
    assert.equal(events.length, 20);
    const order = events.find((e) => e.key === 'store_order_notification');
    assert.equal(order.push.status, 'active');
    assert.equal(order.mail.status, 'disable');
    assert.equal(await isRestaurantNotificationOn(restaurant.id, 'store_order_notification', 'push'), true);
});

test('switching one channel off keeps the others at their defaults', async () => {
    const { events } = await updateRestaurantNotificationSetting(restaurant.id, { key: 'store_withdraw_approve', channel: 'mail', enabled: false });
    const withdraw = events.find((e) => e.key === 'store_withdraw_approve');
    assert.equal(withdraw.mail.status, 'inactive');
    assert.equal(withdraw.push.status, 'active');
    const row = await prisma.foodRestaurantNotificationSetting.findUnique({
        where: { restaurantId_key: { restaurantId: restaurant.id, key: 'store_withdraw_approve' } },
    });
    assert.deepEqual([row.mailStatus, row.smsStatus, row.pushStatus], ['inactive', 'disable', 'active']);
    await assert.rejects(
        updateRestaurantNotificationSetting(restaurant.id, { key: 'store_order_notification', channel: 'mail', status: 'active' }),
        /cannot be switched/,
    );
});

test('a restaurant that switched order pushes off is not pushed, nor sent to the inbox', async () => {
    await updateRestaurantNotificationSetting(restaurant.id, { key: 'store_order_notification', channel: 'push', status: 'inactive' });
    const result = await sendNotificationToOwner({
        ownerType: 'RESTAURANT',
        ownerId: restaurant.id,
        payload: { title: 'New order received', body: 'x', data: { type: 'new_order', orderId: 'none' } },
    });
    assert.equal(result.skipped, 'restaurant_off');
    assert.equal(await prisma.foodNotification.count({ where: { ownerId: restaurant.id } }), 0);

    // A push outside Notification Setup still goes out (to the inbox here).
    const other = await sendNotificationToOwner({
        ownerType: 'RESTAURANT',
        ownerId: restaurant.id,
        payload: { title: 'Hello', body: 'x', data: { type: 'chat_message' } },
    });
    assert.notEqual(other.skipped, 'restaurant_off');
});

test('an email to a restaurant that switched that event’s mail off is not sent', async () => {
    setEmailTransportForTests({ sendMail: async () => ({ messageId: '1' }) });
    const outcome = await deliverEmail({
        template: 'withdraw_approved',
        eventKey: `${tag}:withdraw`,
        to: 'owner@example.com',
        values: { userName: 'Owner', amount: '10', transactionId: '-', reason: '-' },
        restaurant: { id: restaurant.id, event: 'store_withdraw_approve' },
    });
    assert.equal(outcome, 'skipped:restaurant_off');
});
