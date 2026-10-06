import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../../config/prisma.js';
import { config } from '../../../../config/env.js';
import { uniquePhone } from '../../../../utils/testIds.js';
import {
    getAllThirdPartyAreas,
    getThirdPartyArea,
    saveThirdPartyArea,
    importThirdPartyArea,
    listThirdPartyAudit,
    sendThirdPartyTestSms,
    sendThirdPartyTestEmail,
    cleanTestPhone,
} from './adminThirdParty.service.js';
import { getSystemSettings } from './adminSystemExtras.service.js';
import { getThirdPartySettings, invalidateThirdPartySettings } from '../../../../core/thirdParty/thirdParty.runtime.js';
import { AREA_KEYS, storeKey } from '../../../../core/thirdParty/thirdParty.catalog.js';
import { createOrUpdateOtp } from '../../../../core/otp/otp.service.js';
import { requireSuperAdmin } from '../routes/adminThirdParty.routes.js';

/**
 * 3rd Party settings against the database: secrets stored encrypted and never
 * returned, import of the server's values done server side, the audit trail,
 * and that the runtime and the fixed test OTP keep working.
 *
 * The "server" values are test values set on the config object for this file
 * only and restored afterwards; nothing here reads a real environment.
 */

const SERVER = {
    smsIndiaHubUsername: 'hub-user-test',
    smsApiKey: 'server-sms-key-test-4242',
    smsSenderId: 'LGTEST',
    smsDltTemplateId: '1207000000000009',
    emailHost: 'smtp.test.invalid',
    emailPort: 587,
    emailUser: 'mailer@test.invalid',
    emailPass: 'server-mail-pass',
    emailFrom: 'Lagech <noreply@test.invalid>',
    googleMapsApiKey: 'server-maps-key-test-0001',
    razorpayKeyId: 'rzp_test_servertest',
    razorpayKeySecret: 'server-rzp-secret-test-9999',
    razorpayWebhookSecret: 'server-webhook-test-1111',
};
const SECRETS = [SERVER.smsApiKey, SERVER.emailPass, SERVER.googleMapsApiKey, SERVER.razorpayKeySecret, SERVER.razorpayWebhookSecret];
const original = Object.fromEntries(Object.keys(SERVER).map((key) => [key, config[key]]));
Object.assign(config, SERVER);

const phones = [];
let admin;

const clearAll = async () => {
    await prisma.foodSystemSetting.deleteMany({ where: { key: { in: AREA_KEYS.map(storeKey) } } });
    invalidateThirdPartySettings();
};

test.before(async () => {
    await clearAll();
    admin = await prisma.foodAdmin.create({
        data: { email: `third-party-${Date.now()}@test.invalid`, password: 'x', name: 'TP Admin' },
    });
});

test.after(async () => {
    await clearAll();
    await prisma.foodSettingsAuditLog.deleteMany({ where: { adminId: admin.id } });
    await prisma.foodAdmin.deleteMany({ where: { id: admin.id } });
    await prisma.foodOtp.deleteMany({ where: { phone: { in: phones } } });
    Object.assign(config, original);
    await prisma.$disconnect();
});

const field = (area, key) => area.fields.find((f) => f.key === key);
const noSecretIn = (value, extra = []) => {
    const text = JSON.stringify(value);
    for (const secret of [...SECRETS, ...extra]) assert.ok(!text.includes(secret), `"${secret.slice(0, 6)}..." must not appear`);
};

test('with nothing saved every tab shows the server values, secrets masked', async () => {
    const { areas } = await getAllThirdPartyAreas();
    assert.deepEqual(areas.map((a) => a.area), AREA_KEYS);
    noSecretIn(areas);

    const sms = areas.find((a) => a.area === 'sms');
    assert.equal(field(sms, 'senderId').value, 'LGTEST');
    assert.equal(field(sms, 'senderId').source, 'server');
    assert.equal(field(sms, 'apiKey').masked, '••••4242');
    assert.equal(field(sms, 'apiKey').hasValue, true);
    const payment = areas.find((a) => a.area === 'payment');
    assert.equal(field(payment, 'keyId').value, 'rzp_test_servertest', 'the key id is not a secret');
    assert.equal(field(payment, 'mode').value, 'test');
});

