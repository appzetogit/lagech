import test from 'node:test';
import assert from 'node:assert/strict';

import {
    cleanSettings,
    readStoredSettings,
    cleanUrl,
    cleanVersion,
    compareVersions,
    META_PAGES,
} from './systemSettings.defaults.js';

test('every area cleans an empty document to its defaults', () => {
    for (const area of ['page_meta', 'app_settings', 'login_setup', 'notification_channels', 'landing_page', 'website',
        'push_messages', 'offline_payment', 'analytics_scripts']) {
        assert.ok(cleanSettings(area, {}), area);
    }
    assert.deepEqual(Object.keys(cleanSettings('page_meta', {}).pages), META_PAGES.map((p) => p.key));
    assert.deepEqual(cleanSettings('app_settings', {}).rider.ios, { minVersion: '', latestVersion: '', storeUrl: '' });
    assert.throws(() => cleanSettings('nope', {}), /Unknown settings area/);
});

test('URLs must be web addresses or site paths', () => {
    assert.equal(cleanUrl('', 'x'), '');
    assert.equal(cleanUrl('/uploads/a.webp', 'x'), '/uploads/a.webp');
    assert.equal(cleanUrl('https://play.google.com/store', 'x'), 'https://play.google.com/store');
    assert.throws(() => cleanUrl('javascript:alert(1)', 'Link'), /Link must be a web address/);
    assert.throws(() => cleanUrl('//evil.example', 'Link'), /web address/);
});

test('versions are dotted numbers, compared numerically', () => {
    assert.equal(cleanVersion(' 2.10.1 ', 'v'), '2.10.1');
    assert.throws(() => cleanVersion('v2', 'Minimum'), /version number/);
    assert.equal(compareVersions('2.10.0', '2.9.9'), 1);
    assert.equal(compareVersions('2.0', '2.0.0'), 0);
    assert.equal(compareVersions('1.9', '2'), -1);
    assert.throws(
        () => cleanSettings('app_settings', { customer: { android: { minVersion: '3.0', latestVersion: '2.9' } } }),
        /cannot be newer/,
    );
});

test('login setup keeps phone OTP on whatever is sent', () => {
    const clean = cleanSettings('login_setup', {
        customer: { otpLogin: false, googleLogin: 'true' },
        restaurant: { emailPasswordLogin: true },
    });
    assert.equal(clean.customer.otpLogin, true);
    assert.equal(clean.customer.googleLogin, true);
    assert.equal(clean.customer.appleLogin, false);
    assert.equal(clean.restaurant.emailPasswordLogin, true);
    assert.equal(clean.rider.otpLogin, true);
});

test('landing page drops empty list items and unknown keys, caps lengths', () => {
    const clean = cleanSettings('landing_page', {
        hero: { title: 'x'.repeat(500), extra: 1 },
        features: [{ title: '' }, { title: 'Fast', description: 'd' }],
        testimonials: [{ name: 'A', quote: '' }, { name: 'B', quote: 'Q', rating: 9 }, { name: 'C', quote: 'Q', rating: '4' }],
        sections: { showFeatures: 'false' },
    });
    assert.equal(clean.hero.title.length, 120);
    assert.equal(clean.hero.extra, undefined);
    assert.deepEqual(clean.features, [{ title: 'Fast', description: 'd', image: '' }]);
    assert.deepEqual(clean.testimonials.map((t) => [t.name, t.rating]), [['B', null], ['C', 4]]);
    assert.equal(clean.sections.showFeatures, false);
    assert.equal(clean.sections.showTestimonials, true);
});

test('a stored document that no longer passes reads as the defaults', () => {
    const read = readStoredSettings('website', { siteUrl: 'not a url', maintenanceMode: true });
    assert.deepEqual(read, { siteUrl: '', maintenanceMode: false, maintenanceMessage: '' });
});

