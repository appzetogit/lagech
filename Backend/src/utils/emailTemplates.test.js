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