test('a saved secret is encrypted in the database and never comes back', async () => {
    const result = await saveThirdPartyArea('mail', {
        values: { host: 'smtp.admin.invalid', password: 'admin-mail-password-77' },
    }, admin.id);
    assert.deepEqual(result.changed.sort(), ['host', 'password']);
    noSecretIn(result, ['admin-mail-password-77']);
    assert.equal(field(result, 'password').source, 'admin');
    assert.equal(field(result, 'password').masked, '••••••••');

    const row = await prisma.foodSystemSetting.findUnique({ where: { key: storeKey('mail') } });
    assert.ok(!JSON.stringify(row.value).includes('admin-mail-password-77'), 'not stored in the clear');

    const runtime = await getThirdPartySettings('mail');
    assert.equal(runtime.password, 'admin-mail-password-77');
    assert.equal(runtime.host, 'smtp.admin.invalid');
    assert.equal(runtime.username, 'mailer@test.invalid', 'unsaved fields still come from the server');

    // Saving again with the secret left empty keeps it.
    const again = await saveThirdPartyArea('mail', { values: { password: '', port: 2525 } }, admin.id);
    assert.deepEqual(again.changed, ['port']);
    assert.equal((await getThirdPartySettings('mail')).password, 'admin-mail-password-77');
});

test('the generic settings endpoint cannot read these documents', async () => {
    await assert.rejects(() => getSystemSettings(storeKey('mail')), /Unknown settings area/);
    await assert.rejects(() => getSystemSettings('mail'), /Unknown settings area/);
});

test('import copies the server values on the server, once, and keeps admin values', async () => {
    await saveThirdPartyArea('sms', { values: { senderId: 'ADMSID' } }, admin.id);
    const first = await importThirdPartyArea('sms', {}, admin.id);
    assert.ok(first.imported.includes('apiKey') && first.imported.includes('username'));
    assert.ok(first.skipped.includes('senderId'));
    noSecretIn(first);
    assert.ok(first.fields.every((f) => f.source === 'admin'));
    assert.equal(field(first, 'senderId').value, 'ADMSID');

    const row = await prisma.foodSystemSetting.findUnique({ where: { key: storeKey('sms') } });
    assert.ok(!JSON.stringify(row.value).includes(SERVER.smsApiKey));
    assert.equal((await getThirdPartySettings('sms')).apiKey, SERVER.smsApiKey);

    const second = await importThirdPartyArea('sms', {}, admin.id);
    assert.deepEqual(second.imported, [], 'nothing left to import');

    const over = await importThirdPartyArea('sms', { overwrite: true }, admin.id);
    assert.ok(over.imported.includes('senderId'));
    assert.equal(field(over, 'senderId').value, 'LGTEST');
});

test('every change is audited with field names and the admin, never values', async () => {
    const { entries } = await listThirdPartyAudit({ limit: 50 });
    const mine = entries.filter((e) => e.adminEmail === admin.email);
    assert.ok(mine.some((e) => e.area === 'mail' && e.action === 'save' && e.fields.includes('password')));
    assert.ok(mine.some((e) => e.area === 'sms' && e.action === 'import' && e.fields.includes('apiKey')));
    assert.ok(mine.some((e) => e.area === 'sms' && e.action === 'import_overwrite'));
    assert.equal(mine.filter((e) => e.area === 'sms' && e.action === 'import').length, 1, 'an import that changed nothing is not logged');
    noSecretIn(entries, ['admin-mail-password-77']);
});

