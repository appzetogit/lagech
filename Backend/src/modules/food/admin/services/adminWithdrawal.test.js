import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../../config/prisma.js';
import {
    getWithdrawals,
    updateWithdrawalStatus,
    getDeliveryWithdrawals,
    updateDeliveryWithdrawalStatus,
} from './adminWithdrawal.service.js';

/**
 * Withdrawal approvals — a payout path.
 *
 * The Mongo version read the request, checked it was pending, read the wallet,
 * compared the balance, and only then wrote, with the debit and the status
 * change as separate statements. The tests that matter here are the concurrent
 * ones: two admins approving at the same moment must pay once.
 */
const live = Boolean(process.env.DATABASE_URL);

const created = { partners: [], restaurants: [], withdrawals: [], rWithdrawals: [] };
const stamp = () => `${Date.now()}${Math.floor(performance.now() * 1000) % 1000}`;

const makePartner = async (balance = 0, lockedAmount = 0) => {
    const partner = await prisma.foodDeliveryPartner.create({
        data: {
            name: `Payout Rider ${stamp()}`,
            phone: `6${String(Date.now()).slice(-8)}${created.partners.length}`,
            status: 'approved',
        },
    });
    created.partners.push(partner.id);

    await prisma.wallet.create({
        data: { entityType: 'deliveryBoy', entityId: partner.id, balance, lockedAmount },
    });
    return partner;
};

const makeWithdrawal = async (partner, amount, status = 'pending') => {
    const w = await prisma.foodDeliveryWithdrawal.create({
        data: { deliveryPartnerId: partner.id, amount, status },
    });
    created.withdrawals.push(w.id);
    return w;
};

const walletOf = (partnerId) =>
    prisma.wallet.findUnique({
        where: { entityType_entityId: { entityType: 'deliveryBoy', entityId: partnerId } },
    });

test.after(async () => {
    if (!live) return;
    await prisma.foodDeliveryWithdrawal.deleteMany({ where: { id: { in: created.withdrawals } } });
    await prisma.foodRestaurantWithdrawal.deleteMany({ where: { id: { in: created.rWithdrawals } } });
    await prisma.wallet.deleteMany({ where: { entityId: { in: created.partners } } });
    await prisma.foodDeliveryPartner.deleteMany({ where: { id: { in: created.partners } } });
    await prisma.foodRestaurant.deleteMany({ where: { id: { in: created.restaurants } } });
    await prisma.$disconnect();
});

test('approving a payout debits the wallet once', { skip: !live }, async () => {
    const partner = await makePartner(1000, 200);
    const w = await makeWithdrawal(partner, 200);

    const updated = await updateDeliveryWithdrawalStatus(w.id, {
        status: 'processed', // what the admin UI sends for an approval
        transactionId: 'UTR-1',
    });
    assert.equal(updated.status, 'approved');
    assert.ok(updated.processedAt);

    const wallet = await walletOf(partner.id);
    assert.equal(Number(wallet.balance), 800);
    assert.equal(Number(wallet.totalSettled), 200, 'lifetime settled tracks the payout');
    assert.equal(Number(wallet.lockedAmount), 0, 'the reservation is released');
});

test('two admins approving at once pay only once', { skip: !live }, async () => {
    const partner = await makePartner(500);
    const w = await makeWithdrawal(partner, 500);

    const results = await Promise.allSettled([
        updateDeliveryWithdrawalStatus(w.id, { status: 'approved' }),
        updateDeliveryWithdrawalStatus(w.id, { status: 'approved' }),
    ]);

    // Both calls report success, and that is deliberate: the loser finds the
    // request already in the state it asked for, so it returns rather than
    // erroring. What must not happen twice is the payout.
    assert.ok(results.every((r) => r.status === 'fulfilled'));

    const wallet = await walletOf(partner.id);
    // Both used to read `pending`, both debited, and the rider was paid twice.
    assert.equal(Number(wallet.balance), 0, 'debited once, not twice');
    assert.equal(Number(wallet.totalSettled), 500);

    const ledgerRow = await prisma.foodDeliveryWithdrawal.findUnique({ where: { id: w.id } });
    assert.equal(ledgerRow.status, 'approved');
});

