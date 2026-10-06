import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../../config/prisma.js';
import { uniquePhone } from '../../../../utils/testIds.js';
import { testPatch } from '../../../../utils/testGeo.js';
import {
    createRiderByAdmin,
    createVehicleCategory,
    decideRiderPayouts,
    deleteVehicleCategory,
    generateRiderDisbursement,
    getRiderDisbursement,
    listRiderPayments,
    listVehicleCategories,
    recordRiderPayment,
    updateVehicleCategory,
} from './adminRiderExtras.service.js';
import { loadRiderBalances } from './adminRiderBalance.service.js';

/**
 * Delivery man payouts must take money off the balance the rider withdraws
 * from, exactly once, whichever admin screen pays them.
 */
const created = { partners: [], zones: [], vehicles: [], batches: [] };
const stamp = () => `${Date.now()}${Math.floor(performance.now() * 1000) % 1000}`;

/** A rider whose ledger holds `balance` of earnings, so it is all withdrawable. */
const makeRider = async (balance, extra = {}) => {
    const partner = await prisma.foodDeliveryPartner.create({
        data: { name: `Payout Test Rider ${stamp()}`, phone: uniquePhone('7'), status: 'approved', ...extra },
    });
    created.partners.push(partner.id);
    if (balance > 0) {
        await prisma.wallet.create({
            data: { entityType: 'deliveryBoy', entityId: partner.id, balance, totalEarnings: balance },
        });
    }
    return partner;
};

const available = async (id) => (await loadRiderBalances([id])).get(id).available;

test.after(async () => {
    const partnerIds = created.partners;
    await prisma.foodDeliveryWithdrawal.deleteMany({ where: { deliveryPartnerId: { in: partnerIds } } });
    await prisma.foodDeliveryPayoutBatch.deleteMany({ where: { id: { in: created.batches } } });
    await prisma.transaction.deleteMany({ where: { entityType: 'deliveryBoy', entityId: { in: partnerIds } } });
    await prisma.wallet.deleteMany({ where: { entityType: 'deliveryBoy', entityId: { in: partnerIds } } });
    await prisma.foodDeliveryPartner.deleteMany({ where: { id: { in: partnerIds } } });
    await prisma.foodDeliveryVehicleCategory.deleteMany({ where: { id: { in: created.vehicles } } });
    await prisma.foodZone.deleteMany({ where: { id: { in: created.zones } } });
    await prisma.$disconnect();
});

test('vehicle categories: create, reject a duplicate type, edit, delete', async () => {
    const type = `Bike ${stamp()}`;
    const { category } = await createVehicleCategory({ type, startingCoverageKm: 0, maxCoverageKm: 10, extraCharges: 5 });
    created.vehicles.push(category.id);
    assert.equal(category.maxCoverageKm, 10);
    assert.equal(category.isActive, true);

    await assert.rejects(() => createVehicleCategory({ type: type.toUpperCase(), maxCoverageKm: 5 }), /already exists/);
    await assert.rejects(
        () => createVehicleCategory({ type: `Bad ${stamp()}`, startingCoverageKm: 8, maxCoverageKm: 4 }),
        /at least the starting/,
    );

    const { category: off } = await updateVehicleCategory(category.id, { isActive: false });
    assert.equal(off.isActive, false);
    assert.equal(off.maxCoverageKm, 10, 'fields not sent keep their value');

    const { categories } = await listVehicleCategories({ search: type });
    assert.equal(categories.length, 1);

    await deleteVehicleCategory(category.id);
    await assert.rejects(() => deleteVehicleCategory(category.id), /not found/);
});

test('an admin-added rider is approved, and the phone stays unique', async () => {
    const zone = await prisma.foodZone.create({ data: { name: `Rider Zone ${stamp()}`, coordinates: testPatch(7).ring } });
    created.zones.push(zone.id);
    const { category } = await createVehicleCategory({ type: `Scooter ${stamp()}`, maxCoverageKm: 8 });
    created.vehicles.push(category.id);

    const phone = uniquePhone('8');
    const rider = await createRiderByAdmin({
        name: 'Added Rider', phone: `+91 ${phone}`, zoneId: zone.id, vehicleType: category.type.toLowerCase(),
    });
    created.partners.push(rider.id);
    assert.equal(rider.status, 'approved');
    assert.equal(rider.phone, phone, 'stored as ten digits, as riders log in');
    assert.equal(rider.vehicleType, category.type, 'stored with the category spelling');
    assert.equal(rider.zoneId, zone.id);

    await assert.rejects(
        () => createRiderByAdmin({ name: 'Again', phone, zoneId: zone.id, vehicleType: category.type }),
        /already exists/,
    );
    await assert.rejects(
        () => createRiderByAdmin({ name: 'No vehicle', phone: uniquePhone('8'), zoneId: zone.id, vehicleType: 'Rocket' }),
        /Vehicles Category/,
    );
});

