import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../../config/prisma.js';
import { uniquePhone } from '../../../../utils/testIds.js';
import {
    createWithdrawalMethod,
    updateWithdrawalMethod,
    deleteWithdrawalMethod,
    savePayoutDetails,
    getPayoutDetails,
    getPayoutSnapshot,
} from './withdrawalMethods.service.js';
import { recordRestaurantPayment, listRestaurantPayments, readPaymentBody } from './adminRestaurantPayments.service.js';
import { getSystemSettings, saveSystemSettings, createSocialLink, deleteSocialLink, getPublicLanding } from './adminSystemExtras.service.js';
import { saveEmailTemplate, resetEmailTemplate, getEmailTemplate } from './emailTemplates.service.js';

/**
 * Withdrawal methods, restaurant payments, settings, social links and email
 * templates against the database. Needs DATABASE_URL, like the rest of the
 * suite; the pure rules are in the *.util / *.defaults tests beside these.
 */

const created = { methods: [], restaurants: [], links: [], settings: [] };
const stamp = () => `${Date.now()}${Math.floor(performance.now() * 1000) % 1000}`;

const makeRestaurant = async () => {
    const restaurant = await prisma.foodRestaurant.create({
        data: { restaurantName: `Extras Rest ${stamp()}`, ownerName: 'Owner', ownerPhone: uniquePhone('9'), status: 'approved' },
    });
    created.restaurants.push(restaurant.id);
    return restaurant;
};

test.after(async () => {
    await prisma.foodPayoutMethodDetail.deleteMany({ where: { ownerId: { in: created.restaurants } } });
    await prisma.foodRestaurantWithdrawal.deleteMany({ where: { restaurantId: { in: created.restaurants } } });
    await prisma.foodWithdrawalMethod.deleteMany({ where: { id: { in: created.methods } } });
    await prisma.foodRestaurant.deleteMany({ where: { id: { in: created.restaurants } } });
    await prisma.foodSocialMediaLink.deleteMany({ where: { id: { in: created.links } } });
    await prisma.foodSystemSetting.deleteMany({ where: { key: { in: created.settings } } });
    await resetEmailTemplate('admin_password_reset');
    await prisma.$disconnect();
});

test('only one withdrawal method is the default', async () => {
    const a = await createWithdrawalMethod({ name: `Bank ${stamp()}`, fields: [{ label: 'Account number', type: 'number', required: true }], isDefault: true });
    const b = await createWithdrawalMethod({ name: `UPI ${stamp()}`, fields: [{ label: 'UPI id', required: true }], isDefault: true });
    created.methods.push(a.id, b.id);

    const [first, second] = await Promise.all([
        prisma.foodWithdrawalMethod.findUnique({ where: { id: a.id } }),
        prisma.foodWithdrawalMethod.findUnique({ where: { id: b.id } }),
    ]);
    assert.equal(first.isDefault, false);
    assert.equal(second.isDefault, true);

    // Switching the default off also stops it being the default.
    const off = await updateWithdrawalMethod(b.id, { isActive: false });
    assert.equal(off.isDefault, false);
});

test('a payee fills a method; the method cannot then be deleted', async () => {
    const restaurant = await makeRestaurant();
    const method = await createWithdrawalMethod({
        name: `Bank ${stamp()}`,
        fields: [{ label: 'Account number', type: 'number', required: true }, { label: 'Branch' }],
    });
    created.methods.push(method.id);

    await assert.rejects(() => savePayoutDetails('restaurant', restaurant.id, { methodId: method.id, values: {} }), /Account number is required/);
    const saved = await savePayoutDetails('restaurant', restaurant.id, { methodId: method.id, values: { account_number: '0012' } });
    assert.deepEqual(saved.selected.values, { account_number: '0012' });

    const snapshot = await getPayoutSnapshot('restaurant', restaurant.id);
    assert.equal(snapshot.methodName, method.name);
    assert.deepEqual(snapshot.fields.map((f) => f.value), ['0012']);

    await assert.rejects(() => deleteWithdrawalMethod(method.id), /Switch it off instead/);
    await updateWithdrawalMethod(method.id, { isActive: false });
    const details = await getPayoutDetails('restaurant', restaurant.id);
    assert.equal(details.selected.methodIsActive, false);
});

test('a payment larger than what the restaurant is owed is refused and nothing is written', async () => {
    const restaurant = await makeRestaurant();
    await assert.rejects(
        () => recordRestaurantPayment(restaurant.id, { amount: 100, method: 'bank_transfer', reference: 'UTR-1' }),
        /more than the restaurant is owed/,
    );
    const { payments } = await listRestaurantPayments({ restaurantId: restaurant.id });
    assert.equal(payments.length, 0);
    assert.throws(() => readPaymentBody({ amount: 0, method: 'upi' }), /greater than zero/);
    assert.throws(() => readPaymentBody({ amount: 5, method: 'crypto' }), /Method must be one of/);
});

test('settings are saved cleaned and read back; landing app links fall back to app settings', async () => {
    created.settings.push('app_settings', 'landing_page');
    await saveSystemSettings('app_settings', {
        value: { customer: { android: { minVersion: '1.2.0', latestVersion: '1.3.0', storeUrl: 'https://play.google.com/store/apps/details?id=x' } } },
    });
    await saveSystemSettings('landing_page', { value: { hero: { title: 'Hello' } } });
    const read = await getSystemSettings('app_settings');
    assert.equal(read.value.customer.android.minVersion, '1.2.0');
    const landing = await getPublicLanding();
    assert.equal(landing.hero.title, 'Hello');
    assert.equal(landing.appLinks.customerAndroid, 'https://play.google.com/store/apps/details?id=x');
});

test('social links need a web address', async () => {
    await assert.rejects(() => createSocialLink({ platform: 'Facebook', url: 'facebook' }), /web address/);
    const link = await createSocialLink({ platform: 'Facebook', url: 'https://facebook.com/x' });
    created.links.push(link.id);
    assert.equal(link.isActive, true);
    await deleteSocialLink(link.id);
});

test('an email template may only use its own placeholders, and resets to the built-in text', async () => {
    await assert.rejects(
        () => saveEmailTemplate('admin_password_reset', { subject: 'Code', body: '{{otp}} {{customerName}}' }),
        /cannot fill \{\{customerName\}\}/,
    );
    const saved = await saveEmailTemplate('admin_password_reset', { subject: 'Your code', body: '<p>{{otp}}</p>' });
    assert.equal(saved.isCustomized, true);
    const reset = await resetEmailTemplate('admin_password_reset');
    assert.equal(reset.isCustomized, false);
    assert.equal((await getEmailTemplate('admin_password_reset')).subject, reset.builtIn.subject);
});