test('a payout larger than the balance is refused and moves nothing', { skip: !live }, async () => {
    const partner = await makePartner(100);
    const w = await makeWithdrawal(partner, 250);

    await assert.rejects(
        () => updateDeliveryWithdrawalStatus(w.id, { status: 'approved' }),
        /balance is lower/,
    );

    // The whole thing is one transaction, so the request stays pending too —
    // it must not be marked approved with no money moved.
    const wallet = await walletOf(partner.id);
    assert.equal(Number(wallet.balance), 100);

    const after = await prisma.foodDeliveryWithdrawal.findUnique({ where: { id: w.id } });
    assert.equal(after.status, 'pending', 'no approval without a payout');
});

test('rejecting releases the reservation without paying', { skip: !live }, async () => {
    const partner = await makePartner(600, 150);
    const w = await makeWithdrawal(partner, 150);

    const updated = await updateDeliveryWithdrawalStatus(w.id, {
        status: 'rejected',
        rejectionReason: 'Bank details missing',
    });
    assert.equal(updated.status, 'rejected');

    const wallet = await walletOf(partner.id);
    assert.equal(Number(wallet.balance), 600, 'nothing paid out');
    assert.equal(Number(wallet.lockedAmount), 0, 'but the hold is lifted');
});

test('an already-decided request cannot be changed', { skip: !live }, async () => {
    const partner = await makePartner(400);
    const w = await makeWithdrawal(partner, 100);

    await updateDeliveryWithdrawalStatus(w.id, { status: 'approved' });

    await assert.rejects(
        () => updateDeliveryWithdrawalStatus(w.id, { status: 'rejected' }),
        /Cannot change a approved withdrawal/,
    );

    // Re-sending the same decision is a no-op rather than a second payout.
    const again = await updateDeliveryWithdrawalStatus(w.id, { status: 'approved' });
    assert.equal(again.status, 'approved');

    const wallet = await walletOf(partner.id);
    assert.equal(Number(wallet.balance), 300, 'still debited exactly once');
});

test('an unknown id or status is refused', { skip: !live }, async () => {
    await assert.rejects(
        () => updateDeliveryWithdrawalStatus('bad-id', { status: 'approved' }),
        /Invalid withdrawal ID/,
    );
    await assert.rejects(
        () => updateDeliveryWithdrawalStatus('a'.repeat(24), { status: 'nonsense' }),
        /Invalid withdrawal status/,
    );
    await assert.rejects(
        () => updateDeliveryWithdrawalStatus('a'.repeat(24), { status: 'approved' }),
        /not found/,
    );
});

test('delivery payouts list with their partner details', { skip: !live }, async () => {
    const partner = await makePartner(900);
    const w = await makeWithdrawal(partner, 321);

    const { requests, total } = await getDeliveryWithdrawals({ status: 'Pending', limit: 500 });
    assert.ok(total >= 1);

    const row = requests.find((r) => r.id === w.id);
    assert.equal(row.deliveryName, partner.name, 'joined through the foreign key');
    assert.match(row.deliveryIdString, /^DEL/, 'short code derived from the id');
    assert.equal(row.amount, 321, 'Decimal converted for the client');
    assert.equal(row.status, 'Pending', 'the table renders it capitalised');

    // The search box matches on amount.
    const byAmount = await getDeliveryWithdrawals({ search: '321', limit: 500 });
    assert.ok(byAmount.requests.some((r) => r.id === w.id));
});

test('a restaurant payout is decided once', { skip: !live }, async () => {
    const restaurant = await prisma.foodRestaurant.create({
        data: {
            restaurantName: `Payout Rest ${stamp()}`,
            ownerName: 'Owner',
            ownerPhone: `9${String(Date.now()).slice(-9)}`,
            status: 'approved',
            accountHolderName: 'Owner Name',
            accountNumber: '000111222',
            ifscCode: 'TEST0001',
        },
    });
    created.restaurants.push(restaurant.id);

    const w = await prisma.foodRestaurantWithdrawal.create({
        data: { restaurantId: restaurant.id, amount: 1500 },
    });
    created.rWithdrawals.push(w.id);

    const { requests } = await getWithdrawals({ restaurantId: restaurant.id });
    const row = requests.find((r) => r.id === w.id);
    assert.equal(row.restaurantName, restaurant.restaurantName);
    assert.equal(row.restaurantBankDetails.ifscCode, 'TEST0001');
    assert.match(row.restaurantIdString, /^REST/);

    const approved = await updateWithdrawalStatus(w.id, { status: 'approved', transactionId: 'UTR-9' });
    assert.equal(approved.status, 'approved');

    await assert.rejects(
        () => updateWithdrawalStatus(w.id, { status: 'rejected' }),
        /Cannot change a approved withdrawal/,
    );
});
