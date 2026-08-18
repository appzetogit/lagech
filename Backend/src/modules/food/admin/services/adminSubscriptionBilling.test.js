import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../../config/prisma.js';
import { uniquePhone, uniqueTag } from '../../../../utils/testIds.js';
import { listSubscriptionInvoicesAdmin } from './adminSubscriptionBilling.service.js';
import { getRestaurantFinance, getWalletSummaries } from '../../restaurant/services/restaurantFinance.service.js';

/**
 * The admin invoice table.
 *
 * Its wallet column used to cost one full finance computation per row — each
 * reading that restaurant's whole order history — so the page got slower with
 * every restaurant on it. These tests pin the batching, and pin that the number
 * a restaurant sees and the number an admin sees are the same number.
 */
const RESTAURANTS = 12;
const created = { restaurants: [], users: [], orders: [], invoices: [] };
let userId = null;
let tag = null;

test.before(async () => {
    tag = uniqueTag('Inv');

    const u = await prisma.foodUser.create({ data: { phone: uniquePhone('5') } });
    created.users.push(u.id);
    userId = u.id;

    for (let i = 0; i < RESTAURANTS; i += 1) {
        const r = await prisma.foodRestaurant.create({
            data: {
                restaurantName: `${tag} Kitchen ${i}`,
                ownerName: 'Owner',
                ownerPhone: uniquePhone('9'),
                status: 'approved',
            },
        });
        created.restaurants.push(r.id);

        // Three earned orders each: payout is subtotal + packaging − commission.
        for (let j = 0; j < 3; j += 1) {
            const order = await prisma.foodOrder.create({
                data: {
                    userId,
                    restaurantId: r.id,
                    orderId: `${tag}-${i}-${j}`,
                    orderStatus: 'delivered',
                    paymentMethod: 'cash',
                    addrStreet: '1 St', addrCity: 'Indore', addrState: 'MP',
                    subtotal: 1000, packagingFee: 0, restaurantCommission: 100, total: 1000,
                },
            });
            created.orders.push(order.id);
        }

        const invoice = await prisma.foodSubscriptionInvoice.create({
            data: {
                restaurantId: r.id,
                billingMonth: `2034-${String((i % 12) + 1).padStart(2, '0')}`,
                planName: 'starter',
                planAmount: 999,
                gstAmount: 180,
                totalAmount: 1179,
                outstandingAmount: i === 0 ? 500 : 0,
                status: i === 0 ? 'partially_settled' : 'settled',
                paidAmount: i === 0 ? 679 : 1179,
            },
        });
        created.invoices.push(invoice.id);
    }
});

test.after(async () => {
    await prisma.foodSubscriptionInvoice.deleteMany({ where: { restaurantId: { in: created.restaurants } } });
    await prisma.foodRestaurantWithdrawal.deleteMany({ where: { restaurantId: { in: created.restaurants } } });
    await prisma.foodOrder.deleteMany({ where: { id: { in: created.orders } } });
    await prisma.foodUser.deleteMany({ where: { id: { in: created.users } } });
    await prisma.foodRestaurant.deleteMany({ where: { id: { in: created.restaurants } } });
    await prisma.$disconnect();
});

test('the wallet column costs the same whether the page has 1 row or 12', async () => {
    // Count the queries the batch actually issues. A regression to per-row
    // would make this grow with the number of restaurants, which is the whole
    // failure mode being guarded against.
    const countQueries = async (ids) => {
        let queries = 0;
        const db = prisma.$extends({
            query: {
                $allModels: {
                    async $allOperations({ query, args }) { queries += 1; return query(args); },
                },
                // groupBy and the raw aggregate both have to be seen, or the
                // counter would read zero and this test would pass on nothing.
                $allOperations({ query, args }) { queries += 1; return query(args); },
            },
        });
        await getWalletSummaries(ids, { db });
        return queries;
    };

    const one = await countQueries(created.restaurants.slice(0, 1));
    const twelve = await countQueries(created.restaurants);

    assert.ok(one > 0, 'the counter must actually observe the queries');

    assert.equal(
        one, twelve,
        `one restaurant took ${one} model queries, twelve took ${twelve} — the batch is not batching`,
    );
});

