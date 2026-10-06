import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

/**
 * 3rd Party settings without a database: encryption at rest, what the admin
 * page is shown (never a secret), saving and importing, and the runtime
 * fallback to the server's environment that keeps payments and the fixed
 * test OTP working until an admin saves something.
 *
 * The Razorpay helper reads the server keys at call time, so they are set
 * before anything is imported.
 */
const SERVER_SECRET = 'server-secret-0123456789';
process.env.RAZORPAY_KEY_ID = 'rzp_test_serverkey';
process.env.RAZORPAY_KEY_SECRET = SERVER_SECRET;

const { config } = await import('../../config/env.js');
const { seal, open, maskSecret, isSealed } = await import('./secretBox.js');
const catalog = await import('./thirdParty.catalog.js');
const runtime = await import('./thirdParty.runtime.js');
const sms = await import('./sms.js');
const razorpay = await import('../../modules/food/orders/helpers/razorpay.helper.js');

const { describeArea, applySave, applyImport, resolveEffective } = catalog;

const sign = (orderId, paymentId, secret) =>
    crypto.createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex');

/** A config with known server values, without touching the real one. */
const serverConfig = (over = {}) => ({
    ...config,
    smsIndiaHubUsername: 'hubuser',
    smsApiKey: 'SMSKEY-abcdefghijkl-9876',
    smsSenderId: 'LAGECH',
    smsDltTemplateId: '1207000000000001',
    emailHost: 'smtp.example.com',
    emailPort: 587,
    emailUser: 'mailer@example.com',
    emailPass: 'mailpass',
    emailFrom: 'Lagech <noreply@example.com>',
    googleMapsApiKey: 'AIza-server-key-000011112222',
    razorpayKeyId: 'rzp_live_serverkey',
    razorpayKeySecret: 'rzp-secret-from-server-xyz1',
    razorpayWebhookSecret: 'whsec-server-0001',
    ...over,
});

// ─── Encryption ──────────────────────────────────────────────────────────────

test('a sealed secret opens only in the place it was sealed for', () => {
    const box = seal('p@ss word', 'mail.password');
    assert.ok(isSealed(box));
    assert.ok(!box.enc.includes('p@ss'), 'ciphertext does not contain the value');
    assert.equal(open(box, 'mail.password'), 'p@ss word');
    assert.equal(open(box, 'sms.apiKey'), null, 'moved to another field it does not decrypt');
    assert.notEqual(seal('same', 'a.b').enc, seal('same', 'a.b').enc, 'fresh IV every time');

    const tampered = { enc: `${box.enc.slice(0, -4)}AAAA` };
    assert.equal(open(tampered, 'mail.password'), null);
    assert.equal(open('plain text', 'mail.password'), null);
});

test('a value sealed under another key reads as unreadable, not as an error', () => {
    const box = seal('secret-value', 'payment.keySecret');
    const before = process.env.SETTINGS_ENCRYPTION_KEY;
    process.env.SETTINGS_ENCRYPTION_KEY = 'a-different-key';
    try {
        assert.equal(open(box, 'payment.keySecret'), null);
        const { values, sources, unreadable } = resolveEffective('payment', { values: { keySecret: box } }, serverConfig());
        assert.deepEqual(unreadable, ['keySecret']);
        assert.equal(values.keySecret, 'rzp-secret-from-server-xyz1', 'falls back to the server value');
        assert.equal(sources.keySecret, 'server');
    } finally {
        if (before === undefined) delete process.env.SETTINGS_ENCRYPTION_KEY;
        else process.env.SETTINGS_ENCRYPTION_KEY = before;
    }
});

test('masks show the last four of long secrets and nothing of short ones', () => {
    assert.equal(maskSecret('abcdefghijkl1234'), '••••1234');
    assert.equal(maskSecret('short'), '••••••••');
    assert.equal(maskSecret(''), '');
});

// ─── What the admin page sees ────────────────────────────────────────────────

