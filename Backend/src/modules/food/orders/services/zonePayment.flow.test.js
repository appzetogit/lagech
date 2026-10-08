import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../../config/prisma.js';
import { uniquePhone, uniqueTag } from '../../../../utils/testIds.js';
import { testPatch } from '../../../../utils/testGeo.js';
import { createOrder, calculateOrder } from './order.service.js';
import { createZone, updateZone, deleteZone, getZones } from '../../admin/services/adminZone.service.js';
import {
    getDefaultZone,
    getZonePaymentOptions,
    zonePaymentError,
} from '../../shared/zonePayment.js';

/**
 * Per-zone Cash On Delivery / Digital Payment switches and the default zone,
 * through the real entry points: the admin zone service and createOrder.
 */
const HERE = testPatch(41);
const ELSEWHERE = testPatch(42);

const created = { zones: [], restaurants: [], users: [], foods: [], categories: [] };
let zoneId = null;
let zonedRestaurantId = null;
let zonedFoodId = null;
let looseRestaurantId = null;
let looseFoodId = null;
let userId = null;

const address = () => ({
    label: 'Home',
    fullName: 'Zone Customer',
    street: '1 Test Street',
    city: 'Indore',
    state: 'MP',
    zipCode: '452001',
    phone: uniquePhone('5'),
    latitude: HERE.lat,
    longitude: HERE.lng,
});

const cart = (restaurantId, foodId, paymentMethod) => ({
    restaurantId,
    items: [{ itemId: foodId, quantity: 1 }],
    address: address(),
    paymentMethod,
});

const makeRestaurant = async (tag, zone) => {
    const restaurant = await prisma.foodRestaurant.create({
        data: {
            restaurantName: `${tag} Kitchen`,
            ownerName: 'Owner',
            ownerPhone: uniquePhone('9'),
            status: 'approved',
            zoneId: zone,
            latitude: HERE.lat,
            longitude: HERE.lng,
            isAcceptingOrders: true,
            outsideHoursOverride: true,
        },
    });
    created.restaurants.push(restaurant.id);
    const category = await prisma.foodCategory.create({
        data: { name: `${tag} Mains`, restaurantId: restaurant.id, approvalStatus: 'approved' },
    });
    created.categories.push(category.id);
    const food = await prisma.foodItem.create({
        data: {
            restaurantId: restaurant.id,
            categoryId: category.id,
            categoryName: category.name,
            name: `${tag} Thali`,
            price: 300,
            approvalStatus: 'approved',
            isAvailable: true,
        },
    });
    created.foods.push(food.id);
    return { restaurantId: restaurant.id, foodId: food.id };
};

test.before(async () => {
    const tag = uniqueTag('ZonePay');
    const { zone } = await createZone({ name: `${tag} Zone`, coordinates: HERE.ring });
    created.zones.push(zone.id);
    zoneId = zone.id;

    ({ restaurantId: zonedRestaurantId, foodId: zonedFoodId } = await makeRestaurant(`${tag} Z`, zoneId));
    ({ restaurantId: looseRestaurantId, foodId: looseFoodId } = await makeRestaurant(`${tag} L`, null));

    const user = await prisma.foodUser.create({ data: { name: `${tag} Customer`, phone: uniquePhone('5') } });
    created.users.push(user.id);
    userId = user.id;
});

test.after(async () => {
    const orders = await prisma.foodOrder.findMany({
        where: { restaurantId: { in: created.restaurants } },
        select: { id: true },
    });
    const ids = orders.map((o) => o.id);
    await prisma.foodTransaction.deleteMany({ where: { orderId: { in: ids } } });
    await prisma.orderItem.deleteMany({ where: { orderId: { in: ids } } });
    await prisma.orderStatusHistory.deleteMany({ where: { orderId: { in: ids } } });
    await prisma.foodOrder.deleteMany({ where: { id: { in: ids } } });
    await prisma.foodNotification.deleteMany({ where: { ownerId: { in: [...created.users, ...created.restaurants] } } });
    await prisma.foodItem.deleteMany({ where: { id: { in: created.foods } } });
    await prisma.foodCategory.deleteMany({ where: { id: { in: created.categories } } });
    await prisma.foodUser.deleteMany({ where: { id: { in: created.users } } });
    await prisma.foodRestaurant.deleteMany({ where: { id: { in: created.restaurants } } });
    await prisma.foodZone.updateMany({ where: { id: { in: created.zones } }, data: { isDefault: false } });
    await prisma.foodZone.deleteMany({ where: { id: { in: created.zones } } });
    await prisma.$disconnect();
});

test('a new zone accepts cash and online payment, and is not the default', async () => {
    const zone = await prisma.foodZone.findUnique({ where: { id: zoneId } });
    assert.equal(zone.cashOnDelivery, true);
    assert.equal(zone.digitalPayment, true);
    assert.equal(zone.isDefault, false);
    assert.deepEqual(await getZonePaymentOptions(zoneId), { zoneId, cashOnDelivery: true, digitalPayment: true });
});

