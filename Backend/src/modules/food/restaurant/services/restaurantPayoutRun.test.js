import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../../config/prisma.js';
import { uniquePhone, uniqueTag } from '../../../../utils/testIds.js';
import {
    decidePayouts,
    generateRestaurantPayouts,
    getPayoutBatch,
} from './restaurantPayout.service.js';
import { createWithdrawalRequest } from './restaurantWithdrawal.service.js';
import { getWalletSummaries } from './restaurantFinance.service.js';
import { updateWithdrawalStatus } from '../../admin/services/adminWithdrawal.service.js';

/**
 * The payout run against a real database: who is paid, how much, and that the
 * same money can never go out twice -- not by a second run, and not by a
 * manual request on top of a pending payout line.
 */

const created = { restaurants: [], users: [], orders: [], batches: [] };
let tag;
let userId;

// A day no other run can have claimed: runDate is unique across the table.
const day = 1 + Math.floor(Math.random() * 27);
const month = 1 + Math.floor(Math.random() * 12);
const year = 2060 + Math.floor(Math.random() * 30);
const RUN_AT = new Date(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T00:00:00Z`); // 05:30 IST
const daysBefore = (n) => new Date(RUN_AT.getTime() - n * 24 * 60 * 60 * 1000);

const makeRestaurant = async (over = {}) => {
    const r = await prisma.foodRestaurant.create({
        data: {
            restaurantName: `${tag} ${created.restaurants.length}`,
            ownerName: 'Owner',
            ownerPhone: uniquePhone('9'),
            status: 'approved',
            ...over,
        },
    });
    created.restaurants.push(r.id);
    return r;
};

/** An earned order paying the restaurant `share` (subtotal less commission). */
const makeOrder = async (restaurant, share, createdAt) => {
    const order = await prisma.foodOrder.create({
        data: {
            userId,
            restaurantId: restaurant.id,
            orderId: `${tag}-${created.orders.length}`,
            orderStatus: 'delivered',
            paymentMethod: 'cash',
            addrStreet: '1 St', addrCity: 'Phaltan', addrState: 'MH',
            subtotal: share + 100, packagingFee: 0, restaurantCommission: 100, total: share + 100,
            createdAt,
        },
    });
    created.orders.push(order.id);
};

const bank = { accountNumber: '000111222333', ifscCode: 'SBIN0000001', accountHolderName: 'Owner' };

test.before(async () => {
    tag = uniqueTag('Payout');
    const u = await prisma.foodUser.create({ data: { phone: uniquePhone('5') } });
    created.users.push(u.id);
    userId = u.id;
});

test.after(async () => {
    await prisma.foodRestaurantWithdrawal.deleteMany({
        where: { OR: [{ restaurantId: { in: created.restaurants } }, { batchId: { in: created.batches } }] },
    });
    await prisma.foodRestaurantPayoutBatch.deleteMany({ where: { id: { in: created.batches } } });
    await prisma.foodOrder.deleteMany({ where: { id: { in: created.orders } } });
    await prisma.foodUser.deleteMany({ where: { id: { in: created.users } } });
    await prisma.foodRestaurant.deleteMany({ where: { id: { in: created.restaurants } } });
    await prisma.$disconnect();
});

test('a run pays what was earned before the cut-off, once, to the details on file', async () => {
    const paid = await makeRestaurant(bank);
    await makeOrder(paid, 1000, daysBefore(3));
    // Placed after the cut-off (start of yesterday, IST): held back to the next run.
    await makeOrder(paid, 400, daysBefore(0.1));

    const upiOnly = await makeRestaurant({ upiId: 'owner@upi', payoutMethod: 'upi' });
    await makeOrder(upiOnly, 250, daysBefore(5));

    const noDetails = await makeRestaurant();
    await makeOrder(noDetails, 700, daysBefore(5));

    const result = await generateRestaurantPayouts({ now: RUN_AT, force: true, triggeredBy: 'test' });
    assert.equal(result.created, true);
    created.batches.push(result.batch.id);

    const { payouts, batch } = await getPayoutBatch(result.batch.id);
    const line = (r) => payouts.find((p) => p.restaurantId === r.id);

    assert.equal(line(paid).amount, 1000, 'the recent 400 is held back');
    assert.equal(line(paid).paymentMethod, 'bank_transfer');
    assert.equal(line(paid).bankDetails.ifscCode, 'SBIN0000001');
    assert.equal(line(upiOnly).amount, 250);
    assert.equal(line(upiOnly).paymentMethod, 'upi');
    assert.equal(line(noDetails), undefined);
    assert.ok(
        batch.skipped.some((s) => s.restaurantId === noDetails.id && s.amount === 700),
        'a restaurant that cannot be paid is listed, not dropped silently',
    );

    // Same day again, whether by the scheduler or an admin: refused.
    const again = await generateRestaurantPayouts({ now: RUN_AT, force: true });
    assert.equal(again.created, false);

    // The pending line already counts against the balance: only the held-back
    // 400 is left to ask for by hand.
    const summary = (await getWalletSummaries([paid.id])).get(paid.id);
    assert.equal(summary.netAvailable, 400);
    await assert.rejects(() => createWithdrawalRequest(paid.id, { amount: 401 }), /Insufficient balance/);
});

test('paying and cancelling lines moves the batch, and a cancelled line frees the money', async () => {
    const a = await makeRestaurant(bank);
    const b = await makeRestaurant(bank);
    await makeOrder(a, 600, daysBefore(4));
    await makeOrder(b, 300, daysBefore(4));

    const runAt = new Date(RUN_AT.getTime() + 24 * 60 * 60 * 1000);
    const { batch } = await generateRestaurantPayouts({ now: runAt, force: true });
    created.batches.push(batch.id);
    const { payouts } = await getPayoutBatch(batch.id);
    const lineA = payouts.find((p) => p.restaurantId === a.id);
    const lineB = payouts.find((p) => p.restaurantId === b.id);

    const paidOne = await decidePayouts(batch.id, { ids: [lineA.id], status: 'approved', transactionId: 'UTR-1' });
    assert.equal(paidOne.updated, 1);
    let current = (await getPayoutBatch(batch.id)).batch;
    assert.notEqual(current.status, 'pending');

    // Deciding it twice changes nothing and says so.
    const repeat = await decidePayouts(batch.id, { ids: [lineA.id], status: 'rejected' });
    assert.equal(repeat.updated, 0);
    assert.equal(repeat.notPending, 1);

    // Cancelled from the ordinary withdrawal list: the batch still follows, and
    // the 300 is back in the restaurant's balance.
    await updateWithdrawalStatus(lineB.id, { status: 'rejected', rejectionReason: 'Wrong IFSC' });
    assert.equal((await getWalletSummaries([b.id])).get(b.id).netAvailable, 300);

    const rest = (await getPayoutBatch(batch.id)).payouts.filter((p) => p.status === 'pending').map((p) => p.id);
    if (rest.length) await decidePayouts(batch.id, { ids: rest, status: 'approved' });
    current = (await getPayoutBatch(batch.id)).batch;
    assert.equal(current.status, 'partially_completed', 'paid and cancelled lines together');
});
