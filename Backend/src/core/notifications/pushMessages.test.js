import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../config/prisma.js';
import { uniquePhone, uniqueTag } from '../../utils/testIds.js';
import {
    AREA,
    PUSH_MESSAGES,
    normalizePushMessages,
    messageForPush,
    renderPushText,
    applyPushMessageSettings,
    applyPushMessage,
    invalidatePushMessages,
} from './pushMessages.js';
import { NOTIFICATION_EVENTS } from './notificationChannels.js';
import { sendNotificationToOwner } from './firebase.service.js';

/**
 * The admin's wording for order pushes. The matching and rendering rules are
 * pure; the last tests read a real order for the placeholders and go through
 * sendNotificationToOwner, which every push in the system uses.
 */

const key = (data, owner) => messageForPush(data, owner)?.key || null;

test('a push is matched by type, status and who receives it', () => {
    assert.equal(key({ type: 'order_created' }, 'USER'), 'customer_order_placed');
    assert.equal(key({ type: 'order_status_update', orderStatus: 'confirmed' }, 'USER'), 'customer_order_confirmed');
    assert.equal(key({ type: 'order_status_update', orderStatus: 'preparing' }, 'USER'), 'customer_order_processing');
    assert.equal(key({ type: 'order_status_update', orderStatus: 'picked_up' }, 'USER'), 'customer_out_for_delivery');
    assert.equal(key({ type: 'order_status_update', orderStatus: 'delivered' }, 'USER'), 'customer_order_delivered');
    assert.equal(key({ type: 'order_status_update', orderStatus: 'cancelled_by_restaurant' }, 'USER'), 'customer_order_cancelled');
    assert.equal(key({ type: 'order_cancelled' }, 'USER'), 'customer_order_cancelled');
    assert.equal(key({ type: 'refund_processed' }, 'USER'), 'customer_order_refunded');
    assert.equal(key({ type: 'payment_failed' }, 'USER'), 'customer_payment_failed');
    // The same type means different things to different receivers.
    assert.equal(key({ type: 'new_order' }, 'RESTAURANT'), 'restaurant_new_order');
    assert.equal(key({ type: 'new_order' }, 'DELIVERY_PARTNER'), 'rider_new_order');
    assert.equal(key({ type: 'delivery_accepted' }, 'RESTAURANT'), 'restaurant_rider_assigned');
    assert.equal(key({ type: 'order_completed' }, 'DELIVERY_PARTNER'), 'rider_order_delivered');
    // Not ours: unknown types, statuses without a message, admins.
    assert.equal(key({ type: 'order_status_update', orderStatus: 'confirmed' }, 'DELIVERY_PARTNER'), null);
    assert.equal(key({ type: 'chat_message' }, 'USER'), null);
    assert.equal(key({ type: 'new_order' }, 'ADMIN'), null);
    assert.equal(key({}, 'USER'), null);
});

test('every message switched on Notification Channels names a real event there', () => {
    const events = new Set(NOTIFICATION_EVENTS.map((event) => event.key));
    for (const message of PUSH_MESSAGES) {
        if (message.channel) assert.ok(events.has(message.channel), message.key);
    }
});

test('placeholders are filled, unknown ones dropped', () => {
    assert.equal(renderPushText('Order #{orderId} from {restaurantName}', { orderId: 'FOD-1', restaurantName: 'Spice' }), 'Order #FOD-1 from Spice');
    assert.equal(renderPushText('Hi {customerName}, {nope} done', { customerName: 'Asha' }), 'Hi Asha, done');
    assert.equal(renderPushText('', {}), '');
});

test('the admin text replaces the code text; blanks keep it; a switched-off message is skipped', () => {
    const payload = { title: 'Order Confirmed!', body: 'code text', data: { type: 'order_created', title: 'Order Confirmed!', body: 'code text' } };
    const message = messageForPush(payload.data, 'USER');

    const blank = normalizePushMessages({});
    assert.equal(applyPushMessageSettings(payload, message, blank, {}).payload, payload);

    const custom = normalizePushMessages({ messages: { customer_order_placed: { body: 'Order {orderId} placed' } } });
    const out = applyPushMessageSettings(payload, message, custom, { orderId: 'FOD-9' });
    assert.equal(out.payload.title, 'Order Confirmed!');
    assert.equal(out.payload.body, 'Order FOD-9 placed');
    // Data-only legs render from data, so it changes too -- on a copy.
    assert.equal(out.payload.data.body, 'Order FOD-9 placed');
    assert.equal(payload.data.body, 'code text');

    const off = normalizePushMessages({ messages: { customer_order_placed: { enabled: false } } });
    assert.equal(applyPushMessageSettings(payload, message, off, {}).skip, true);

    // A message switched on Notification Channels is never skipped here.
    const status = { data: { type: 'order_status_update', orderStatus: 'confirmed' } };
    const statusOff = normalizePushMessages({ messages: { customer_order_confirmed: { enabled: false } } });
    assert.equal(applyPushMessageSettings(status, messageForPush(status.data, 'USER'), statusOff, {}).skip, undefined);
});

