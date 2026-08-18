import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../config/prisma.js';
import { uniquePhone, uniqueTag } from '../../../utils/testIds.js';
import {
    isRestaurantEarnedOrder,
    computeRestaurantOrderShare,
    orderMoney,
} from './restaurantPayout.util.js';
import { getRestaurantFinance } from '../restaurant/services/restaurantFinance.service.js';
import { getRestaurantAnalytics } from '../admin/services/adminRestaurantAnalytics.service.js';
import { getTaxReport } from '../admin/services/adminTaxReport.service.js';

/**
 * The reports now sum in SQL instead of reducing a whole table in Node.
 *
 * That means the payout formula exists twice — as JavaScript in
 * restaurantPayout.util.js and as SQL in restaurantPayout.sql.js — and the two
 * silently drifting apart would misstate what a restaurant is owed. These tests
 * exist to make that drift impossible to merge.
 */
const created = { restaurants: [], users: [], orders: [] };
let restaurantId = null;
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
            packagingFee: 25,
            restaurantCommission: 150,
            deliveryFee: 40,
            platformFee: 30,
            tax: 180,
            discount: 0,
            total: 1275,
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
        restaurantId,
        paymentMethod: 'cash',
        status: 'captured',
        subtotal: 1000,
        total: 1275,
        totalCustomerPaid: 1275,
        restaurantShare: 875,
        commissionAmount: 150,
        riderShare: 40,
        platformNetProfit: 30,
        ...over,
    },
});

/** The number the old in-Node implementation would have produced. */
const payoutInNode = async () => {
    const orders = await prisma.foodOrder.findMany({ where: { restaurantId } });
    const transactions = await prisma.foodTransaction.findMany({ where: { restaurantId } });
    const txByOrderId = new Map(transactions.map((tx) => [tx.orderId, tx]));

    return orders
        .filter(isRestaurantEarnedOrder)
        .reduce((total, order) => total + computeRestaurantOrderShare(
            orderMoney(order, txByOrderId.get(order.id)), [], restaurantId,
        ), 0);
};

test.before(async () => {
    tag = uniqueTag('Sql');

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

    const u = await prisma.foodUser.create({ data: { phone: uniquePhone('5') } });
    created.users.push(u.id);
    userId = u.id;
});

test.after(async () => {
    await prisma.foodTransaction.deleteMany({ where: { restaurantId: { in: created.restaurants } } });
    await prisma.foodOrder.deleteMany({ where: { restaurantId: { in: created.restaurants } } });
    await prisma.foodUser.deleteMany({ where: { id: { in: created.users } } });
    await prisma.foodRestaurant.deleteMany({ where: { id: { in: created.restaurants } } });
    await prisma.$disconnect();
});

test('SQL and JS agree across every shape of order', async () => {
    // With a ledger row: the recorded share wins.
    await makeTransaction(await makeOrder());
    // Without one: reconstructed from the order's own columns.
    await makeOrder();
    // Not earned, in three different ways.
    await makeOrder({ orderStatus: 'preparing' });
    await makeOrder({ orderStatus: 'cancelled_by_user' });
    await makeOrder({ orderStatus: 'pending_payment' });
    // Earned by delivery phase rather than by status.
    await makeOrder({ orderStatus: 'picked_up', deliveryPhase: 'delivered' });
    // A share the columns would put below zero.
    await makeOrder({ subtotal: 10, packagingFee: 0, restaurantCommission: 900 });
    // A recorded share of exactly zero is a real zero, not a missing value.
    await makeTransaction(await makeOrder(), { restaurantShare: 0 });

    const expected = await payoutInNode();
    const { wallet } = await getRestaurantFinance(restaurantId);

    assert.equal(wallet.totalEarnings, expected);
    assert.ok(expected > 0, 'the fixture must actually exercise the formula');

    // And the other two reports have to land on the same number.
    const { analytics } = await getRestaurantAnalytics(restaurantId);
    assert.equal(analytics.restaurantEarning, expected);

    const { reports } = await getTaxReport({ search: tag });
    const mine = reports.find((r) => r.id === restaurantId);
    assert.equal(mine.totalIncome, `₹${expected.toFixed(2)}`);
});

