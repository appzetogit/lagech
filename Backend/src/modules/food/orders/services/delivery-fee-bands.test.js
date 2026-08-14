import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../../config/prisma.js';
import { loadActiveFeeSettings } from './order-pricing.service.js';
import {
    getFeeSettings,
    upsertFeeSettings,
} from '../../admin/services/adminPlatformSettings.service.js';

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

/**
 * The admin-facing half of the same tables.
 *
 * These live here rather than beside the rest of the admin settings tests: fee
 * settings are a singleton and upsertFeeSettings edits "the newest row", so a
 * suite in another file writing its own row would make both flaky. One file
 * owns these tables.
 */

test('saving fees stores bands as rows and reads them back nested', { skip: !live }, async () => {
    const saved = await upsertFeeSettings({
        platformFee: 5,
        gstRate: 18,
        deliveryFeeRanges: [
            { min: 0, max: 3, fee: 20, deliveryBoyBasePay: 30, deliveryBoyPerKm: 0 },
            { min: 3, max: 8, fee: 40, deliveryBoyBasePay: 0, deliveryBoyPerKm: 6 },
        ],
    });

    assert.equal(saved.platformFee, 5, 'Decimal converted for the client');
    assert.equal(saved.deliveryFeeRanges.length, 2);
    assert.equal(saved.deliveryFeeRanges[0].fee, 20);

    // They really are rows now, not a column on the settings document.
    const bands = await prisma.deliveryFeeBand.count({ where: { feeSettingsId: saved.id } });
    assert.equal(bands, 2);
});

test('an unrelated edit leaves the bands alone', { skip: !live }, async () => {
    const before = (await getFeeSettings()).feeSettings.deliveryFeeRanges.length;
    assert.ok(before > 0);

    // deliveryFeeRanges is absent, which means "do not touch", not "clear".
    const saved = await upsertFeeSettings({ platformFee: 7 });
    assert.equal(saved.platformFee, 7);
    assert.equal(saved.deliveryFeeRanges.length, before);
});

test('null clears a fee, absent leaves it', { skip: !live }, async () => {
    await upsertFeeSettings({ quickDeliveryFee: 15, gstRate: 18 });
    assert.equal((await getFeeSettings()).feeSettings.quickDeliveryFee, 15);

    // An explicit null means the fee is not charged at all — different from a
    // request that simply did not mention it.
    const cleared = await upsertFeeSettings({ quickDeliveryFee: null });
    assert.equal(cleared.quickDeliveryFee, null);
    assert.equal(cleared.gstRate, 18, 'an unmentioned fee is untouched');
});

test('a rejected band save leaves the previous ladder intact', { skip: !live }, async () => {
    const before = (await getFeeSettings()).feeSettings.deliveryFeeRanges;

    await assert.rejects(
        () => upsertFeeSettings({
            deliveryFeeRanges: [
                { min: 0, max: 5, fee: 20, deliveryBoyBasePay: 30 },
                { min: 3, max: 9, fee: 40, deliveryBoyPerKm: 6 },
            ],
        }),
        /must not overlap/,
        'two bands covering 4km would price the same trip two ways',
    );

    // The save is one transaction, so a refused band rolls the whole thing back.
    const after = (await getFeeSettings()).feeSettings.deliveryFeeRanges;
    assert.deepEqual(after.map((r) => r.min), before.map((r) => r.min));
    assert.ok(!after.some((r) => r.min === 3 && r.max === 9), 'no half-applied band');
});

test('a band setting both pay types is refused with a usable message', { skip: !live }, async () => {
    await assert.rejects(
        () => upsertFeeSettings({
            deliveryFeeRanges: [
                { min: 0, max: 5, fee: 20, deliveryBoyBasePay: 30, deliveryBoyPerKm: 6 },
            ],
        }),
        /base pay or a per-km rate, not both/,
        'the CHECK says so; the admin needs a sentence, not a constraint name',
    );
});