test('with nothing saved the page shows the server values, secrets masked', () => {
    const area = describeArea('payment', null, serverConfig());
    const field = (key) => area.fields.find((f) => f.key === key);
    assert.equal(field('keyId').value, 'rzp_live_serverkey');
    assert.equal(field('keyId').source, 'server');
    assert.equal(field('mode').value, 'live');
    assert.equal(field('keySecret').value, '');
    assert.equal(field('keySecret').masked, '••••xyz1');
    assert.equal(field('keySecret').hasValue, true);
    assert.equal(field('keySecret').source, 'server');
    assert.ok(!JSON.stringify(area).includes('rzp-secret-from-server-xyz1'), 'the secret is nowhere in the response');
    assert.ok(!JSON.stringify(area).includes('whsec-server-0001'));

    const mail = describeArea('mail', null, serverConfig());
    assert.equal(mail.fields.find((f) => f.key === 'host').value, 'smtp.example.com');
    assert.equal(mail.fields.find((f) => f.key === 'enabled').value, true);
    assert.ok(!JSON.stringify(mail).includes('mailpass'));

    const empty = describeArea('recaptcha', null, serverConfig());
    assert.equal(empty.fields.find((f) => f.key === 'secretKey').source, 'none');
    assert.equal(empty.wired, false);
});

test('a saved field reads as admin, the rest stay on the server values', () => {
    const { doc } = applySave('sms', null, { values: { senderId: 'NEWSID', apiKey: 'new-sms-key-000000001234' } }, serverConfig());
    const area = describeArea('sms', doc, serverConfig());
    const field = (key) => area.fields.find((f) => f.key === key);
    assert.equal(field('senderId').source, 'admin');
    assert.equal(field('senderId').value, 'NEWSID');
    assert.equal(field('apiKey').source, 'admin');
    assert.equal(field('apiKey').masked, '••••1234');
    assert.equal(field('username').source, 'server');
    assert.equal(field('username').value, 'hubuser');
    assert.ok(!JSON.stringify(doc).includes('new-sms-key'), 'stored encrypted');
});

// ─── Saving ──────────────────────────────────────────────────────────────────

test('an empty secret keeps the saved one; clear goes back to the server value', () => {
    const cfg = serverConfig();
    const first = applySave('mail', null, { values: { password: 'first password', host: 'smtp.saved.com' } }, cfg);
    assert.deepEqual(first.changed.sort(), ['host', 'password']);
    assert.equal(resolveEffective('mail', first.doc, cfg).values.password, 'firstpassword', 'spaces stripped like EMAIL_PASS');

    const kept = applySave('mail', first.doc, { values: { password: '', port: 465 } }, cfg);
    assert.deepEqual(kept.changed, ['port']);
    assert.equal(resolveEffective('mail', kept.doc, cfg).values.password, 'firstpassword');

    const cleared = applySave('mail', kept.doc, { values: { host: '' }, clear: ['password'] }, cfg);
    assert.deepEqual(cleared.changed.sort(), ['host', 'password']);
    const effective = resolveEffective('mail', cleared.doc, cfg);
    assert.equal(effective.values.password, 'mailpass');
    assert.equal(effective.sources.host, 'server');
});

test('saving checks the fields', () => {
    const cfg = serverConfig();
    assert.throws(() => applySave('mail', null, { values: { port: 70000 } }, cfg), /port/i);
    assert.throws(() => applySave('mail', null, { values: { encryption: 'rot13' } }, cfg), /Encryption/);
    assert.throws(() => applySave('sms', null, { values: { otpMessage: 'Your code' } }, cfg), /\{otp\}/);
    assert.throws(() => applySave('sms', null, { values: { provider: 'twilio' } }, cfg), /Provider/);
    assert.throws(() => applySave('recaptcha', null, { values: { enabled: true } }, cfg), /site key/);
    assert.throws(() => applySave('storage', null, { values: { driver: 's3' } }, serverConfig()), /bucket/);
    assert.throws(() => applySave('nope', null, {}, cfg), /Unknown/);
});

