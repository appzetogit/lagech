import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../config/prisma.js';
import { uniquePhone, uniqueTag } from '../../utils/testIds.js';
import { creditWallet } from './wallet.service.js';
import { getBalance } from './transaction.service.js';
import {
    createSettlement,
    processSettlement,
    listSettlements,
    getSettlementById,
} from './settlement.service.js';

/**
 * Paying restaurants and riders what they have earned.
 *
 * A settlement takes money out of the entity's wallet and hands it over
 * off-platform, so the two failure modes are paying twice and recording a
 * payout that never left. Both are invisible until someone reconciles a bank
 * statement against the ledger weeks later.
 */
const created = { restaurants: [], partners: [], settlements: [] };
let tag = null;

test.before(() => {
    tag = uniqueTag('Setl');
});

test.after(async () => {
    const entityIds = [...created.restaurants, ...created.partners];
    await prisma.transaction.deleteMany({ where: { entityId: { in: entityIds } } });
    await prisma.settlement.deleteMany({ where: { entityId: { in: entityIds } } });
    await prisma.wallet.deleteMany({ where: { entityId: { in: entityIds } } });
    await prisma.foodDeliveryPartner.deleteMany({ where: { id: { in: created.partners } } });
    await prisma.foodRestaurant.deleteMany({ where: { id: { in: created.restaurants } } });
    await prisma.$disconnect();
});

/** A restaurant holding `balance` in its wallet, earned the ordinary way. */
const restaurantWith = async (balance) => {
    const restaurant = await prisma.foodRestaurant.create({
        data: {
            restaurantName: `${tag} Kitchen`,
            ownerName: 'Owner',
            ownerPhone: uniquePhone('9'),
            status: 'approved',
        },
    });
    created.restaurants.push(restaurant.id);

    if (balance > 0) {
        await creditWallet({
            entityType: 'restaurant',
            entityId: restaurant.id,
            amount: balance,
            description: 'Order earnings',
            category: 'order_payment',
        });
    }
    return restaurant;
};

const riderWith = async (balance) => {
    const partner = await prisma.foodDeliveryPartner.create({
        data: { name: `${tag} Rider`, phone: uniquePhone('6'), status: 'approved' },
    });
    created.partners.push(partner.id);

    if (balance > 0) {
        await creditWallet({
            entityType: 'deliveryBoy',
            entityId: partner.id,
            amount: balance,
            description: 'Delivery earnings',
            category: 'delivery_earning',
        });
    }
    return partner;
};

// ── requesting a payout ──

test('a settlement records the request without moving any money', async () => {
    const restaurant = await restaurantWith(1000);

    const settlement = await createSettlement({
        entityType: 'restaurant',
        entityId: restaurant.id,
        amount: 800,
        notes: 'Weekly payout',
    });

    assert.equal(settlement.status, 'pending');
    assert.equal(Number(settlement.amount), 800);
    assert.equal(settlement.currency, 'INR');

    // Requesting is not paying. Nothing is reserved either — the docstring
    // used to claim the amount was locked, and no version of this ever
    // called lockWalletAmount.
    const { balance, lockedAmount } = await getBalance('restaurant', restaurant.id);
    assert.equal(balance, 1000);
    assert.equal(lockedAmount, 0);
});

test('only restaurants and riders can be settled', async () => {
    // A customer wallet holds refunds and top-ups, and the platform wallet is
    // the other side of every payout. Neither is paid out this way.
    for (const entityType of ['user', 'admin', 'restaurants', '']) {
        await assert.rejects(
            () => createSettlement({ entityType, entityId: 'a'.repeat(24), amount: 100 }),
            /only for restaurant or deliveryBoy/,
        );
    }
});

// ── paying it out ──

test('processing debits the wallet and closes the settlement', async () => {
    const restaurant = await restaurantWith(1000);
    const settlement = await createSettlement({
        entityType: 'restaurant', entityId: restaurant.id, amount: 800,
    });

    const processed = await processSettlement(settlement.id, {
        processedBy: 'admin-id-here', payoutRef: 'NEFT-12345',
    });

    assert.equal(processed.status, 'processed');
    assert.equal(processed.payoutRef, 'NEFT-12345');
    assert.equal(processed.processedBy, 'admin-id-here');
    assert.ok(processed.processedAt, 'a processed payout records when');

    const { balance } = await getBalance('restaurant', restaurant.id);
    assert.equal(balance, 200, 'the money has left the wallet');
});

test('the payout is one ledger entry, linked back to the settlement', async () => {
    const restaurant = await restaurantWith(1000);
    const settlement = await createSettlement({
        entityType: 'restaurant', entityId: restaurant.id, amount: 800,
    });

    await processSettlement(settlement.id, { payoutRef: 'NEFT-1' });

    const payouts = await prisma.transaction.findMany({
        where: { entityId: restaurant.id, category: 'settlement_payout' },
    });
    assert.equal(payouts.length, 1);
    assert.equal(payouts[0].type, 'debit');
    assert.equal(Number(payouts[0].amount), 800);
    // Reconciliation walks from the bank reference to the settlement to this
    // row, so the link has to be written.
    assert.equal(payouts[0].settlementId, settlement.id);
    assert.equal(Number(payouts[0].balanceAfter), 200);
});

