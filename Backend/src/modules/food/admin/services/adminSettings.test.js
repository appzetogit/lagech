import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../../config/prisma.js';
import {
    getDeliveryCashLimitSettings,
    upsertDeliveryCashLimitSettings,
    getDeliveryEmergencyHelp,
    upsertDeliveryEmergencyHelp,
    addDeliveryPartnerBonus,
} from './adminSettings.service.js';
import { isFeatureEnabled, listFeatureSettings, updateFeatureSetting, FEATURE_KEYS } from './featureSettings.service.js';
import { deleteDeliveryPartnerAccount } from '../../delivery/services/delivery.service.js';
import { uniquePhone } from '../../../../utils/testIds.js';

/**
 * Platform settings, extracted out of the 6,453-line admin.service.js because
 * four already-migrated modules read them. The bonus path is the interesting
 * one: it used to increment the wallet balance directly.
 */
const created = { partners: [], settings: [], emergency: [] };

test.after(async () => {
    // Through the service, not a bare deleteMany: seven tables reference a
    // partner with ON DELETE RESTRICT, so a plain delete fails.
    for (const id of created.partners) {
        await deleteDeliveryPartnerAccount(id).catch(() => {});
    }
    await prisma.foodDeliveryCashLimit.deleteMany({ where: { id: { in: created.settings } } });
    await prisma.foodDeliveryEmergencyHelp.deleteMany({ where: { id: { in: created.emergency } } });
    await prisma.$disconnect();
});

test('cash limits fall back to sane defaults when unconfigured', async () => {
    await prisma.foodDeliveryCashLimit.updateMany({ where: {}, data: { isActive: false } });

    const settings = await getDeliveryCashLimitSettings();
    assert.equal(settings.deliveryCashLimit, 0, '0 means no limit');
    assert.equal(settings.deliveryWithdrawalLimit, 100);
});

test('saving cash limits creates then updates one row', async () => {
    const first = await upsertDeliveryCashLimitSettings({ deliveryCashLimit: 3000 });
    assert.equal(first.deliveryCashLimit, 3000);
    // The unspecified field keeps its default rather than being zeroed.
    assert.equal(first.deliveryWithdrawalLimit, 100);

    const row = await prisma.foodDeliveryCashLimit.findFirst({ where: { isActive: true } });
    created.settings.push(row.id);

    const second = await upsertDeliveryCashLimitSettings({ deliveryWithdrawalLimit: 250 });
    assert.equal(second.deliveryCashLimit, 3000, 'an unrelated edit must not reset the cash limit');
    assert.equal(second.deliveryWithdrawalLimit, 250);

    const count = await prisma.foodDeliveryCashLimit.count({ where: { isActive: true } });
    assert.equal(count, 1, 'editing settings must not accumulate rows');
});

test('a negative cash limit is clamped to zero', async () => {
    const saved = await upsertDeliveryCashLimitSettings({ deliveryCashLimit: -500 });
    assert.equal(saved.deliveryCashLimit, 0);
    await upsertDeliveryCashLimitSettings({ deliveryCashLimit: 3000 });
});

test('emergency numbers fall back to the Indian defaults', async () => {
    await prisma.foodDeliveryEmergencyHelp.updateMany({ where: {}, data: { isActive: false } });

    const help = await getDeliveryEmergencyHelp();
    assert.equal(help.medicalEmergency, '102');
    assert.equal(help.accidentHelpline, '108');
    assert.equal(help.contactPolice, '100');
});

test('a configured emergency number replaces the default', async () => {
    await upsertDeliveryEmergencyHelp({ contactPolice: '1091' });
    const row = await prisma.foodDeliveryEmergencyHelp.findFirst({ where: { isActive: true } });
    created.emergency.push(row.id);

    const help = await getDeliveryEmergencyHelp();
    assert.equal(help.contactPolice, '1091');
    // Unset fields still fall back rather than going blank.
    assert.equal(help.medicalEmergency, '102');
});

test('an admin bonus goes through the ledger, not a direct balance write', async () => {
    const partner = await prisma.foodDeliveryPartner.create({
        data: { name: 'Bonus Rider', phone: uniquePhone('7'), status: 'approved' },
    });
    created.partners.push(partner.id);

    const bonus = await addDeliveryPartnerBonus(
        { deliveryPartnerId: partner.id, amount: 250, reference: 'Weekend push' },
        null,
    );
    assert.ok(bonus.transactionId.startsWith('BON-'));

    // The credit must be visible in transaction history — a direct $inc left it
    // invisible there, so a rider saw the balance move with nothing explaining it.
    const ledger = await prisma.transaction.findMany({
        where: { entityType: 'deliveryBoy', entityId: partner.id },
    });
    assert.equal(ledger.length, 1);
    assert.equal(Number(ledger[0].amount), 250);
    assert.equal(ledger[0].type, 'credit');

    const wallet = await prisma.wallet.findUnique({
        where: { entityType_entityId: { entityType: 'deliveryBoy', entityId: partner.id } },
    });
    assert.equal(Number(wallet.balance), 250);
    assert.equal(Number(wallet.totalBonus), 250, 'lifetime bonus counter tracks alongside the ledger');
});

test('a bonus is refused for an unapproved partner', async () => {
    const pending = await prisma.foodDeliveryPartner.create({
        data: { name: 'Pending Rider', phone: uniquePhone('6'), status: 'pending' },
    });
    created.partners.push(pending.id);

    await assert.rejects(
        () => addDeliveryPartnerBonus({ deliveryPartnerId: pending.id, amount: 100 }, null),
        /must be approved/,
    );
});

test('a zero or negative bonus is refused', async () => {
    const [partnerId] = created.partners;
    await assert.rejects(
        () => addDeliveryPartnerBonus({ deliveryPartnerId: partnerId, amount: 0 }, null),
        /greater than 0/,
    );
});

test('feature flags default to on and survive being switched off', async () => {
    const list = await listFeatureSettings();
    assert.ok(list.length >= 4, 'the defaults are seeded on first read');
    assert.equal(await isFeatureEnabled(FEATURE_KEYS.RESTAURANT_SUBSCRIPTION), true);

    await updateFeatureSetting(FEATURE_KEYS.RESTAURANT_SUBSCRIPTION, { isEnabled: false });
    assert.equal(await isFeatureEnabled(FEATURE_KEYS.RESTAURANT_SUBSCRIPTION), false);

    // isFeatureEnabled re-seeds defaults on every call; that must not flip an
    // admin's choice back on.
    assert.equal(await isFeatureEnabled(FEATURE_KEYS.RESTAURANT_SUBSCRIPTION), false);

    await updateFeatureSetting(FEATURE_KEYS.RESTAURANT_SUBSCRIPTION, { isEnabled: true });
});

test('an unknown feature key returns the caller fallback', async () => {
    assert.equal(await isFeatureEnabled('no_such_flag', true), true);
    assert.equal(await isFeatureEnabled('no_such_flag', false), false);
    assert.equal(await updateFeatureSetting('no_such_flag', { isEnabled: true }), null);
});
