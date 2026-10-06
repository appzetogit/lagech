import test from 'node:test';
import assert from 'node:assert/strict';

import {
    EMAIL_TEMPLATES,
    renderTemplate,
    placeholdersIn,
    unknownPlaceholders,
    htmlToText,
    composeEmail,
} from './emailTemplates.js';

test('placeholders are filled, escaped in HTML and left plain in a subject', () => {
    assert.equal(renderTemplate('Hi {{ name }}, code {{otp}}', { name: '<b>A&B</b>', otp: 123 }), 'Hi &lt;b&gt;A&amp;B&lt;/b&gt;, code 123');
    assert.equal(renderTemplate('Hi {{name}}', { name: 'A&B\nC' }, { html: false }), 'Hi A&B C');
});

test('an unknown placeholder renders as nothing', () => {
    assert.equal(renderTemplate('[{{missing}}]', {}), '[]');
});

test('placeholders are listed once each, and unknown ones are found', () => {
    assert.deepEqual(placeholdersIn('{{a}} {{b}} {{a}}'), ['a', 'b']);
    assert.deepEqual(unknownPlaceholders('admin_password_reset', '{{otp}} {{name}}', 'Hi {{companyName}}'), ['name']);
});

test('HTML becomes readable text', () => {
    assert.equal(htmlToText('<h2>Title</h2><p>One &amp; two</p><p>Three</p>'), 'Title\nOne & two\nThree');
});

test('the built-in wording is used when there is no active stored template', () => {
    const values = { otp: '482913', validMinutes: 10, companyName: 'Lagech' };
    const builtIn = composeEmail('admin_password_reset', values);
    assert.equal(builtIn.source, 'built_in');
    assert.equal(builtIn.subject, 'Your password reset code – Lagech Admin');
    assert.match(builtIn.html, /482913/);
    assert.match(builtIn.text, /valid for 10 minutes/);

    const off = composeEmail('admin_password_reset', values, { subject: 'X', body: 'Y', isActive: false });
    assert.equal(off.source, 'built_in');

    const stored = composeEmail('admin_password_reset', values, { subject: 'Code for {{companyName}}', body: '<p>{{otp}}</p>', isActive: true });
    assert.equal(stored.source, 'stored');
    assert.equal(stored.subject, 'Code for Lagech');
    assert.equal(stored.text, '482913');
});

test('every registered email declares the placeholders its built-in text uses', () => {
    for (const [key, template] of Object.entries(EMAIL_TEMPLATES)) {
        assert.deepEqual(unknownPlaceholders(key, template.subject, template.body), [], key);
    }
    assert.throws(() => composeEmail('nope', {}), /Unknown email template/);
});

test('the transactional emails are all in the catalog, each with an audience', () => {
    const expected = [
        'admin_new_restaurant', 'admin_new_delivery_partner',
        'restaurant_approved', 'restaurant_rejected',
        'delivery_partner_approved', 'delivery_partner_rejected',
        'withdraw_approved', 'withdraw_rejected',
        'order_placed', 'refund_approved', 'refund_rejected', 'wallet_credited',
        'account_suspended', 'account_unsuspended',
    ];
    for (const key of expected) {
        const template = EMAIL_TEMPLATES[key];
        assert.ok(template, key);
        assert.ok(template.name && template.description && template.subject && template.body, key);
        assert.ok(Array.isArray(template.audience) && template.audience.length, key);
        assert.ok(template.placeholders.some((p) => p.key === 'companyName'), key);
    }
});

test('an event email renders its values, escaped in the body', () => {
    const email = composeEmail('withdraw_rejected', { userName: 'Asha <Admin>', amount: '250', reason: 'Bank details & IFSC missing', companyName: 'Lagech' });
    assert.equal(email.subject, 'Your withdrawal of ₹250 was not approved');
    assert.match(email.html, /Asha &lt;Admin&gt;/);
    assert.match(email.html, /Bank details &amp; IFSC missing/);
    assert.match(email.text, /Reason: Bank details & IFSC missing/);
    const order = composeEmail('order_placed', { userName: 'Ravi', orderId: 'FOD-1', restaurantName: 'Dosa Hut', amount: '199', companyName: 'Lagech' });
    assert.equal(order.subject, 'Order #FOD-1 confirmed');
    assert.match(order.text, /Order total: ₹199/);
});

test('settings: every switchable email defaults on, the reset code cannot be switched, addresses are cleaned', async () => {
    const { normalizeEmailSettings, isSwitchable, cleanEmail } = await import('../core/notifications/emailSettings.js');
    const defaults = normalizeEmailSettings({});
    assert.equal(isSwitchable('admin_password_reset'), false);
    assert.equal('admin_password_reset' in defaults.switches, false);
    for (const key of Object.keys(EMAIL_TEMPLATES).filter(isSwitchable)) assert.equal(defaults.switches[key], true, key);
    assert.deepEqual(defaults.adminRecipients, []);

    const saved = normalizeEmailSettings({
        switches: { order_placed: false, nope: false, refund_approved: 'yes' },
        adminRecipients: [' Ops@Example.com ', 'ops@example.com', 'not an email', 'b@x.io'],
    });
    assert.equal(saved.switches.order_placed, false);
    assert.equal(saved.switches.refund_approved, true, 'a non-boolean keeps the default');
    assert.equal('nope' in saved.switches, false);
    assert.deepEqual(saved.adminRecipients, ['ops@example.com', 'b@x.io']);
    assert.equal(cleanEmail('a@b'), null);
    assert.equal(cleanEmail('A@B.CO'), 'a@b.co');
});