test('offline payment methods keep their id, need payment details and customer fields', () => {
    const clean = cleanSettings('offline_payment', {
        enabled: 'true',
        methods: [
            {
                id: '0123456789abcdef',
                name: ' Bank transfer ',
                paymentInfo: [{ label: 'Account number', value: '0012345' }, { label: '', value: '' }],
                fields: [{ label: 'Transaction id', required: true }],
                extra: 'dropped',
            },
            { id: 'not-an-id', name: 'UPI', isActive: false, paymentInfo: [{ label: 'UPI id', value: 'shop@upi' }], fields: [{ label: 'UTR', type: 'number' }] },
        ],
    });
    assert.equal(clean.enabled, true);
    assert.equal(clean.methods[0].id, '0123456789abcdef');
    assert.equal(clean.methods[0].name, 'Bank transfer');
    assert.equal(clean.methods[0].isActive, true);
    assert.deepEqual(clean.methods[0].paymentInfo, [{ label: 'Account number', value: '0012345' }]);
    assert.deepEqual(clean.methods[0].fields.map((f) => [f.key, f.required]), [['transaction_id', true]]);
    assert.equal(clean.methods[0].extra, undefined);
    // A missing or malformed id gets a fresh one.
    assert.match(clean.methods[1].id, /^[a-f0-9]{16}$/);
    assert.equal(clean.methods[1].isActive, false);

    assert.deepEqual(cleanSettings('offline_payment', {}), { enabled: false, methods: [] });
    assert.throws(() => cleanSettings('offline_payment', { methods: [{ name: '', paymentInfo: [], fields: [] }] }), /needs a name/);
    assert.throws(
        () => cleanSettings('offline_payment', { methods: [{ name: 'Bank', paymentInfo: [], fields: [{ label: 'Txn' }] }] }),
        /add the details the customer pays to/,
    );
    assert.throws(
        () => cleanSettings('offline_payment', { methods: [{ name: 'Bank', paymentInfo: [{ label: 'A', value: '1' }], fields: [] }] }),
        /"Bank": Add at least one field/,
    );
    assert.throws(
        () => cleanSettings('offline_payment', { methods: [{ name: 'Bank', paymentInfo: [{ label: 'A', value: '' }], fields: [{ label: 'Txn' }] }] }),
        /needs a title and a value/,
    );
});

test('analytics stores only well-formed ids, and cannot be switched on blank', () => {
    const clean = cleanSettings('analytics_scripts', {
        googleAnalytics: { enabled: true, id: 'g-abc1234' },
        googleTagManager: { enabled: false, id: '' },
        metaPixel: { enabled: 'true', id: '123456789012345' },
        other: { enabled: true, id: 'x' },
    });
    assert.deepEqual(clean, {
        googleAnalytics: { enabled: true, id: 'G-ABC1234' },
        googleTagManager: { enabled: false, id: '' },
        metaPixel: { enabled: true, id: '123456789012345' },
    });
    // Script text is not an id.
    assert.throws(() => cleanSettings('analytics_scripts', { googleAnalytics: { id: '<script>alert(1)</script>' } }), /should look like G-/);
    assert.throws(() => cleanSettings('analytics_scripts', { metaPixel: { id: '12ab' } }), /Meta Pixel/);
    assert.throws(() => cleanSettings('analytics_scripts', { googleTagManager: { enabled: true } }), /before switching it on/);
});

test('push messages: every message present, switches only where this page owns them', () => {
    const clean = cleanSettings('push_messages', {
        messages: {
            customer_order_placed: { enabled: false, title: ' Hi ', body: 'Order {orderId}' },
            // Switched on Notification Channels, so the switch here is ignored.
            customer_order_confirmed: { enabled: false, title: 'Confirmed' },
            // The delivery offer is never switchable.
            rider_new_order: { enabled: false },
            bogus: { title: 'x' },
        },
    });
    assert.deepEqual(clean.messages.customer_order_placed, { enabled: false, title: 'Hi', body: 'Order {orderId}' });
    assert.deepEqual(clean.messages.customer_order_confirmed, { enabled: true, title: 'Confirmed', body: '' });
    assert.equal(clean.messages.rider_new_order.enabled, true);
    assert.equal(clean.messages.bogus, undefined);
    assert.equal(clean.messages.customer_payment_failed.enabled, true);
});