test('processing bumps the lifetime settled total', async () => {
    const restaurant = await restaurantWith(1000);
    const first = await createSettlement({
        entityType: 'restaurant', entityId: restaurant.id, amount: 300,
    });
    const second = await createSettlement({
        entityType: 'restaurant', entityId: restaurant.id, amount: 200,
    });

    await processSettlement(first.id);
    await processSettlement(second.id);

    const wallet = await prisma.wallet.findFirst({ where: { entityId: restaurant.id } });
    assert.equal(Number(wallet.totalSettled), 500, 'it accumulates rather than overwriting');
    assert.equal(Number(wallet.balance), 500);
});

test('processing an already-processed settlement pays nothing further', async () => {
    const restaurant = await restaurantWith(1000);
    const settlement = await createSettlement({
        entityType: 'restaurant', entityId: restaurant.id, amount: 800,
    });

    await processSettlement(settlement.id, { payoutRef: 'NEFT-1' });
    const again = await processSettlement(settlement.id, { payoutRef: 'NEFT-2' });

    assert.equal(again.status, 'processed');
    assert.equal(again.payoutRef, 'NEFT-1', 'the original payout reference stands');

    const { balance } = await getBalance('restaurant', restaurant.id);
    assert.equal(balance, 200, 'debited once, not twice');

    const payouts = await prisma.transaction.count({
        where: { entityId: restaurant.id, category: 'settlement_payout' },
    });
    assert.equal(payouts, 1);
});

test('a payout larger than the balance is refused and leaves the wallet alone', async () => {
    const restaurant = await restaurantWith(500);
    const settlement = await createSettlement({
        entityType: 'restaurant', entityId: restaurant.id, amount: 800,
    });

    await assert.rejects(() => processSettlement(settlement.id), /Insufficient balance/);

    const { balance } = await getBalance('restaurant', restaurant.id);
    assert.equal(balance, 500, 'nothing was taken');

    // And it is marked failed rather than left looking payable.
    const after = await getSettlementById(settlement.id);
    assert.equal(after.status, 'failed');
    assert.match(after.metadata.error, /Insufficient balance/);
});

test('a failed settlement is not retried through the same row', async () => {
    const restaurant = await restaurantWith(100);
    const settlement = await createSettlement({
        entityType: 'restaurant', entityId: restaurant.id, amount: 800,
    });
    await assert.rejects(() => processSettlement(settlement.id));

    // Even once the balance covers it. A failed payout is a dead row: the
    // admin raises a new settlement rather than reviving this one, which is
    // what keeps a half-finished payout from being finished twice.
    await creditWallet({
        entityType: 'restaurant', entityId: restaurant.id, amount: 1000,
        description: 'More earnings', category: 'order_payment',
    });
    await assert.rejects(
        () => processSettlement(settlement.id),
        /Cannot process a failed settlement/,
    );

    const { balance } = await getBalance('restaurant', restaurant.id);
    assert.equal(balance, 1100, 'still untouched');
});

test('a rider is settled the same way as a restaurant', async () => {
    const rider = await riderWith(600);
    const settlement = await createSettlement({
        entityType: 'deliveryBoy', entityId: rider.id, amount: 600,
    });

    const processed = await processSettlement(settlement.id, { payoutRef: 'UPI-9' });
    assert.equal(processed.status, 'processed');
    assert.equal((await getBalance('deliveryBoy', rider.id)).balance, 0);
});

test('processing an unknown settlement is an error, not a silent pass', async () => {
    await assert.rejects(() => processSettlement('a'.repeat(24)), /Settlement not found/);
});

// ── reading them back ──

test('settlements are listed by entity and by status', async () => {
    const restaurant = await restaurantWith(1000);
    const done = await createSettlement({
        entityType: 'restaurant', entityId: restaurant.id, amount: 300,
    });
    await createSettlement({ entityType: 'restaurant', entityId: restaurant.id, amount: 200 });
    await processSettlement(done.id);

    const all = await listSettlements({ entityId: restaurant.id });
    assert.equal(all.total, 2);
    assert.equal(all.page, 1);

    const pending = await listSettlements({ entityId: restaurant.id, status: 'pending' });
    assert.equal(pending.total, 1);
    assert.equal(Number(pending.settlements[0].amount), 200);

    const byType = await listSettlements({ entityType: 'deliveryBoy', entityId: restaurant.id });
    assert.equal(byType.total, 0, 'entityId alone does not identify a wallet');
});

test('a listed amount is a number, so a caller can add it up', async () => {
    const restaurant = await restaurantWith(1000);
    await createSettlement({ entityType: 'restaurant', entityId: restaurant.id, amount: 300 });
    await createSettlement({ entityType: 'restaurant', entityId: restaurant.id, amount: 500 });

    const { settlements } = await listSettlements({ entityId: restaurant.id });

    // The admin finance summary sums these with a reduce. Decimal coerces to a
    // string in arithmetic, so leaving the column raw made that total read
    // "0300500" instead of 800 — the concatenation of every pending payout.
    assert.equal(typeof settlements[0].amount, 'number');
    assert.equal(settlements.reduce((sum, s) => sum + s.amount, 0), 800);
});

test('a settlement can be read back with the payout behind it', async () => {
    const restaurant = await restaurantWith(1000);
    const settlement = await createSettlement({
        entityType: 'restaurant', entityId: restaurant.id, amount: 400,
    });
    await processSettlement(settlement.id, { payoutRef: 'NEFT-7' });

    const found = await getSettlementById(settlement.id);
    assert.equal(found.id, settlement.id);
    assert.equal(found.transactions.length, 1, 'the ledger row comes with it');
    assert.equal(Number(found.transactions[0].amount), 400);

    assert.equal(await getSettlementById('a'.repeat(24)), null);
});