test('the Razorpay key id and secret can only be changed together', () => {
    const cfg = serverConfig();
    assert.throws(() => applySave('payment', null, { values: { keyId: 'rzp_live_newkey' } }, cfg), /together/);
    assert.throws(() => applySave('payment', null, { values: { keySecret: 'only-the-secret-123' } }, cfg), /together/);
    assert.throws(
        () => applySave('payment', null, { values: { keyId: 'rzp_test_newkey', keySecret: 'new-secret-0000', mode: 'live' } }, cfg),
        /live key/,
    );
    const ok = applySave('payment', null, { values: { keyId: 'rzp_test_newkey', keySecret: 'new-secret-0000', mode: 'test' } }, cfg);
    assert.deepEqual(ok.changed.sort(), ['keyId', 'keySecret', 'mode']);
    // Clearing one half of a saved pair is refused too.
    assert.throws(() => applySave('payment', ok.doc, { clear: ['keySecret'] }, cfg), /together/);
    const both = applySave('payment', ok.doc, { clear: ['keyId', 'keySecret'] }, cfg);
    assert.equal(resolveEffective('payment', both.doc, cfg).values.keyId, 'rzp_live_serverkey');
});

// ─── Importing the server values ─────────────────────────────────────────────

test('import copies the server values, encrypted, and is idempotent', () => {
    const cfg = serverConfig();
    const first = applyImport('sms', null, {}, cfg);
    assert.ok(first.imported.includes('apiKey') && first.imported.includes('senderId'));
    assert.ok(isSealed(first.doc.values.apiKey), 'the key is stored encrypted');
    assert.ok(!JSON.stringify(first.doc).includes('SMSKEY-abcdefghijkl-9876'));
    const view = describeArea('sms', first.doc, cfg);
    assert.ok(view.fields.every((f) => f.source === 'admin'));

    const again = applyImport('sms', first.doc, {}, cfg);
    assert.deepEqual(again.imported, []);
    assert.deepEqual(again.doc, first.doc);
});

test('import leaves admin values alone unless asked to overwrite', () => {
    const cfg = serverConfig();
    const { doc } = applySave('sms', null, { values: { senderId: 'ADMINS' } }, cfg);
    const kept = applyImport('sms', doc, {}, cfg);
    assert.ok(kept.skipped.includes('senderId'));
    assert.equal(resolveEffective('sms', kept.doc, cfg).values.senderId, 'ADMINS');

    const over = applyImport('sms', doc, { overwrite: true }, cfg);
    assert.ok(over.imported.includes('senderId'));
    assert.equal(resolveEffective('sms', over.doc, cfg).values.senderId, 'LAGECH');
});

test('import skips a Razorpay pair the server has only half of', () => {
    const cfg = serverConfig({ razorpayKeySecret: '' });
    const { doc, imported } = applyImport('payment', null, {}, cfg);
    assert.ok(!imported.includes('keyId'));
    assert.ok(!('keyId' in doc.values) && !('keySecret' in doc.values));
});

// ─── Runtime fallback ────────────────────────────────────────────────────────

test('with nothing saved Razorpay uses the server keys exactly as before', () => {
    runtime.invalidateThirdPartySettings();
    assert.equal(razorpay.getRazorpayKeyId(), 'rzp_test_serverkey');
    assert.equal(razorpay.isRazorpayConfigured(), true);
    assert.equal(razorpay.verifyPaymentSignature('order_1', 'pay_1', sign('order_1', 'pay_1', SERVER_SECRET)), true);
    assert.equal(razorpay.verifyPaymentSignature('order_1', 'pay_1', sign('order_1', 'pay_1', 'wrong')), false);
    assert.equal(razorpay.verifyPaymentSignature('order_1', 'pay_1', undefined), false);
});

test('saved keys take over, and payments signed with the server secret still verify', () => {
    const { doc } = applySave('payment', null, {
        values: { keyId: 'rzp_test_adminkey', keySecret: 'admin-secret-77777', mode: 'test' },
    }, config);
    runtime.primeThirdPartySettings('payment', doc);
    try {
        assert.equal(razorpay.getRazorpayKeyId(), 'rzp_test_adminkey');
        assert.equal(razorpay.verifyPaymentSignature('o', 'p', sign('o', 'p', 'admin-secret-77777')), true);
        assert.equal(razorpay.verifyPaymentSignature('o', 'p', sign('o', 'p', SERVER_SECRET)), true, 'in-flight payment');
        assert.equal(razorpay.verifyPaymentSignature('o', 'p', sign('o', 'p', 'someone-else')), false);
    } finally {
        runtime.invalidateThirdPartySettings('payment');
    }
});

