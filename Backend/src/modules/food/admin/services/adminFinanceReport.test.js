import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../../config/prisma.js';
import { uniquePhone, uniqueTag } from '../../../../utils/testIds.js';
import { testPatch } from '../../../../utils/testGeo.js';
import { getTransactionReport, getRestaurantReport } from './adminFinanceReport.service.js';

/**
 * The two exported money reports.
 *
 * The filters are what carry risk: one that names a zone or restaurant that
 * does not exist must return nothing, not everything.
 */
const HERE = testPatch(6);
const created = { zones: [], restaurants: [], users: [], orders: [], commissions: [] };
let zoneId = null;
let restaurantId = null;
let otherRestaurantId = null;
let userId = null;
let tag = null;

const makeOrder = async (over = {}) => {
    const order = await prisma.foodOrder.create({
        data: {
            userId,
            restaurantId,
            orderId: `${tag}-${uniqueTag('O')}`,
            orderStatus: 'delivered',
            paymentMethod: 'cash',
            addrStreet: '1 Test Street',
            addrCity: 'Indore',
            addrState: 'MP',
            subtotal: 1000,
            packagingFee: 20,
            deliveryFee: 40,
            tax: 180,
            discount: 100,
            platformFee: 30,
            platformProfit: 75,
            total: 1170,
            ...over,
        },
    });
    created.orders.push(order.id);
    return order;
};

const makeTransaction = (order, over = {}) => prisma.foodTransaction.create({
    data: {
        orderId: order.id,
        userId,
        restaurantId: order.restaurantId,
        paymentMethod: 'cash',
        status: 'captured',
        subtotal: 1000,
        packagingFee: 20,
        deliveryFee: 40,
        tax: 180,
        discount: 100,
        platformFee: 30,
        total: 1170,
        totalCustomerPaid: 1170,
        restaurantShare: 900,
        commissionAmount: 100,
        riderShare: 50,
        platformNetProfit: 75,
        taxAmount: 180,
        adminDiscountShare: 60,
        restaurantDiscountShare: 40,
        ...over,
    },
});

test.before(async () => {
    tag = uniqueTag('Fin');

    const zone = await prisma.foodZone.create({
        data: { name: `Fin Zone ${tag}`, zoneName: `FinAlt ${tag}`, coordinates: HERE.ring },
    });
    created.zones.push(zone.id);
    zoneId = zone.id;

    const make = async (over = {}) => {
        const r = await prisma.foodRestaurant.create({
            data: {
                restaurantName: `${tag} Kitchen`,
                ownerName: `${tag} Owner`,
                ownerPhone: uniquePhone('9'),
                status: 'approved',
                rating: 4.5,
                totalRatings: 12,
                ...over,
            },
        });
        created.restaurants.push(r.id);
        return r.id;
    };

    restaurantId = await make({ zoneId });
    otherRestaurantId = await make({ restaurantName: `${tag} Closed`, status: 'pending' });

    const u = await prisma.foodUser.create({ data: { name: `${tag} Diner`, phone: uniquePhone('5') } });
    created.users.push(u.id);
    userId = u.id;
});

test.after(async () => {
    await prisma.foodRestaurantCommission.deleteMany({ where: { id: { in: created.commissions } } });
    await prisma.foodTransaction.deleteMany({ where: { orderId: { in: created.orders } } });
    await prisma.foodItem.deleteMany({ where: { restaurantId: { in: created.restaurants } } });
    await prisma.foodOrder.deleteMany({ where: { id: { in: created.orders } } });
    await prisma.foodUser.deleteMany({ where: { id: { in: created.users } } });
    await prisma.foodRestaurant.deleteMany({ where: { id: { in: created.restaurants } } });
    await prisma.foodZone.deleteMany({ where: { id: { in: created.zones } } });
    await prisma.$disconnect();
});

test('a transaction row carries the money and the names', async () => {
    const order = await makeOrder();
    await makeTransaction(order);

    const { transactions, summary } = await getTransactionReport({ search: order.orderId });
    assert.equal(transactions.length, 1);

    const row = transactions[0];
    // The readable id lives on the order; the search used to look for it on the
    // transaction, where there is no such column, so it never matched.
    assert.equal(row.orderId, order.orderId);
    assert.equal(row.restaurant, `${tag} Kitchen`);
    assert.equal(row.customerName, `${tag} Diner`);
    assert.equal(row.totalItemAmount, 1000, 'Decimal converted');
    assert.equal(row.platformFee, 30);
    assert.equal(row.discountedAmount, 900);
    assert.equal(row.adminDiscountShare, 60);
    assert.equal(row.restaurantDiscountShare, 40);
    assert.equal(row.orderAmount, 1170);

    assert.equal(summary.completedTransaction, 1170);
    assert.equal(summary.adminEarning, 75);
    assert.equal(summary.restaurantEarning, 900);
    assert.equal(summary.deliverymanEarning, 50);
});