test('the fixed test OTP still applies with SMS settings saved, and no SMS is sent', async () => {
    assert.equal(config.useDefaultOtp, true, 'the suite runs with USE_DEFAULT_OTP');
    await saveThirdPartyArea('sms', { values: { apiKey: 'another-admin-sms-key-0000' } }, admin.id);
    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => { calls += 1; return { ok: true, status: 200, text: async () => 'ok' }; };
    try {
        const phone = uniquePhone('56');
        phones.push(phone);
        assert.equal(await createOrUpdateOtp(phone), '1234');
        assert.equal(calls, 0);
    } finally {
        globalThis.fetch = realFetch;
    }
});

test('a test SMS goes out with the saved settings and reports the reply', async () => {
    let sentTo = '';
    const result = await sendThirdPartyTestSms({ phone: '+91 98765 43210' }, admin.id, {
        fetchImpl: async (url) => {
            sentTo = url;
            return { ok: true, status: 200, text: async () => '{"ErrorCode":"000","ErrorMessage":"Done"}' };
        },
    });
    assert.equal(result.sent, true);
    assert.equal(result.fixedOtpMode, true);
    const url = new URL(sentTo);
    assert.equal(url.searchParams.get('APIKey'), 'another-admin-sms-key-0000');
    assert.equal(url.searchParams.get('msisdn'), '919876543210');
    noSecretIn(result, ['another-admin-sms-key-0000']);

    assert.throws(() => cleanTestPhone('12345'), /10-digit/);
    await assert.rejects(() => sendThirdPartyTestEmail({ email: 'not-an-email' }, admin.id), /valid email/);
});

test('a test email with mail switched off says so instead of sending', async () => {
    await saveThirdPartyArea('mail', { values: { enabled: false } }, admin.id);
    const result = await sendThirdPartyTestEmail({ email: 'someone@test.invalid' }, admin.id);
    assert.deepEqual(result, { sent: false, reason: 'Email is switched off' });
});

test('clearing a saved field goes back to the server value', async () => {
    const result = await saveThirdPartyArea('mail', { values: { host: '' }, clear: ['password', 'enabled'] }, admin.id);
    assert.equal(field(result, 'host').source, 'server');
    assert.equal(field(result, 'host').value, 'smtp.test.invalid');
    assert.equal(field(result, 'password').source, 'server');
    assert.equal((await getThirdPartySettings('mail')).password, 'server-mail-pass');
});

test('Razorpay keys must be saved as a pair', async () => {
    await assert.rejects(() => saveThirdPartyArea('payment', { values: { keyId: 'rzp_test_onlyid' } }, admin.id), /together/);
    const saved = await saveThirdPartyArea('payment', {
        values: { keyId: 'rzp_test_adminpair', keySecret: 'admin-pair-secret-5555', mode: 'test' },
    }, admin.id);
    assert.equal(field(saved, 'keyId').value, 'rzp_test_adminpair');
    noSecretIn(saved, ['admin-pair-secret-5555']);
    const area = await getThirdPartyArea('payment');
    assert.equal(field(area, 'keySecret').masked, '••••5555');
});

test('only a super admin passes the guard', async () => {
    const run = async (adminAccess) => {
        const req = { user: { userId: admin.id, role: 'ADMIN' }, adminAccess };
        let status = 0;
        let nextCalled = false;
        const res = { status(code) { status = code; return this; }, json() { return this; } };
        await requireSuperAdmin(req, res, () => { nextCalled = true; });
        return nextCalled ? 'next' : status;
    };
    assert.equal(await run({ adminType: 'super_admin', isActive: true, isDeleted: false }), 'next');
    assert.equal(await run({ adminType: 'sub_admin', isActive: true, isDeleted: false }), 403);
    assert.equal(await run({ adminType: 'super_admin', isActive: false, isDeleted: false }), 403);
    assert.equal(await run(undefined), 'next', 'reads the admin from the database when not cached');
});
