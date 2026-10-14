import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import bcrypt from 'bcryptjs';

import {
    ANY,
    OWNER,
    RESTAURANT_PERMISSION_KEYS,
    RESTAURANT_ROUTE_RULES,
    decideRestaurantRoute,
    hasRestaurantPermission,
    mapLegacyModules,
    redactPayoutDetails,
    sanitizeRestaurantPermissions,
} from './restaurantPermissions.js';
import { compareAdminPassword, normalizeBcryptHash } from './adminPassword.util.js';

/**
 * Restaurant staff permissions without a database: the route table, the
 * per-request decision, payout-detail hiding, the old module names, and old
 * Laravel password hashes.
 */
const owner = { userId: 'a'.repeat(24), role: 'RESTAURANT' };
const staff = (...permissions) => ({ ...owner, employeeId: 'b'.repeat(24), permissions });

test('every protected restaurant route has a staff rule, and every rule a route', () => {
    const source = fs.readFileSync(new URL('../../modules/food/restaurant/routes/restaurant.routes.js', import.meta.url), 'utf8');
    // router.get('/path', authMiddleware, requireRestaurant ... (possibly across lines)
    const routes = [...source.matchAll(/router\.(get|post|put|patch|delete)\(\s*'([^']+)',\s*authMiddleware,\s*requireRestaurant\b/g)]
        .map(([, method, path]) => `${method.toUpperCase()} ${path}`);
    assert.ok(routes.length > 60, `found ${routes.length} protected routes`);
    const missing = routes.filter((key) => !(key in RESTAURANT_ROUTE_RULES));
    assert.deepEqual(missing, [], 'a new protected route needs a line in RESTAURANT_ROUTE_RULES');
    const stale = Object.keys(RESTAURANT_ROUTE_RULES).filter((key) => !routes.includes(key));
    assert.deepEqual(stale, [], 'rules for routes that no longer exist');
    for (const [key, rule] of Object.entries(RESTAURANT_ROUTE_RULES)) {
        if (rule === ANY || rule === OWNER) continue;
        assert.ok(Array.isArray(rule) && rule.length, key);
        for (const permission of rule) assert.ok(RESTAURANT_PERMISSION_KEYS.includes(permission), `${key}: ${permission}`);
    }
});

test('owners pass everywhere; staff only within their role', () => {
    assert.equal(decideRestaurantRoute(owner, 'GET', '/finance').allow, true);
    assert.equal(decideRestaurantRoute(owner, 'DELETE', '/me').allow, true);
    assert.equal(decideRestaurantRoute(owner, 'GET', '/not-in-the-table').allow, true);

    const cook = staff('orders');
    assert.equal(decideRestaurantRoute(cook, 'GET', '/orders').allow, true);
    assert.equal(decideRestaurantRoute(cook, 'PATCH', '/orders/:orderId/status').allow, true);
    assert.equal(decideRestaurantRoute(cook, 'HEAD', '/orders').allow, true, 'HEAD is GET');
    assert.equal(decideRestaurantRoute(cook, 'GET', '/current').allow, true, 'anyone signed in');
    const finance = decideRestaurantRoute(cook, 'GET', '/finance');
    assert.equal(finance.allow, false);
    assert.match(finance.message, /Wallet & finance/);
    assert.equal(decideRestaurantRoute(cook, 'GET', '/employees').allow, false);
    assert.equal(decideRestaurantRoute(cook, 'POST', '/employee-roles').allow, false);
    assert.equal(decideRestaurantRoute(staff(...RESTAURANT_PERMISSION_KEYS), 'DELETE', '/me').allow, false, 'never staff');
    assert.equal(decideRestaurantRoute(cook, 'GET', '/a-route-nobody-listed').allow, false, 'closed by default');
    assert.equal(decideRestaurantRoute(staff(), 'GET', '/orders').allow, false, 'a role with nothing');
});

test('bank and UPI details need the wallet permission, even with store setup', () => {
    const setup = staff('store_setup');
    assert.equal(decideRestaurantRoute(setup, 'PATCH', '/profile', { restaurantName: 'X' }).allow, true);
    assert.equal(decideRestaurantRoute(setup, 'PATCH', '/profile', { accountNumber: '123' }).allow, false);
    assert.equal(decideRestaurantRoute(setup, 'PATCH', '/profile', { upiId: 'a@b' }).allow, false);
    assert.equal(decideRestaurantRoute(staff('store_setup', 'wallet'), 'PATCH', '/profile', { accountNumber: '123' }).allow, true);
    assert.equal(decideRestaurantRoute(setup, 'GET', '/payout-details').allow, false);

    const shown = redactPayoutDetails({
        restaurant: { id: 'r', restaurantName: 'X', accountNumber: '123', ifscCode: 'IFSC', onboarding: { step4: { upiId: 'u', accountHolderName: 'A', panNumber: 'P' } } },
        list: [{ upiQrImage: 'q', name: 'n' }],
        when: new Date(0),
    });
    assert.deepEqual(shown.restaurant, { id: 'r', restaurantName: 'X', onboarding: { step4: { panNumber: 'P' } } });
    assert.deepEqual(shown.list, [{ name: 'n' }]);
    assert.ok(shown.when instanceof Date, 'non-plain values pass through');
});

test('permission keys are cleaned and checked', () => {
    assert.deepEqual(sanitizeRestaurantPermissions(['wallet', 'orders', 'nope', 'orders', null]), ['orders', 'wallet']);
    assert.deepEqual(sanitizeRestaurantPermissions('orders'), []);
    assert.equal(hasRestaurantPermission(owner, 'wallet'), true);
    assert.equal(hasRestaurantPermission(staff('orders'), 'wallet'), false);
    assert.equal(hasRestaurantPermission(staff('orders'), ['wallet', 'orders']), true);
});

test('the old store panel modules map to the new keys', () => {
    // The module list every role in the backup has.
    const legacy = '["dashboard","profile","order","item","addon","category","campaign","coupon","banner","advertisement","advertisement_list","wallet","wallet_method","role","employee","expense_report","disbursement_report","vat_report","store_setup","notification_setup","my_shop","business_plan","reviews","chat"]';
    const { permissions, unknown } = mapLegacyModules(legacy);
    assert.deepEqual(unknown, []);
    assert.deepEqual(permissions, RESTAURANT_PERMISSION_KEYS, 'a full old role is a full role here');

    const partial = mapLegacyModules(['order', 'pos', 'deliveryman', 'item']);
    assert.deepEqual(partial.permissions, ['orders', 'foods']);
    assert.deepEqual(partial.unknown, ['deliveryman']);
    assert.deepEqual(mapLegacyModules('not json'), { permissions: [], unknown: [] });
    assert.deepEqual(mapLegacyModules(null), { permissions: [], unknown: [] });
    assert.deepEqual(mapLegacyModules(['wallet']).permissions, ['wallet', 'withdraws']);
});

test("old Laravel $2y$ password hashes verify; anything else fails cleanly", async () => {
    const hash = bcrypt.hashSync('Secret#123', 4);
    const laravel = hash.replace(/^\$2[ab]\$/, '$2y$');
    assert.ok(laravel.startsWith('$2y$'));
    assert.equal(normalizeBcryptHash(laravel).slice(0, 4), '$2b$');
    assert.equal(await compareAdminPassword('Secret#123', laravel), true);
    assert.equal(await compareAdminPassword('secret#123', laravel), false);
    assert.equal(await compareAdminPassword('Secret#123', hash), true);
    assert.equal(await compareAdminPassword('Secret#123', 'Secret#123'), false, 'plaintext is never compared');
    assert.equal(await compareAdminPassword('Secret#123', ''), false);
    assert.equal(await compareAdminPassword('', laravel), false);
});
