import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../../config/prisma.js';
import { getActiveCashbackSettings, upsertCashbackSettings } from './cashback.service.js';

/**
 * The admin panel's cashback rules. These decide real money paid to customers,
 * so a partial form post must not zero the fields it did not send.
 */
const live = Boolean(process.env.DATABASE_URL);

let snapshot = null;

test.before(async () => {
    if (!live) return;
    snapshot = await prisma.foodCashbackSettings.findFirst({
        where: { isActive: true },
        orderBy: { createdAt: 'desc' },
    });
});

test.after(async () => {
    if (!live) return;
    if (snapshot) {
        const { id, _id, createdAt, updatedAt, ...values } = snapshot;
        // Restored by id, not updated by it: these tables hold one row, and a
        // test that deletes it makes the service create a replacement with a
        // new id — so an update keyed on the old id finds nothing.
        await prisma.foodCashbackSettings.deleteMany({});
        await prisma.foodCashbackSettings.create({ data: { id, ...values } });
    } else {
        await prisma.foodCashbackSettings.deleteMany({});
    }
    await prisma.$disconnect();
});

test('with nothing saved the reader hands back safe defaults', { skip: !live }, async () => {
    await prisma.foodCashbackSettings.deleteMany({});
    const settings = await getActiveCashbackSettings();
    assert.equal(settings.isEnabled, false, 'cashback is off until someone turns it on');
    assert.equal(settings.cashbackValue, 0);
});

test('an edit touches only the keys that were sent', { skip: !live }, async () => {
    await upsertCashbackSettings({
        isEnabled: true,
        cashbackType: 'percentage',
        cashbackValue: 10,
        minOrderValue: 199,
        maxCashback: 50,
        perUserLimit: 3,
    });

    // The toggle screen posts only isEnabled. The rates have to survive it.
    const after = await upsertCashbackSettings({ isEnabled: false });
    assert.equal(after.isEnabled, false);
    assert.equal(Number(after.cashbackValue), 10);
    assert.equal(Number(after.minOrderValue), 199);
    assert.equal(after.perUserLimit, 3);
});

test('negative amounts are clamped and an unknown type falls back', { skip: !live }, async () => {
    const saved = await upsertCashbackSettings({
        cashbackValue: -5,
        maxCashback: -100,
        perUserLimit: -1,
        cashbackType: 'buy-one-get-one',
    });

    // A negative cashback would debit the customer.
    assert.equal(Number(saved.cashbackValue), 0);
    assert.equal(Number(saved.maxCashback), 0);
    assert.equal(saved.perUserLimit, 0);
    assert.equal(saved.cashbackType, 'percentage');

    assert.equal((await upsertCashbackSettings({ cashbackType: 'flat' })).cashbackType, 'flat');
});

test('the second save updates the row rather than adding another', { skip: !live }, async () => {
    await prisma.foodCashbackSettings.deleteMany({});
    await upsertCashbackSettings({ isEnabled: true });
    await upsertCashbackSettings({ isEnabled: false });

    assert.equal(await prisma.foodCashbackSettings.count(), 1);
});
