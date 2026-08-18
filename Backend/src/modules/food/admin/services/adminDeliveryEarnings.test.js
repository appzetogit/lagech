import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../../config/prisma.js';
import { uniquePhone, uniqueTag } from '../../../../utils/testIds.js';
import { getDeliveryEarnings } from './adminDeliveryEarnings.service.js';

/**
 * What every rider earned, order by order.
 *
 * The fallback is the part that carries risk: an order written before
 * `riderEarning` was recorded is paid at the delivery fee, and the page total
 * has to apply that per order rather than to the columns as a whole.
 */
const created = { restaurants: [], users: [], partners: [], orders: [] };
let restaurantId = null;
let userId = null;
let riderId = null;
let otherRiderId = null;
let tag = null;

const makeOrder = async (over = {}) => {
    const order = await prisma.foodOrder.create({
        data: {
            userId,
            restaurantId,
            dispatchDeliveryPartnerId: riderId,
            orderId: `${tag}-${uniqueTag('O')}`,
            orderStatus: 'delivered',
            paymentMethod: 'cash',
            addrStreet: '1 Test Street',
            addrCity: 'Indore',
            addrState: 'MP',
            subtotal: 500,
            deliveryFee: 40,
            total: 540,
            riderEarning: 35,
            ...over,
        },
    });
    created.orders.push(order.id);
    return order;
};

test.before(async () => {
    tag = uniqueTag('Earn');

    const r = await prisma.foodRestaurant.create({
        data: {
            restaurantName: `${tag} Kitchen`,
            ownerName: 'Owner',
            ownerPhone: uniquePhone('9'),
            status: 'approved',
        },
    });
    created.restaurants.push(r.id);
    restaurantId = r.id;

    const makeRider = async (name) => {
        const p = await prisma.foodDeliveryPartner.create({
            data: { name, phone: uniquePhone('6'), status: 'approved' },
        });
        created.partners.push(p.id);
        return p.id;
    };
    riderId = await makeRider(`${tag} Rider One`);
    otherRiderId = await makeRider(`${tag} Rider Two`);

    const u = await prisma.foodUser.create({ data: { phone: uniquePhone('5') } });
    created.users.push(u.id);
    userId = u.id;
});

test.after(async () => {
    await prisma.foodOrder.deleteMany({ where: { id: { in: created.orders } } });
    await prisma.foodUser.deleteMany({ where: { id: { in: created.users } } });
    await prisma.foodDeliveryPartner.deleteMany({ where: { id: { in: created.partners } } });
    await prisma.foodRestaurant.deleteMany({ where: { id: { in: created.restaurants } } });
    await prisma.$disconnect();
});

test('a row names the rider, the restaurant and the amount', async () => {
    const order = await makeOrder();

    const { earnings, summary } = await getDeliveryEarnings({ search: order.orderId });
    assert.equal(earnings.length, 1);

    const row = earnings[0];
    assert.equal(row.orderId, order.orderId);
    assert.equal(row.deliveryPartnerId, riderId);
    assert.equal(row.deliveryPartnerName, `${tag} Rider One`);
    assert.equal(row.restaurantName, `${tag} Kitchen`);
    assert.equal(row.amount, 35, 'what the split credited, not the fee');
    assert.equal(row.deliveryFee, 40);
    assert.equal(row.orderTotal, 540);

    assert.equal(summary.totalOrders, 1);
    assert.equal(summary.totalEarnings, 35);
    assert.equal(summary.totalDeliveryPartners, 1);
});

test('an order with no recorded earning is paid at the delivery fee', async () => {
    const legacy = await makeOrder({ riderEarning: 0 });

    const single = await getDeliveryEarnings({ search: legacy.orderId });
    assert.equal(single.earnings[0].amount, 40);
    assert.equal(single.summary.totalEarnings, 40);

    // The total has to apply the fallback per order: a page mixing the two
    // would otherwise either double-count or drop one of them.
    const both = await getDeliveryEarnings({ deliveryPartnerId: riderId });
    assert.equal(both.summary.totalOrders, 2);
    assert.equal(both.summary.totalEarnings, 75, '35 recorded plus 40 fallen back');
});

test('only dispatched orders appear', async () => {
    const undispatched = await makeOrder({ dispatchDeliveryPartnerId: null });

    const { earnings } = await getDeliveryEarnings({ search: tag, limit: 100 });
    assert.ok(!earnings.some((e) => e.orderId === undispatched.orderId), 'no rider, nothing owed');
});

test('the rider count is distinct', async () => {
    await makeOrder({ dispatchDeliveryPartnerId: otherRiderId });
    await makeOrder({ dispatchDeliveryPartnerId: otherRiderId });

    const { summary } = await getDeliveryEarnings({ search: tag, limit: 100 });
    assert.equal(summary.totalDeliveryPartners, 2, 'two riders, four orders');
    assert.equal(summary.totalOrders, 4);
});

test('search reaches the rider and the restaurant', async () => {
    const byRider = await getDeliveryEarnings({ search: 'Rider Two', limit: 100 });
    assert.ok(byRider.earnings.length >= 2);
    assert.ok(byRider.earnings.every((e) => e.deliveryPartnerId === otherRiderId));

    const byRestaurant = await getDeliveryEarnings({ search: `${tag} Kitchen`, limit: 100 });
    assert.equal(byRestaurant.summary.totalOrders, 4);

    const nothing = await getDeliveryEarnings({ search: `no-such-thing-${tag}` });
    assert.equal(nothing.summary.totalOrders, 0);
    assert.equal(nothing.summary.totalEarnings, 0);
});

test('a date range narrows it, and paging is reported', async () => {
    const old = await makeOrder({ createdAt: new Date('2033-08-15T20:00:00') });

    const sameDay = await getDeliveryEarnings({
        search: tag,
        fromDate: '2033-08-15',
        toDate: '2033-08-15',
        limit: 100,
    });
    // A `toDate` at midnight would drop every evening delivery.
    assert.equal(sameDay.summary.totalOrders, 1);
    assert.equal(sameDay.earnings[0].orderId, old.orderId);

    const today = await getDeliveryEarnings({ search: tag, period: 'today', limit: 100 });
    assert.equal(today.summary.totalOrders, 4, 'the backdated one is outside today');

    const paged = await getDeliveryEarnings({ search: tag, limit: 2 });
    assert.equal(paged.earnings.length, 2);
    assert.equal(paged.pagination.total, 5);
    assert.equal(paged.pagination.pages, 3);
    // The summary is over the whole filter, not just the page.
    assert.equal(paged.summary.totalOrders, 5);
});
