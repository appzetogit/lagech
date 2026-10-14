import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../../config/prisma.js';
import { uniquePhone } from '../../../../utils/testIds.js';
import {
    collectCashFromRestaurant,
    getRestaurantEarnings,
    getRestaurantWalletOverview,
    listRestaurantCashCollections,
} from './adminRestaurantCash.service.js';
import { getWalletSummaries } from '../../restaurant/services/restaurantFinance.service.js';

/**
 * "Collect Cash From Store" against the database. The pure rules are in
 * adminRestaurantCash.helpers.test.js.
 *
 * A restaurant owes the platform when what it took (withdrawals) is more than
 * it earned -- here an approved withdrawal with no earned orders behind it.
 */

const created = { restaurants: [] };
const stamp = () => `${Date.now()}${Math.floor(performance.now() * 1000) % 1000}`;

const makeRestaurant = async () => {
    const restaurant = await prisma.foodRestaurant.create({
        data: { restaurantName: `Cash Rest ${stamp()}`, ownerName: 'Owner', ownerPhone: uniquePhone('9'), status: 'approved' },
    });
    created.restaurants.push(restaurant.id);
    return restaurant;
};

const overdraw = (restaurantId, amount) =>
    prisma.foodRestaurantWithdrawal.create({
        data: { restaurantId, amount, status: 'approved', source: 'manual', processedAt: new Date() },
    });

test.after(async () => {
    await prisma.foodRestaurantCashCollection.deleteMany({ where: { restaurantId: { in: created.restaurants } } });
    await prisma.foodRestaurantWithdrawal.deleteMany({ where: { restaurantId: { in: created.restaurants } } });
    await prisma.foodRestaurant.deleteMany({ where: { id: { in: created.restaurants } } });
    await prisma.$disconnect();
});

test('a restaurant that owes nothing has nothing to collect, and nothing is written', async () => {
    const restaurant = await makeRestaurant();
    const overview = await getRestaurantWalletOverview(restaurant.id);
    assert.equal(overview.collectedCash, 0);
    assert.equal(overview.totalEarning, 0);

    await assert.rejects(
        () => collectCashFromRestaurant(restaurant.id, { amount: 10 }),
        /holds no cash owed/,
    );
    const { collections } = await listRestaurantCashCollections(restaurant.id);
    assert.equal(collections.length, 0);

    const earnings = await getRestaurantEarnings(restaurant.id, { page: 1, limit: 10 });
    assert.deepEqual(earnings.orders, []);
    assert.equal(earnings.totals.totalEarnings, 0);
});

test('cash owed is collected up to what is owed, once per request key, and clears the debt', async () => {
    const restaurant = await makeRestaurant();
    await overdraw(restaurant.id, 300);

    let overview = await getRestaurantWalletOverview(restaurant.id);
    assert.equal(overview.collectedCash, 300);
    assert.equal(overview.totalWithdrawn, 300);
    assert.equal(overview.withdrawableBalance, 0);

    await assert.rejects(
        () => collectCashFromRestaurant(restaurant.id, { amount: 300.5 }),
        /more than the restaurant owes/,
    );

    const first = await collectCashFromRestaurant(
        restaurant.id,
        { amount: 200, method: 'upi', reference: 'UPI-1', requestKey: 'collect-1' },
        null,
    );
    assert.equal(first.amount, 200);
    assert.equal(first.method, 'upi');

    // The same submit again hands back the same row.
    const again = await collectCashFromRestaurant(restaurant.id, { amount: 200, requestKey: 'collect-1' });
    assert.equal(again.id, first.id);
    assert.equal(again.duplicate, true);

    overview = await getRestaurantWalletOverview(restaurant.id);
    assert.equal(overview.collectedCash, 100);
    assert.equal(overview.totalCashCollected, 200);

    await collectCashFromRestaurant(restaurant.id, { amount: 100 });
    overview = await getRestaurantWalletOverview(restaurant.id);
    assert.equal(overview.collectedCash, 0);
    // Square again: the collections never become a balance to withdraw.
    assert.equal(overview.withdrawableBalance, 0);

    const summary = (await getWalletSummaries([restaurant.id])).get(restaurant.id);
    assert.equal(summary.walletBalance, 0);
    assert.equal(summary.cashOwed, 0);

    const list = await listRestaurantCashCollections(restaurant.id);
    assert.equal(list.collections.length, 2);
    assert.equal(list.totals.amount, 300);
});

test('two admins collecting the whole debt at once collect it once', async () => {
    const restaurant = await makeRestaurant();
    await overdraw(restaurant.id, 500);

    const results = await Promise.allSettled([
        collectCashFromRestaurant(restaurant.id, { amount: 500 }),
        collectCashFromRestaurant(restaurant.id, { amount: 500 }),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    const { totals } = await listRestaurantCashCollections(restaurant.id);
    assert.equal(totals.amount, 500);
});

test('an invalid restaurant id is refused', async () => {
    await assert.rejects(() => getRestaurantWalletOverview('nope'), /Invalid restaurant/);
    await assert.rejects(() => collectCashFromRestaurant('nope', { amount: 1 }), /Invalid restaurant/);
});