test('the refusal message names the method and the zone', () => {
    assert.match(zonePaymentError({ cashOnDelivery: false }, 'cash', 'Phaltan'), /Cash on Delivery is not available in Phaltan/);
    assert.match(zonePaymentError({ digitalPayment: false }, 'razorpay_qr'), /Online payment is not available/);
    assert.equal(zonePaymentError({ digitalPayment: false, cashOnDelivery: false }, 'wallet'), null, 'wallet is not zone-governed');
    assert.equal(zonePaymentError({ cashOnDelivery: true }, 'cash'), null);
});

test('with Cash On Delivery off, a cash order in the zone is refused before anything is written', async () => {
    await updateZone(zoneId, { cashOnDelivery: false });
    try {
        await assert.rejects(
            createOrder(userId, cart(zonedRestaurantId, zonedFoodId, 'cash')),
            (err) => err.statusCode === 400 && /Cash on Delivery is not available/.test(err.message),
        );
        assert.equal(await prisma.foodOrder.count({ where: { restaurantId: zonedRestaurantId } }), 0);
    } finally {
        await updateZone(zoneId, { cashOnDelivery: true });
    }
});

test('with Digital Payment off, online and QR orders are refused but cash still goes through', async () => {
    await updateZone(zoneId, { digitalPayment: 'false' });
    try {
        for (const method of ['razorpay', 'card', 'razorpay_qr']) {
            await assert.rejects(
                createOrder(userId, cart(zonedRestaurantId, zonedFoodId, method)),
                /Online payment is not available/,
                method,
            );
        }
        const { order } = await createOrder(userId, cart(zonedRestaurantId, zonedFoodId, 'cash'));
        const row = await prisma.foodOrder.findUnique({ where: { id: order._id || order.id } });
        assert.equal(row.zoneId, zoneId);
        assert.equal(row.paymentMethod, 'cash');
    } finally {
        await updateZone(zoneId, { digitalPayment: true });
    }
});

test('checkout pricing reports what the zone accepts', async () => {
    await updateZone(zoneId, { cashOnDelivery: false });
    try {
        const quote = await calculateOrder(userId, {
            restaurantId: zonedRestaurantId,
            items: [{ itemId: zonedFoodId, quantity: 1 }],
            deliveryAddress: address(),
        });
        assert.deepEqual(quote.paymentOptions, { zoneId, cashOnDelivery: false, digitalPayment: true });
    } finally {
        await updateZone(zoneId, { cashOnDelivery: true });
    }
});

test('making a zone default moves the flag; there is only ever one', async () => {
    const tag = uniqueTag('ZoneDef');
    const { zone: other } = await createZone({ name: `${tag} Other`, coordinates: ELSEWHERE.ring, isDefault: true });
    created.zones.push(other.id);
    assert.equal(other.isDefault, true);
    assert.equal((await getDefaultZone()).id, other.id);

    await updateZone(zoneId, { isDefault: true });
    const defaults = await prisma.foodZone.findMany({ where: { isDefault: true }, select: { id: true } });
    assert.deepEqual(defaults.map((z) => z.id), [zoneId]);

    // The list carries the flag and the counts the old Zone setup table showed.
    const { zones } = await getZones({ search: tag });
    assert.equal(zones.length, 1);
    assert.equal(zones[0].isDefault, false);
    assert.equal(zones[0].restaurantCount, 0);
    assert.equal(zones[0].deliveryPartnerCount, 0);
    const { zones: mine } = await getZones({ search: (await prisma.foodZone.findUnique({ where: { id: zoneId } })).name });
    assert.equal(mine[0].restaurantCount, 1);

    await assert.rejects(updateZone(zoneId, { isActive: false }), /default zone cannot be deactivated/);
    await assert.rejects(updateZone(zoneId, { isDefault: false }), /Make another zone the default/);
    await assert.rejects(deleteZone(zoneId), /default zone cannot be deleted/);
    await updateZone(other.id, { isActive: false });
    await assert.rejects(updateZone(other.id, { isDefault: true }), /Only an active zone/);
});

test('an order at a restaurant with no zone falls into the default zone and obeys its switches', async () => {
    await updateZone(zoneId, { isDefault: true, cashOnDelivery: false });
    try {
        await assert.rejects(
            createOrder(userId, cart(looseRestaurantId, looseFoodId, 'cash')),
            /Cash on Delivery is not available/,
        );
        await updateZone(zoneId, { cashOnDelivery: true });
        const { order } = await createOrder(userId, cart(looseRestaurantId, looseFoodId, 'cash'));
        const row = await prisma.foodOrder.findUnique({ where: { id: order._id || order.id } });
        assert.equal(row.zoneId, zoneId, 'stamped with the default zone');
    } finally {
        await updateZone(zoneId, { cashOnDelivery: true });
    }
});