test('an order count is the earned orders, not every row', async () => {
    const { wallet } = await getRestaurantFinance(restaurantId);
    const { analytics } = await getRestaurantAnalytics(restaurantId);

    // 8 orders created, 3 of which are not earned.
    assert.equal(wallet.totalOrders, 5);
    assert.equal(analytics.totalOrders, 8, 'the counts include every order');
    assert.equal(analytics.completedOrders, 4, 'delivered by status');
});

test('a discount with no ledger row is corrected, not over-counted', async () => {
    // The one case SQL cannot settle on its own: no transaction, so no recorded
    // split, so how much of the discount the restaurant bore has to be worked
    // out by matching the offer. SQL alone would credit the restaurant the
    // whole discount.
    await makeOrder({ subtotal: 500, packagingFee: 0, restaurantCommission: 0, discount: 100 });

    const expected = await payoutInNode();
    const { wallet } = await getRestaurantFinance(restaurantId);
    assert.equal(wallet.totalEarnings, expected);

    const { analytics } = await getRestaurantAnalytics(restaurantId);
    assert.equal(analytics.restaurantEarning, expected);
});

test('the page is a page, and the totals cover everything', async () => {
    const first = await getRestaurantFinance(restaurantId, { ordersLimit: 2, ordersPage: 1 });
    const second = await getRestaurantFinance(restaurantId, { ordersLimit: 2, ordersPage: 2 });

    // The rows are paginated...
    assert.equal(first.wallet.orders.length, 2);
    assert.equal(second.wallet.orders.length, 2);
    assert.notEqual(first.wallet.orders[0].orderId, second.wallet.orders[0].orderId);

    // ...but the money is not. Both pages report the same lifetime total, which
    // is the whole point: the old code could only total what it had loaded.
    assert.equal(first.wallet.totalEarnings, second.wallet.totalEarnings);
    assert.equal(first.wallet.totalOrders, second.wallet.totalOrders);
    assert.ok(first.wallet.totalOrders > first.wallet.orders.length);

    assert.equal(first.wallet.pagination.total, first.wallet.totalOrders);
    assert.equal(first.invoiceSummary.count, first.wallet.totalOrders);
});

test('reading a page does not scale with the table', async () => {
    const { wallet: baseline } = await getRestaurantFinance(restaurantId, { ordersLimit: 1 });

    // Enough rows that loading them all would show up.
    const bulk = Array.from({ length: 400 }, (_, i) => ({
        userId,
        restaurantId,
        orderId: `${tag}-bulk-${i}`,
        orderStatus: 'delivered',
        paymentMethod: 'cash',
        addrStreet: '1 Test Street',
        addrCity: 'Indore',
        addrState: 'MP',
        subtotal: 100,
        packagingFee: 0,
        restaurantCommission: 10,
        total: 100,
    }));
    await prisma.foodOrder.createMany({ data: bulk });
    const ids = await prisma.foodOrder.findMany({
        where: { orderId: { startsWith: `${tag}-bulk-` } },
        select: { id: true },
    });
    created.orders.push(...ids.map((o) => o.id));

    const before = process.memoryUsage().heapUsed;
    const { wallet } = await getRestaurantFinance(restaurantId, { ordersLimit: 10 });
    const grew = process.memoryUsage().heapUsed - before;

    // Every one of the 400 is counted and summed...
    assert.equal(wallet.totalOrders, baseline.totalOrders + 400);
    assert.equal(wallet.totalEarnings, await payoutInNode());
    // ...while only ten rows crossed into Node. The bound is what is asserted;
    // the exact figure is noisy, so this is deliberately loose — it would have
    // been megabytes when the whole history was materialised.
    assert.equal(wallet.orders.length, 10);
    assert.ok(grew < 8_000_000, `heap grew by ${Math.round(grew / 1024)}KB`);
});