// ─── Against the database ────────────────────────────────────────────────────

const created = { users: [], restaurants: [], orders: [] };
let previous = null;
let order = null;

test.before(async () => {
    previous = await prisma.foodSystemSetting.findUnique({ where: { key: AREA } });
    const tag = uniqueTag('Push');
    const [user, restaurant] = await Promise.all([
        prisma.foodUser.create({ data: { name: `${tag} Asha`, phone: uniquePhone('7') } }),
        prisma.foodRestaurant.create({
            data: { restaurantName: `${tag} Kitchen`, ownerName: 'Owner', ownerPhone: uniquePhone('9'), status: 'approved' },
        }),
    ]);
    created.users.push(user.id);
    created.restaurants.push(restaurant.id);
    order = await prisma.foodOrder.create({
        data: {
            userId: user.id,
            restaurantId: restaurant.id,
            order_id: uniqueTag('FOD-'),
            orderStatus: 'created',
            paymentMethod: 'cash',
            customerName: 'Asha',
            addrStreet: '1 Test Street',
            addrCity: 'Indore',
            addrState: 'MP',
            subtotal: 200,
            total: 236,
        },
    });
    created.orders.push(order.id);
});

test.after(async () => {
    await prisma.foodNotification.deleteMany({ where: { ownerId: { in: created.users } } });
    await prisma.foodOrder.deleteMany({ where: { id: { in: created.orders } } });
    await prisma.foodRestaurant.deleteMany({ where: { id: { in: created.restaurants } } });
    await prisma.foodUser.deleteMany({ where: { id: { in: created.users } } });
    if (previous) {
        await prisma.foodSystemSetting.update({ where: { key: AREA }, data: { value: previous.value } });
    } else {
        await prisma.foodSystemSetting.deleteMany({ where: { key: AREA } });
    }
    invalidatePushMessages();
    await prisma.$disconnect();
});

const saveMessages = async (messages) => {
    const value = normalizePushMessages({ messages });
    await prisma.foodSystemSetting.upsert({ where: { key: AREA }, create: { key: AREA, value }, update: { value } });
    invalidatePushMessages();
};

test('placeholders come from the order the push is about', async () => {
    await saveMessages({
        customer_order_placed: { title: 'Thanks {customerName}', body: 'Order #{orderId} from {restaurantName}, total {orderAmount}' },
    });
    const restaurant = await prisma.foodRestaurant.findUnique({ where: { id: order.restaurantId } });
    const { payload, skip } = await applyPushMessage(
        { title: 'code', body: 'code', data: { type: 'order_created', orderId: order.id } },
        'USER',
    );
    assert.equal(skip, undefined);
    assert.equal(payload.title, 'Thanks Asha');
    assert.equal(payload.body, `Order #${order.order_id} from ${restaurant.restaurantName}, total 236`);

    // A push the admin did not reword goes out as written.
    const untouched = { title: 'code', body: 'code', data: { type: 'refund_processed', orderId: order.id } };
    assert.equal((await applyPushMessage(untouched, 'USER')).payload, untouched);
});

test('a message switched off is not pushed, nor kept in the inbox', async () => {
    await saveMessages({ customer_order_placed: { enabled: false } });
    const result = await sendNotificationToOwner({
        ownerType: 'USER',
        ownerId: order.userId,
        payload: { title: 'Order placed', body: 'x', data: { type: 'order_created', orderId: order.id } },
    });
    assert.equal(result.skipped, 'message_off');
    const inbox = await prisma.foodNotification.count({ where: { ownerId: order.userId } });
    assert.equal(inbox, 0);
});

test('the reworded text is what lands in the inbox', async () => {
    await saveMessages({ customer_order_placed: { title: 'Placed', body: 'Your order {orderId} is in' } });
    await sendNotificationToOwner({
        ownerType: 'USER',
        ownerId: order.userId,
        payload: { title: 'Order placed', body: 'x', data: { type: 'order_created', orderId: order.id } },
    });
    const row = await prisma.foodNotification.findFirst({ where: { ownerId: order.userId }, orderBy: { createdAt: 'desc' } });
    assert.ok(row, 'kept in the inbox');
    assert.equal(row.title, 'Placed');
    assert.equal(row.message, `Your order ${order.order_id} is in`);
});