test('a recorded payment lowers the balance, and cannot overpay', async () => {
    const rider = await makeRider(500);
    const { payment, remainingBalance } = await recordRiderPayment({
        deliveryPartnerId: rider.id, amount: 300, method: 'upi', reference: 'UTR-77', note: 'Weekly pay',
    });
    assert.equal(payment.amount, 300);
    assert.equal(payment.source, 'admin_payment');
    assert.equal(remainingBalance, 200);
    assert.equal(await available(rider.id), 200);

    await assert.rejects(
        () => recordRiderPayment({ deliveryPartnerId: rider.id, amount: 250, method: 'cash' }),
        /at most/,
    );

    const wallet = await prisma.wallet.findUnique({
        where: { entityType_entityId: { entityType: 'deliveryBoy', entityId: rider.id } },
    });
    assert.equal(Number(wallet.balance), 200, 'the ledger was debited');

    const { payments } = await listRiderPayments({ deliveryPartnerId: rider.id });
    assert.equal(payments.length, 1);
    assert.equal(payments[0].reference, 'UTR-77');
});

test('two payments of the whole balance at once pay it once', async () => {
    const rider = await makeRider(400);
    const results = await Promise.allSettled([
        recordRiderPayment({ deliveryPartnerId: rider.id, amount: 400, method: 'cash' }),
        recordRiderPayment({ deliveryPartnerId: rider.id, amount: 400, method: 'cash' }),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(await available(rider.id), 0);
});

test('a disbursement pays each rider their balance once; paid debits, failed gives it back', async () => {
    const paid = await makeRider(700, { bankAccountNumber: '12345678', bankIfscCode: 'SBIN0001234' });
    const failed = await makeRider(300, { upiId: 'rider@upi' });
    const noDetails = await makeRider(250);

    const first = await generateRiderDisbursement({ minAmount: 1 });
    assert.equal(first.created, true);
    created.batches.push(first.batch.id);

    const { payouts, batch } = await getRiderDisbursement(first.batch.id);
    const lineOf = (id) => payouts.find((p) => p.deliveryPartnerId === id);
    assert.equal(lineOf(paid.id).amount, 700);
    assert.equal(lineOf(paid.id).paymentMethod, 'bank_transfer');
    assert.equal(lineOf(failed.id).paymentMethod, 'upi');
    assert.equal(lineOf(noDetails.id), undefined);
    assert.ok(batch.skipped.some((s) => s.deliveryPartnerId === noDetails.id));

    // Pending lines already count against the balance: nothing left to pay twice.
    assert.equal(await available(paid.id), 0);
    const second = await generateRiderDisbursement({ minAmount: 1 });
    if (second.batch) {
        created.batches.push(second.batch.id);
        const again = await getRiderDisbursement(second.batch.id);
        assert.equal(again.payouts.find((p) => p.deliveryPartnerId === paid.id), undefined);
    }

    const r1 = await decideRiderPayouts(first.batch.id, { ids: [lineOf(paid.id).id], status: 'paid', reference: 'UTR-1' });
    assert.equal(r1.updated, 1, JSON.stringify(r1));
    const r2 = await decideRiderPayouts(first.batch.id, { ids: [lineOf(paid.id).id], status: 'paid' });
    assert.equal(r2.updated, 0, 'a paid line is not paid again');
    assert.equal(r2.notPending, 1);

    await decideRiderPayouts(first.batch.id, { ids: [lineOf(failed.id).id], status: 'failed', note: 'UPI id closed' });
    assert.equal(await available(failed.id), 300, 'a failed line gives the money back');

    const wallet = await prisma.wallet.findUnique({
        where: { entityType_entityId: { entityType: 'deliveryBoy', entityId: paid.id } },
    });
    assert.equal(Number(wallet.balance), 0);
    assert.equal(Number(wallet.lockedAmount), 0);
});
