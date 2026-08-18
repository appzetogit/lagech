import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../../config/prisma.js';
import * as settings from './businessSettings.service.js';

/**
 * The platform's own identity row. It is a singleton, so every test here shares
 * one row and restores it afterwards.
 */
let snapshot = null;

test.before(async () => {
    snapshot = await prisma.foodBusinessSettings.findFirst();
});

test.after(async () => {
    if (snapshot) {
        const { id, _id, createdAt, updatedAt, ...values } = snapshot;
        // Restored by id, not updated by it: these tables hold one row, and a
        // test that deletes it makes the service create a replacement with a
        // new id — so an update keyed on the old id finds nothing.
        await prisma.foodBusinessSettings.deleteMany({});
        await prisma.foodBusinessSettings.create({ data: { id, ...values } });
    } else {
        await prisma.foodBusinessSettings.deleteMany({});
    }
    await prisma.$disconnect();
});

const valid = {
    companyName: 'Switcheats',
    email: 'admin@switcheats.com',
    phoneNumber: '9876543210',
};

test('the row is created on first read, with usable defaults', async () => {
    await prisma.foodBusinessSettings.deleteMany({});

    const first = await settings.getBusinessSettings();
    assert.equal(first.companyName, 'Switcheats');
    assert.equal(first.orderAcceptanceTimeMinutes, 4);
    // Every app has a theme from the start. The Mongo version stored this as a
    // sub-document and had to repair rows that predated it.
    assert.equal(first.powerScanning.user.themeColor, '#FA0272');
    assert.equal(first.powerScanning.delivery.fontFamily, 'Poppins');
    // The flat columns are rebuilt into the shape the panel reads.
    assert.deepEqual(first.phone, { countryCode: '+91', number: '' });
    assert.deepEqual(first.logo, { url: '', publicId: '' });

    // And reading again does not add a second row.
    await settings.getBusinessSettings();
    assert.equal(await prisma.foodBusinessSettings.count(), 1);
});

test('a theme edit keeps what it did not mention', async () => {
    await settings.updatePowerScanningSettings({
        user: { themeColor: '#ff0000', fontFamily: 'Inter' },
        restaurant: { themeColor: '#00FF00', fontFamily: 'Roboto' },
    });

    const after = await settings.updatePowerScanningSettings({ user: { themeColor: '#0000ff' } });

    assert.equal(after.user.themeColor, '#0000FF', 'normalised to upper case');
    // Sending only the colour must not blank the font.
    assert.equal(after.user.fontFamily, 'Inter');
    // And another app's branding is untouched entirely.
    assert.equal(after.restaurant.themeColor, '#00FF00');
    assert.equal(after.restaurant.fontFamily, 'Roboto');
});

test('an unusable colour or font falls back instead of being stored', async () => {
    await settings.updatePowerScanningSettings({ delivery: { themeColor: '#123456', fontFamily: 'Lato' } });

    const after = await settings.updatePowerScanningSettings({
        delivery: { themeColor: 'not-a-colour', fontFamily: 'Comic Sans' },
    });
    assert.equal(after.delivery.themeColor, '#123456');
    assert.equal(after.delivery.fontFamily, 'Lato');

    // A bare hex without the hash is accepted.
    const bare = await settings.updatePowerScanningSettings({ delivery: { themeColor: 'abcdef' } });
    assert.equal(bare.delivery.themeColor, '#ABCDEF');
});

test('the acceptance window is bounded', async () => {
    const saved = await settings.updateOrderAcceptanceSettings('7');
    assert.equal(saved.orderAcceptanceTimeMinutes, 7);
    assert.equal(saved.acceptanceWindowSeconds, 420);
    assert.deepEqual(await settings.getOrderAcceptanceSettings(), saved);

    // A restaurant needs at least a minute, and an order cannot sit unanswered
    // for a third of an hour.
    await assert.rejects(() => settings.updateOrderAcceptanceSettings(0), /between 1 and 20/);
    await assert.rejects(() => settings.updateOrderAcceptanceSettings(21), /between 1 and 20/);
    await assert.rejects(() => settings.updateOrderAcceptanceSettings('soon'), /is required/);
    await assert.rejects(() => settings.updateOrderAcceptanceSettings(undefined), /is required/);

    assert.equal((await settings.updateOrderAcceptanceSettings(5.4)).orderAcceptanceTimeMinutes, 5);
});

test('the company details are validated', async () => {
    await assert.rejects(
        () => settings.updateBusinessSettings({ ...valid, companyName: 'A' }),
        /between 2 and 50/,
    );
    await assert.rejects(
        () => settings.updateBusinessSettings({ ...valid, email: 'not-an-email' }),
        /Invalid email/,
    );
    await assert.rejects(
        () => settings.updateBusinessSettings({ ...valid, phoneNumber: '12345' }),
        /Invalid phone/,
    );
    await assert.rejects(
        () => settings.updateBusinessSettings({ ...valid, pincode: 'abc' }),
        /Invalid pincode/,
    );
    await assert.rejects(
        () => settings.updateBusinessSettings({ ...valid, address: 'x'.repeat(251) }),
        /Address is too long/,
    );
});

test('saving the company details leaves the branding alone', async () => {
    await settings.updatePowerScanningSettings({ user: { themeColor: '#AABBCC' } });

    const saved = await settings.updateBusinessSettings({
        ...valid,
        companyName: 'Minto Foods',
        phoneCountryCode: '+44',
        address: '1 Test Lane',
        pincode: '452001',
    });

    assert.equal(saved.companyName, 'Minto Foods');
    assert.deepEqual(saved.phone, { countryCode: '+44', number: '9876543210' });
    assert.equal(saved.address, '1 Test Lane');
    // Two different screens write this row; neither may clobber the other.
    assert.equal(saved.powerScanning.user.themeColor, '#AABBCC');
    assert.equal(await prisma.foodBusinessSettings.count(), 1);
});
