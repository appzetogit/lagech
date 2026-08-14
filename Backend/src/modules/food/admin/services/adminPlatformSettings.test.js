import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../../config/prisma.js';
import {
    getFeeSettings,
    upsertFeeSettings,
    getReferralSettings,
    upsertReferralSettings,
    getSafetyEmergencyReports,
    updateSafetyEmergencyStatus,
    updateSafetyEmergencyPriority,
    deleteSafetyEmergencyReport,
} from './adminPlatformSettings.service.js';
import { loadActiveFeeSettings } from '../../orders/services/order-pricing.service.js';

/**
 * Fee, referral and safety settings.
 *
 * The fee bands carry the weight here: they were a Json array and are a table
 * with an EXCLUDE constraint now, so saving them is a replace of child rows.
 * Pricing reads them through loadActiveFeeSettings, so one test goes end to end
 * to prove the two agree.
 */
const live = Boolean(process.env.DATABASE_URL);

const created = { users: [], reports: [] };
const stamp = () => `${Date.now()}${Math.floor(performance.now() * 1000) % 1000}`;

// Fee and referral settings are singletons, so tests share and restore them.
let feeSnapshot = null;

test.before(async () => {
    if (!live) return;
    feeSnapshot = await prisma.foodFeeSettings.findFirst({ orderBy: { createdAt: 'desc' } });
});

test.after(async () => {
    if (!live) return;
    await prisma.foodSafetyEmergencyReport.deleteMany({ where: { id: { in: created.reports } } });
    await prisma.foodUser.deleteMany({ where: { id: { in: created.users } } });
    if (!feeSnapshot) {
        await prisma.deliveryFeeBand.deleteMany({});
        await prisma.foodFeeSettings.deleteMany({});
    }
    await prisma.$disconnect();
});

const makeReport = async (data = {}) => {
    const user = await prisma.foodUser.create({
        data: { phone: `8${String(Date.now()).slice(-9)}${created.users.length}` },
    });
    created.users.push(user.id);

    const report = await prisma.foodSafetyEmergencyReport.create({
        data: {
            userId: user.id,
            userName: 'Reporter',
            userEmail: 'reporter@test.local',
            message: 'Something happened',
            ...data,
        },
    });
    created.reports.push(report.id);
    return report;
};

test('fee settings read back as null until configured', { skip: !live }, async () => {
    await prisma.deliveryFeeBand.deleteMany({});
    await prisma.foodFeeSettings.deleteMany({});

    const { feeSettings } = await getFeeSettings();
    // Null, not defaults: the screen must not imply a fee is set when none is.
    assert.equal(feeSettings, null);
});

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

    // They really are rows now, not a column.
    const bands = await prisma.deliveryFeeBand.findMany();
    assert.equal(bands.length, 2);

    // And pricing sees exactly the same ladder.
    const forPricing = await loadActiveFeeSettings();
    assert.equal(forPricing.deliveryFeeRanges.length, 2);
    assert.equal(forPricing.deliveryFeeRanges[1].deliveryBoyPerKm, 6);
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

    // Explicit null means the fee is not charged at all — different from a
    // request that simply did not mention it.
    const cleared = await upsertFeeSettings({ quickDeliveryFee: null });
    assert.equal(cleared.quickDeliveryFee, null);
    assert.equal(cleared.gstRate, 18, 'an unmentioned fee is untouched');
});

test('overlapping bands are refused by the database', { skip: !live }, async () => {
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

    // The failed save is rolled back whole, so the previous ladder survives.
    const { feeSettings } = await getFeeSettings();
    assert.ok(feeSettings.deliveryFeeRanges.length > 0);
    assert.ok(
        !feeSettings.deliveryFeeRanges.some((r) => r.min === 3 && r.max === 9),
        'no half-applied band from the rejected save',
    );
});

test('a band cannot set both a base pay and a per-km rate', { skip: !live }, async () => {
    await assert.rejects(
        () => upsertFeeSettings({
            deliveryFeeRanges: [
                { min: 0, max: 5, fee: 20, deliveryBoyBasePay: 30, deliveryBoyPerKm: 6 },
            ],
        }),
        /base pay or a per-km rate, not both/,
        'the two are mutually exclusive; the CHECK says so, not just the UI',
    );
});

test('referral settings create then update one row', { skip: !live }, async () => {
    const first = await upsertReferralSettings({ referralRewardUser: 50, referralLimitUser: 5 });
    assert.equal(first.referralRewardUser, 50);

    const second = await upsertReferralSettings({ referralRewardDelivery: 75 });
    assert.equal(second.id, first.id, 'edited in place, not accumulated');
    assert.equal(second.referralRewardUser, 50, 'an unrelated edit does not reset the reward');
    assert.equal(second.referralRewardDelivery, 75);

    const { referralSettings } = await getReferralSettings();
    assert.equal(referralSettings.id, first.id);

    const count = await prisma.foodReferralSettings.count({ where: { isActive: true } });
    assert.equal(count, 1, 'editing settings must not accumulate rows');
});

test('a negative referral reward is clamped to zero', { skip: !live }, async () => {
    const saved = await upsertReferralSettings({ referralRewardUser: -100, referralLimitUser: -3 });
    assert.equal(saved.referralRewardUser, 0, 'a referral cannot cost the user money');
    assert.equal(saved.referralLimitUser, 0);
});

test('safety reports filter by status, priority and text', { skip: !live }, async () => {
    const unique = `Urgent${stamp()}`;
    const urgent = await makeReport({ status: 'urgent', priority: 'critical', userName: unique });
    await makeReport({ status: 'read', priority: 'low' });

    const byStatus = await getSafetyEmergencyReports({ status: 'urgent' });
    assert.ok(byStatus.safetyEmergencies.some((r) => r.id === urgent.id));

    const byPriority = await getSafetyEmergencyReports({ priority: 'critical' });
    assert.ok(byPriority.safetyEmergencies.some((r) => r.id === urgent.id));

    const bySearch = await getSafetyEmergencyReports({ search: unique });
    assert.equal(bySearch.safetyEmergencies.length, 1);
    assert.equal(bySearch.pagination.total, 1);

    // An unrecognised status is ignored rather than matching nothing.
    const bogus = await getSafetyEmergencyReports({ status: 'not-a-status' });
    assert.ok(bogus.pagination.total >= 2);
});

test('a safety report changes status and priority, and deletes', { skip: !live }, async () => {
    const report = await makeReport();

    assert.equal((await updateSafetyEmergencyStatus(report.id, 'resolved')).status, 'resolved');
    assert.equal((await updateSafetyEmergencyPriority(report.id, 'high')).priority, 'high');

    await assert.rejects(() => updateSafetyEmergencyStatus(report.id, 'nonsense'), /Invalid status/);
    await assert.rejects(() => updateSafetyEmergencyPriority(report.id, 'nonsense'), /Invalid priority/);
    await assert.rejects(() => updateSafetyEmergencyStatus('bad-id', 'read'), /Invalid report id/);

    assert.equal((await deleteSafetyEmergencyReport(report.id)).id, report.id);
    // Deleting one that has already gone is null, not a thrown P2025.
    assert.equal(await deleteSafetyEmergencyReport(report.id), null);
    assert.equal(await updateSafetyEmergencyStatus(report.id, 'read'), null);

    created.reports = created.reports.filter((id) => id !== report.id);
});