test('every restaurant on the page gets its own correct figures', async () => {
    const summaries = await getWalletSummaries(created.restaurants);

    assert.equal(summaries.size, RESTAURANTS);
    for (const id of created.restaurants) {
        const s = summaries.get(id);
        // 3 orders x (1000 - 100).
        assert.equal(s.totalEarnings, 2700);
        assert.equal(s.totals.orderCount, 3);
    }

    // The first restaurant owes 500, so that much of its balance is locked.
    const owing = summaries.get(created.restaurants[0]);
    assert.equal(owing.lockedAmount, 500);
    assert.equal(owing.walletBalance, 2700);
    assert.equal(owing.netAvailable, 2200);

    // The rest have settled, so nothing is held back.
    const settled = summaries.get(created.restaurants[1]);
    assert.equal(settled.lockedAmount, 0);
    assert.equal(settled.netAvailable, 2700);
});

test('an unknown restaurant reads as zero, not as missing', async () => {
    const summaries = await getWalletSummaries(['a'.repeat(24), created.restaurants[0]]);

    // A restaurant with no orders still needs a row, or the table renders a gap.
    assert.equal(summaries.get('a'.repeat(24)).totalEarnings, 0);
    assert.equal(summaries.get('a'.repeat(24)).netAvailable, 0);
    assert.equal(summaries.get(created.restaurants[0]).totalEarnings, 2700);

    assert.equal((await getWalletSummaries([])).size, 0);
    assert.equal((await getWalletSummaries()).size, 0);
});

test('the admin and the restaurant are shown the same balance', async () => {
    const id = created.restaurants[0];

    const { invoices } = await listSubscriptionInvoicesAdmin({ search: tag, limit: 100 });
    const row = invoices.find((inv) => inv.restaurantId === id);
    const finance = await getRestaurantFinance(id);

    // Two screens, one definition. They used to compute this separately.
    assert.equal(row.wallet.totalEarnings, finance.wallet.totalEarnings);
    assert.equal(row.wallet.walletBalance, finance.wallet.withdrawableBalance);
    assert.equal(row.wallet.netAvailable, finance.wallet.netAvailable);
    assert.equal(row.wallet.lockedAmount, finance.subscription.lockedAmount);

    assert.equal(row.wallet.netAvailable, 2200);
});

test('a withdrawal moves both views together', async () => {
    const id = created.restaurants[1];
    const withdrawal = await prisma.foodRestaurantWithdrawal.create({
        data: { restaurantId: id, amount: 700, status: 'pending' },
    });

    const summaries = await getWalletSummaries([id]);
    const finance = await getRestaurantFinance(id);

    // Pending counts against the balance immediately, or it could be taken twice.
    assert.equal(summaries.get(id).totalWithdrawn, 700);
    assert.equal(summaries.get(id).walletBalance, 2000);
    assert.equal(finance.wallet.withdrawableBalance, 2000);

    await prisma.foodRestaurantWithdrawal.delete({ where: { id: withdrawal.id } });
});

test('the invoice list still sorts and filters on the wallet balance', async () => {
    const byWallet = await listSubscriptionInvoicesAdmin({
        search: tag, sortBy: 'wallet', sortOrder: 'desc', limit: 100,
    });
    const balances = byWallet.invoices.map((inv) => inv.wallet.walletBalance);
    assert.deepEqual(balances, [...balances].sort((a, b) => b - a));

    // A wallet bound is not a column, so it is applied after the rows hydrate.
    const rich = await listSubscriptionInvoicesAdmin({
        search: tag, amountOn: 'wallet', amountMin: 2700, limit: 100,
    });
    assert.equal(rich.invoices.length, RESTAURANTS);

    const none = await listSubscriptionInvoicesAdmin({
        search: tag, amountOn: 'wallet', amountMin: 999999, limit: 100,
    });
    assert.equal(none.invoices.length, 0);
});
