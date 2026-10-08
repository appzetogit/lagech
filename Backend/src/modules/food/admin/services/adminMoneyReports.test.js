import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../../config/prisma.js';
import { uniquePhone } from '../../../../utils/testIds.js';
import {
    foldRiderDisbursementTotals,
    getDisbursementReport,
    riderLineStatusFilter,
} from './adminMoneyReports.service.js';

/**
 * Disbursement Report -> Delivery men: one row per payout line a Delivery Man
 * Disbursement made, filtered by period, status and rider, with totals that
 * match the rows.
 */
const created = { partners: [], batches: [] };
const stamp = () => `${Date.now()}${Math.floor(performance.now() * 1000) % 1000}`;
const today = () => new Date().toLocaleDateString('en-CA');

test.after(async () => {
    await prisma.foodDeliveryWithdrawal.deleteMany({ where: { deliveryPartnerId: { in: created.partners } } });
    await prisma.foodDeliveryPayoutBatch.deleteMany({ where: { id: { in: created.batches } } });
    await prisma.foodDeliveryPartner.deleteMany({ where: { id: { in: created.partners } } });
    await prisma.$disconnect();
});

test('rider status filter and totals fold', () => {
    assert.equal(riderLineStatusFilter('paid'), 'approved');
    assert.equal(riderLineStatusFilter('failed'), 'rejected');
    assert.equal(riderLineStatusFilter('cancelled'), 'rejected');
    assert.equal(riderLineStatusFilter('pending'), 'pending');
    assert.equal(riderLineStatusFilter(''), null);
    assert.equal(riderLineStatusFilter('bogus'), null);

    const totals = foldRiderDisbursementTotals([
        { status: 'approved', amount: '100.50', count: 2 },
        { status: 'pending', amount: 40, count: 1 },
        { status: 'rejected', amount: 9.5, count: 1 },
    ]);
    assert.deepEqual(totals, { payouts: 4, total: 150, paid: 100.5, pending: 40, failed: 9.5, cancelled: 9.5 });
});

test('the Delivery men tab lists disbursement lines with filters and totals', async () => {
    const name = `Report Rider ${stamp()}`;
    const [a, b] = await Promise.all([
        prisma.foodDeliveryPartner.create({ data: { name: `${name} A`, phone: uniquePhone('7'), status: 'approved' } }),
        prisma.foodDeliveryPartner.create({ data: { name: `${name} B`, phone: uniquePhone('7'), status: 'approved' } }),
    ]);
    created.partners.push(a.id, b.id);
    const batch = await prisma.foodDeliveryPayoutBatch.create({ data: { totalAmount: 600, riderCount: 2 } });
    created.batches.push(batch.id);

    const line = (partner, amount, status, extra = {}) => prisma.foodDeliveryWithdrawal.create({
        data: {
            deliveryPartnerId: partner.id, amount, status, source: 'disbursement', batchId: batch.id,
            paymentMethod: 'upi', ...extra,
        },
    });
    const paid = await line(a, 250, 'approved', { transactionId: 'UTR-1', processedAt: new Date() });
    await line(b, 300, 'pending');
    await line(b, 50, 'rejected', { rejectionReason: 'Wrong UPI id' });
    // A rider's own request is not a disbursement.
    await prisma.foodDeliveryWithdrawal.create({
        data: { deliveryPartnerId: a.id, amount: 999, status: 'pending', source: 'manual' },
    });
    // Outside the period.
    await prisma.foodDeliveryWithdrawal.create({
        data: {
            deliveryPartnerId: a.id, amount: 77, status: 'approved', source: 'disbursement', batchId: batch.id,
            createdAt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
        },
    });

    const base = { entityType: 'rider', from: today(), to: today(), search: name };
    const all = await getDisbursementReport(base);
    assert.equal(all.entityType, 'rider');
    assert.equal(all.supported, true);
    assert.equal(all.rows.length, 3, 'manual request and older line left out');
    assert.deepEqual(all.totals, {
        payouts: 3, total: 600, paid: 250, pending: 300, failed: 50, cancelled: 50, riders: 2, batches: 1,
    });
    assert.equal(all.pagination.total, 3);
    const paidRow = all.rows.find((r) => r.id === paid.id);
    assert.equal(paidRow.status, 'paid');
    assert.equal(paidRow.deliveryName, `${name} A`);
    assert.equal(paidRow.paymentMethod, 'upi');
    assert.equal(paidRow.reference, 'UTR-1');
    assert.equal(paidRow.batchId, batch.id);
    assert.match(paidRow.batchTitle, /^Disbursement #\d+$/);
    assert.equal(all.batches.length, 1);
    assert.equal(all.batches[0].failed, 50);

    const failed = await getDisbursementReport({ ...base, status: 'failed' });
    assert.equal(failed.rows.length, 1);
    assert.equal(failed.rows[0].note, 'Wrong UPI id');
    assert.equal(failed.totals.total, 50);

    const onlyB = await getDisbursementReport({ ...base, search: undefined, deliveryPartnerId: b.id });
    assert.equal(onlyB.rows.length, 2);
    assert.equal(onlyB.totals.total, 350);
    assert.equal(onlyB.totals.riders, 1);

    const paged = await getDisbursementReport({ ...base, page: 2, limit: 2 });
    assert.equal(paged.rows.length, 1);
    assert.equal(paged.pagination.pages, 2);
    assert.equal(paged.totals.total, 600, 'totals cover every page');

    const old = await getDisbursementReport({ ...base, from: '2000-01-01', to: '2000-01-31' });
    assert.equal(old.rows.length, 0);
    assert.equal(old.totals.total, 0);
});
