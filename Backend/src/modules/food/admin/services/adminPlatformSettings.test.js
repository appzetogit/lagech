import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../../config/prisma.js';
import {
    getReferralSettings,
    upsertReferralSettings,
    getSafetyEmergencyReports,
    updateSafetyEmergencyStatus,
    updateSafetyEmergencyPriority,
    deleteSafetyEmergencyReport,
} from './adminPlatformSettings.service.js';
/**
 * Referral settings and the safety/emergency inbox.
 *
 * The fee-settings half of this service is tested in
 * orders/services/delivery-fee-bands.test.js instead: fee settings are a
 * singleton and the bands are a shared table, and node runs test files in
 * parallel, so the two suites have to live in the file that owns those rows.
 */
const live = Boolean(process.env.DATABASE_URL);

const created = { users: [], reports: [] };
const stamp = () => `${Date.now()}${Math.floor(performance.now() * 1000) % 1000}`;

test.after(async () => {
    if (!live) return;
    await prisma.foodSafetyEmergencyReport.deleteMany({ where: { id: { in: created.reports } } });
    await prisma.foodUser.deleteMany({ where: { id: { in: created.users } } });
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