test('switching Razorpay off stops new payments but not verification', async () => {
    const { doc } = applySave('payment', null, { values: { enabled: false } }, config);
    runtime.primeThirdPartySettings('payment', doc);
    try {
        assert.equal(razorpay.isRazorpayConfigured(), true, 'still configured, so nothing skips verification');
        await assert.rejects(() => razorpay.createRazorpayOrder(1000), /switched off/);
        await assert.rejects(() => razorpay.createPaymentLink({ amountPaise: 1000 }), /switched off/);
        assert.equal(razorpay.verifyPaymentSignature('o', 'p', sign('o', 'p', SERVER_SECRET)), true);
    } finally {
        runtime.invalidateThirdPartySettings('payment');
    }
});

test('an unreadable saved secret falls back to the server pair at runtime', () => {
    runtime.primeThirdPartySettings('payment', {
        values: { keyId: 'rzp_test_adminkey', keySecret: { enc: 'v1:garbage' } },
    });
    try {
        const effective = runtime.getThirdPartySettingsSync('payment');
        assert.equal(effective.keySecret, SERVER_SECRET);
        assert.equal(effective.keyId, 'rzp_test_serverkey', 'never an admin key id with the server secret');
    } finally {
        runtime.invalidateThirdPartySettings('payment');
    }
});

// ─── SMS ─────────────────────────────────────────────────────────────────────

test('the SMS request carries the effective settings and the OTP in the template', () => {
    const settings = { apiKey: 'KEY123456', senderId: 'LAGECH', username: 'u', dltTemplateId: 'T1', otpMessage: 'Code {otp} for Lagech' };
    const url = sms.buildSmsIndiaHubUrl(settings, '98765 43210', '4321');
    assert.equal(url.searchParams.get('APIKey'), 'KEY123456');
    assert.equal(url.searchParams.get('msisdn'), '919876543210');
    assert.equal(url.searchParams.get('msg'), 'Code 4321 for Lagech');
    assert.equal(url.searchParams.get('DLT_TE_ID'), 'T1');
    assert.equal(sms.buildSmsIndiaHubUrl(settings, '919876543210', '1').searchParams.get('msisdn'), '919876543210');
    assert.equal(sms.buildSmsIndiaHubUrl(settings, '9123456789', '1').searchParams.get('msisdn'), '919123456789');
    assert.equal(sms.otpMessageText({}, '55'), catalog.DEFAULT_OTP_MESSAGE.replace('{otp}', '55'));
});

test('SMS replies are read the way the provider reports failures', async () => {
    assert.deepEqual(sms.interpretSmsReply(200, true, '{"ErrorCode":"000","ErrorMessage":"Done"}'), { ok: true });
    assert.equal(sms.interpretSmsReply(200, true, '{"ErrorCode":"006","ErrorMessage":"x"}').ok, false);
    assert.equal(sms.interpretSmsReply(200, true, 'Failed#Invalid Login').ok, false);
    assert.equal(sms.interpretSmsReply(500, false, 'oops').ok, false);

    const settings = { apiKey: 'SECRETKEY99', senderId: 'S' };
    const echoed = await sms.sendOtpSms(settings, '9876543210', '1', {
        fetchImpl: async () => ({ ok: true, status: 200, text: async () => 'Failed# bad key SECRETKEY99' }),
    });
    assert.equal(echoed.ok, false);
    assert.ok(!echoed.reply.includes('SECRETKEY99'), 'an echoed key is scrubbed');

    const unconfigured = await sms.sendOtpSms({}, '9876543210', '1', { fetchImpl: async () => assert.fail('no request without a key') });
    assert.equal(unconfigured.ok, false);
});
