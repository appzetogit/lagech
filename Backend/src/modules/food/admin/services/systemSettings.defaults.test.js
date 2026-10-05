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
    for (const area of ['page_meta', 'app_settings', 'login_setup', 'notification_channels', 'landing_page', 'website']) {
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
