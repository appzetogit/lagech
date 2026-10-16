import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../../config/prisma.js';
import { uniquePhone, uniqueTag } from '../../../../utils/testIds.js';
import {
    confirmPickupDelivery,
    confirmReachedDropDelivery,
    verifyDropOtpDelivery,
    completeDelivery,
} from './order-delivery.service.js';
import { getDropOtpUser } from './order.service.js';
import { saveSystemSettings, getPublicBusinessSettings } from '../../admin/services/adminSystemExtras.service.js';
import { invalidateBusinessSettings } from '../../shared/businessSettings.js';

/**
 * Business Settings > Order > Delivery OTP: whether the customer must give the
 * rider a code before the order can be marked delivered. On unless switched
 * off; each order keeps the rule it was picked up under.
 */

const created = { orders: [], users: [], restaurants: [], partners: [] };
let tag;
let restaurantId;
let userId;
let riderId;

const setOtp = async (on) => {
    await saveSystemSettings('business_order', { value: { deliveryOtp: on } });
    invalidateBusinessSettings();
};

test.before(async () => {
    tag = uniqueTag('DOtp');
    await prisma.foodSystemSetting.deleteMany({ where: { key: 'business_order' } });
    invalidateBusinessSettings();
    const restaurant = await prisma.foodRestaurant.create({
        data: { restaurantName: `${tag} Kitchen`, ownerName: 'Owner', ownerPhone: uniquePhone('9'), status: 'approved' },
    });
    created.restaurants.push(restaurant.id);
    restaurantId = restaurant.id;
    const user = await prisma.foodUser.create({ data: { phone: uniquePhone('5'), name: `${tag} Diner` } });
    created.users.push(user.id);
    userId = user.id;
    const rider = await prisma.foodDeliveryPartner.create({
        data: { name: `${tag} Rider`, phone: uniquePhone('6'), status: 'approved' },
    });
    created.partners.push(rider.id);
    riderId = rider.id;
});

test.after(async () => {
    // completeDelivery fires a few best-effort hooks; let them settle first.
    await new Promise((r) => setTimeout(r, 500));
    await prisma.foodSystemSetting.deleteMany({ where: { key: 'business_order' } });
    invalidateBusinessSettings();
    await prisma.foodTransactionHistory.deleteMany({ where: { transaction: { orderId: { in: created.orders } } } }).catch(() => {});
    await prisma.foodTransaction.deleteMany({ where: { orderId: { in: created.orders } } }).catch(() => {});
    await prisma.orderStatusHistory.deleteMany({ where: { orderId: { in: created.orders } } }).catch(() => {});
    await prisma.foodOrder.deleteMany({ where: { id: { in: created.orders } } }).catch(() => {});
    await prisma.foodDeliveryPartner.deleteMany({ where: { id: { in: created.partners } } }).catch(() => {});
    await prisma.foodUser.deleteMany({ where: { id: { in: created.users } } }).catch(() => {});
    await prisma.foodRestaurant.deleteMany({ where: { id: { in: created.restaurants } } }).catch(() => {});
    await prisma.$disconnect();
});

/** A paid order the rider has accepted and is about to pick up. */
async function acceptedOrder() {
    const code = `${tag}-${uniqueTag('O')}`;
    const order = await prisma.foodOrder.create({
        data: {
            userId,
            restaurantId,
            dispatchDeliveryPartnerId: riderId,
            dispatchStatus: 'accepted',
            order_id: code,
            orderId: code,
            orderStatus: 'ready_for_pickup',
            paymentMethod: 'razorpay',
            paymentStatus: 'paid',
            addrStreet: '1 Test Street', addrCity: 'Indore', addrState: 'MP',
            subtotal: 300,
            total: 300,
            riderEarning: 40,
        },
    });
    created.orders.push(order.id);
    return order.id;
}

const row = (id) => prisma.foodOrder.findUnique({
    where: { id },
    select: { deliveryOtp: true, dropOtpRequired: true, dropOtpVerified: true, orderStatus: true },
});

test('on by default: a code is made at pickup and is needed to complete', async () => {
    const id = await acceptedOrder();
    await confirmPickupDelivery(id, riderId);
    const picked = await row(id);
    assert.equal(picked.dropOtpRequired, true);
    assert.match(picked.deliveryOtp, /^\d{4}$/);

    const shown = await getDropOtpUser(id, userId);
    assert.deepEqual(shown, { otp: picked.deliveryOtp, required: true });

    await confirmReachedDropDelivery(id, riderId);
    await assert.rejects(() => completeDelivery(id, riderId, {}), /OTP is required/);
    await assert.rejects(() => verifyDropOtpDelivery(id, riderId, '0000' === picked.deliveryOtp ? '1111' : '0000'), /Invalid OTP/);

    await verifyDropOtpDelivery(id, riderId, picked.deliveryOtp);
    await completeDelivery(id, riderId, {});
    assert.equal((await row(id)).orderStatus, 'delivered');
});

test('the public settings tell the apps the switch is on by default', async () => {
    const settings = await getPublicBusinessSettings();
    assert.equal(settings.order.deliveryOtp, true);
});

test('switched off: no code is made and the rider completes without one', async () => {
    await setOtp(false);
    const id = await acceptedOrder();
    await confirmPickupDelivery(id, riderId);
    const picked = await row(id);
    assert.equal(picked.dropOtpRequired, false);
    assert.equal(picked.deliveryOtp, '');
    assert.deepEqual(await getDropOtpUser(id, userId), { otp: null, required: false });

    const atDrop = await confirmReachedDropDelivery(id, riderId);
    assert.equal(atDrop.deliveryVerification?.dropOtp?.required, false);
    assert.equal((await row(id)).dropOtpRequired, false);

    // An older rider app that always asks for a code is let through.
    const verified = await verifyDropOtpDelivery(id, riderId, '1234');
    assert.ok(verified.order);

    await completeDelivery(id, riderId, {});
    assert.equal((await row(id)).orderStatus, 'delivered');
    assert.equal((await getPublicBusinessSettings()).order.deliveryOtp, false);
});

test('an order keeps the rule it was picked up under when the switch changes', async () => {
    // Picked up while on, switched off before the drop: the code is still needed.
    await setOtp(true);
    const onOrder = await acceptedOrder();
    await confirmPickupDelivery(onOrder, riderId);
    await setOtp(false);
    await confirmReachedDropDelivery(onOrder, riderId);
    const onRow = await row(onOrder);
    assert.equal(onRow.dropOtpRequired, true);
    await assert.rejects(() => completeDelivery(onOrder, riderId, {}), /OTP is required/);
    await completeDelivery(onOrder, riderId, { otp: onRow.deliveryOtp });
    assert.equal((await row(onOrder)).orderStatus, 'delivered');

    // Picked up while off, switched on before the drop: no code appears.
    const offOrder = await acceptedOrder();
    await confirmPickupDelivery(offOrder, riderId);
    await setOtp(true);
    await confirmReachedDropDelivery(offOrder, riderId);
    const offRow = await row(offOrder);
    assert.equal(offRow.dropOtpRequired, false);
    assert.equal(offRow.deliveryOtp, '');
    await completeDelivery(offOrder, riderId, {});
    assert.equal((await row(offOrder)).orderStatus, 'delivered');
});
