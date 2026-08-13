import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../../config/prisma.js';
import { loadActiveFeeSettings } from './order-pricing.service.js';

/**
 * Distance bands used to be a Json array, where nothing could stop an admin
 * saving overlapping or contradictory rules — and the only symptom was a
 * customer being charged the wrong delivery fee.
 *
 * These assert the database now refuses them. They need a real Postgres:
 * exclusion constraints and CHECKs are the thing under test, so a mock would
 * assert nothing.
 */
const live = Boolean(process.env.DATABASE_URL);

let settingsId;

const band = (over) => ({
    feeSettingsId: settingsId,
    minDistanceKm: 0,
    maxDistanceKm: 3,
    fee: 20,
    ...over,
});

test.before(async () => {
    if (!live) return;
    const settings = await prisma.foodFeeSettings.create({
        data: { deliveryFee: 99, platformFee: 10, gstRate: 5, isActive: false },
    });
    settingsId = settings.id;
});

test.after(async () => {
    if (!live) return;
    if (settingsId) await prisma.foodFeeSettings.delete({ where: { id: settingsId } }).catch(() => {});
    await prisma.$disconnect();
});

test('bands that sit flush are accepted', { skip: !live }, async () => {
    await prisma.deliveryFeeBand.create({ data: band({ deliveryBoyBasePay: 15 }) });
    await prisma.deliveryFeeBand.create({
        data: band({ minDistanceKm: 3, maxDistanceKm: 7, fee: 40, deliveryBoyPerKm: 8 }),
    });

    const count = await prisma.deliveryFeeBand.count({ where: { feeSettingsId: settingsId } });
    assert.equal(count, 2);
});

test('an overlapping band is rejected by the database', { skip: !live }, async () => {
    // [5,9) overlaps the existing [3,7). Both would match a 6 km trip, and which
    // one priced it came down to array order.
    await assert.rejects(
        () => prisma.deliveryFeeBand.create({ data: band({ minDistanceKm: 5, maxDistanceKm: 9, fee: 70 }) }),
        /delivery_fee_band_no_overlap/,
    );
});

test('basePay and perKm cannot both be set', { skip: !live }, async () => {
    // calculateRiderEarning treats a non-zero basePay as the winner, so a row
    // carrying both has one value that silently does nothing.
    await assert.rejects(
        () => prisma.deliveryFeeBand.create({
            data: band({ minDistanceKm: 7, maxDistanceKm: 12, deliveryBoyBasePay: 15, deliveryBoyPerKm: 10 }),
        }),
        /delivery_fee_band_pay_exclusive/,
    );
});

test('an inverted range is rejected', { skip: !live }, async () => {
    await assert.rejects(
        () => prisma.deliveryFeeBand.create({ data: band({ minDistanceKm: 12, maxDistanceKm: 8 }) }),
        /delivery_fee_band_range_valid/,
    );
});

test('a negative fee is rejected', { skip: !live }, async () => {
    await assert.rejects(
        () => prisma.deliveryFeeBand.create({ data: band({ minDistanceKm: 20, maxDistanceKm: 25, fee: -1 }) }),
        /delivery_fee_band_amounts_non_negative/,
    );
});

test('loadActiveFeeSettings still returns the legacy deliveryFeeRanges shape', { skip: !live }, async () => {
    // The pricing functions read bands as feeSettings.deliveryFeeRanges. Storage
    // was normalised; that contract must not have moved.
    await prisma.foodFeeSettings.update({ where: { id: settingsId }, data: { isActive: true } });

    const settings = await loadActiveFeeSettings();
    const ranges = settings.deliveryFeeRanges;

    assert.ok(Array.isArray(ranges));
    assert.equal(ranges.length, 2);
    // Ordered by lower bound, so matchFeeRange's "last band is widest" holds.
    assert.deepEqual(ranges.map((r) => r.min), [0, 3]);
    assert.equal(ranges[0].fee, 20);
    assert.equal(ranges[0].deliveryBoyBasePay, 15);
    assert.equal(ranges[1].deliveryBoyPerKm, 8);

    await prisma.foodFeeSettings.update({ where: { id: settingsId }, data: { isActive: false } });
});

test('deleting the settings row cascades to its bands', { skip: !live }, async () => {
    const throwaway = await prisma.foodFeeSettings.create({ data: { isActive: false } });
    await prisma.deliveryFeeBand.create({
        data: { feeSettingsId: throwaway.id, minDistanceKm: 0, maxDistanceKm: 5, fee: 30 },
    });

    await prisma.foodFeeSettings.delete({ where: { id: throwaway.id } });

    const orphans = await prisma.deliveryFeeBand.count({ where: { feeSettingsId: throwaway.id } });
    assert.equal(orphans, 0);
});