test('the platform fee is derived when it was never stored', async () => {
    // An order written before the fee column existed: the totals only add up
    // with a fee of 30, so that is what the report shows.
    const legacy = await makeOrder();
    await makeTransaction(legacy, { platformFee: 0 });

    const derived = await getTransactionReport({ search: legacy.orderId });
    assert.equal(derived.transactions[0].platformFee, 30);

    // A genuinely free order: the equation balances at zero, so nothing is
    // invented.
    const free = await makeOrder({ platformFee: 0, total: 1140 });
    await makeTransaction(free, { platformFee: 0, total: 1140, totalCustomerPaid: 1140 });

    const zero = await getTransactionReport({ search: free.orderId });
    assert.equal(zero.transactions[0].platformFee, 0);
});

test('a refund is summarised separately', async () => {
    const order = await makeOrder({ orderStatus: 'cancelled_by_admin' });
    await makeTransaction(order, { status: 'refunded' });

    const { summary } = await getTransactionReport({ search: order.orderId });
    assert.equal(summary.refundedTransaction, 1170);
    assert.equal(summary.completedTransaction, 0, 'a refund is not a completed sale');
});

test('a filter naming something that does not exist returns nothing', async () => {
    const order = await makeOrder();
    await makeTransaction(order);

    // A zone by name resolves, and scopes to its restaurants.
    const byZoneName = await getTransactionReport({ zone: `FinAlt ${tag}` });
    assert.ok(byZoneName.transactions.length >= 1);

    // The dangerous case: an unmatched filter must not fall through to
    // "everything".
    const unknownZone = await getTransactionReport({ zone: `no-such-zone-${tag}` });
    assert.equal(unknownZone.transactions.length, 0);

    const unknownRestaurant = await getTransactionReport({ restaurant: `no-such-place-${tag}` });
    assert.equal(unknownRestaurant.transactions.length, 0);

    // 'All restaurants' is the picker's placeholder, not a name to look up.
    const all = await getTransactionReport({ zone: `Fin Zone ${tag}`, restaurant: 'All restaurants' });
    assert.ok(all.transactions.length >= 1);
});

test('the restaurant report rolls orders up per restaurant', async () => {
    await prisma.foodItem.create({
        data: { restaurantId, name: uniqueTag('D'), price: 100, approvalStatus: 'approved' },
    });
    await prisma.foodItem.create({
        data: { restaurantId, name: uniqueTag('D'), price: 100, approvalStatus: 'pending' },
    });

    const { restaurants, total } = await getRestaurantReport({ search: tag });
    assert.equal(total, 2, 'both this test\'s restaurants match the name search');

    const mine = restaurants.find((r) => r._id === restaurantId);
    assert.equal(mine.totalFood, 1, 'only approved dishes count');
    assert.ok(mine.totalOrder >= 4);
    assert.match(mine.totalOrderAmount, /^₹\d/);
    assert.equal(mine.averageRatings, 4.5);
    assert.equal(mine.reviews, 12);
    assert.equal(mine.zoneName, `Fin Zone ${tag}`);
    assert.equal(mine.sl, restaurants.indexOf(mine) + 1);

    // platformProfit is the real take; the flat fee is only the fallback.
    const expected = `₹${(75 * mine.totalOrder).toFixed(2)}`;
    assert.equal(mine.totalAdminCommission, expected);
});

test('the report filters by status, zone and commission', async () => {
    const active = await getRestaurantReport({ search: tag, all: 'active' });
    assert.equal(active.total, 1);
    assert.equal(active.restaurants[0]._id, restaurantId);

    const inactive = await getRestaurantReport({ search: tag, all: 'inactive' });
    assert.equal(inactive.total, 1);
    assert.equal(inactive.restaurants[0]._id, otherRestaurantId);

    const zoned = await getRestaurantReport({ search: tag, zone: `Fin Zone ${tag}` });
    assert.equal(zoned.total, 1);

    // An unmatched zone returns an empty page rather than every restaurant.
    const nowhere = await getRestaurantReport({ search: tag, zone: `no-such-zone-${tag}` });
    assert.deepEqual(nowhere.restaurants, []);
    assert.equal(nowhere.total, 0);

    // No commission rules exist for these, so the commission view is empty.
    const commission = await getRestaurantReport({ search: tag, type: 'commission' });
    assert.ok(!commission.restaurants.some((r) => r._id === restaurantId));
});

test('a time range narrows the order roll-up, not the restaurant list', async () => {
    await makeOrder({ createdAt: new Date('2022-06-01') });

    const today = await getRestaurantReport({ search: tag, time: 'today' });
    const allTime = await getRestaurantReport({ search: tag, time: 'all time' });

    const todayRow = today.restaurants.find((r) => r._id === restaurantId);
    const allRow = allTime.restaurants.find((r) => r._id === restaurantId);

    // The restaurant still appears in both; only its totals move.
    assert.equal(today.total, allTime.total);
    assert.equal(allRow.totalOrder, todayRow.totalOrder + 1);

    const explicit = await getRestaurantReport({
        search: tag,
        fromDate: '2022-01-01',
        toDate: '2022-12-31',
    });
    assert.equal(explicit.restaurants.find((r) => r._id === restaurantId).totalOrder, 1);
});
