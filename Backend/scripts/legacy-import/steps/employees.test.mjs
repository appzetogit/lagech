import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../src/config/prisma.js';
import { mapLegacyEmployee, mapLegacyRole } from './employees.mjs';

/**
 * The legacy staff mapping, on rows shaped like the backup's
 * (employee_roles / vendor_employees). No real hashes: a made-up one of the
 * right shape stands in.
 */
const R13 = 'a'.repeat(24);
const ROLE1 = 'b'.repeat(24);
const maps = { restaurants: new Map([['13', R13]]), roles: new Map([['1', ROLE1]]) };
const FULL = '["dashboard","profile","order","item","addon","category","campaign","coupon","banner","advertisement","advertisement_list","wallet","wallet_method","role","employee","expense_report","disbursement_report","vat_report","store_setup","notification_setup","my_shop","business_plan","reviews","chat"]';
const FAKE_HASH = `$2y$10$${'x'.repeat(53)}`;

const role = (over = {}) => ({ id: 1, store_id: '13', name: 'MANAGER', modules: FULL, status: 1, created_at: new Date('2026-06-19T14:16:05Z'), ...over });
const employee = (over = {}) => ({
    id: 3, f_name: 'Ravi', l_name: 'Kumar', phone: '+919876543210', email: 'Ravi@Example.com ', image: '2026-06-19-x.png',
    employee_role_id: '1', vendor_id: '13', store_id: '13', password: FAKE_HASH, status: 1, created_at: new Date('2026-06-19T14:17:44Z'),
    ...over,
});

test.after(() => prisma.$disconnect());

test('a full old role becomes a full role for its restaurant', () => {
    const { data, warnings, skip } = mapLegacyRole(role(), maps);
    assert.equal(skip, undefined);
    assert.deepEqual(warnings, []);
    assert.equal(data.restaurantId, R13);
    assert.equal(data.name, 'MANAGER');
    assert.deepEqual(data.permissions, [
        'dashboard', 'orders', 'foods', 'categories', 'campaigns', 'coupons', 'advertisements', 'reviews',
        'wallet', 'withdraws', 'store_setup', 'chat', 'reports', 'employees',
    ]);
});

test('roles: unknown modules are dropped with a warning; unmapped stores skipped', () => {
    const partial = mapLegacyRole(role({ modules: '["order","deliveryman"]' }), maps);
    assert.deepEqual(partial.data.permissions, ['orders']);
    assert.ok(partial.warnings.some((w) => /deliveryman/.test(w)));
    assert.match(mapLegacyRole(role({ store_id: '99' }), maps).skip, /not imported/);
    assert.match(mapLegacyRole(role({ store_id: null }), maps).skip, /no store/);
    assert.equal(mapLegacyRole(role({ name: ' ' }), maps).skip, 'no name');
    assert.ok(mapLegacyRole(role({ modules: '[]' }), maps).warnings.some((w) => /no permissions/.test(w)));
});

test('an employee keeps their old hash, email lower-cased, phone last ten', () => {
    const { data, warnings, skip, imageFile } = mapLegacyEmployee(employee(), maps);
    assert.equal(skip, undefined);
    assert.deepEqual(warnings, []);
    assert.equal(data.restaurantId, R13);
    assert.equal(data.roleId, ROLE1);
    assert.equal(data.email, 'ravi@example.com');
    assert.equal(data.firstName, 'Ravi');
    assert.equal(data.lastName, 'Kumar');
    assert.equal(data.phone, '+919876543210');
    assert.equal(data.phoneLast10, '9876543210');
    assert.equal(data.password, FAKE_HASH, 'copied as it is; login verifies $2y$');
    assert.equal(data.isActive, true);
    assert.equal(imageFile, '2026-06-19-x.png');
});

test('employees: junk phones are dropped, bad rows skipped', () => {
    const short = mapLegacyEmployee(employee({ phone: '123' }), maps);
    assert.equal(short.data.phone, '');
    assert.equal(short.data.phoneLast10, '');
    assert.ok(short.warnings.some((w) => /not a phone number/.test(w)));
    assert.equal(mapLegacyEmployee(employee({ status: 0 }), maps).data.isActive, false);
    assert.equal(mapLegacyEmployee(employee({ f_name: 'Asha', l_name: 'Asha' }), maps).data.lastName, '', 'name typed twice');
    assert.match(mapLegacyEmployee(employee({ store_id: '99' }), maps).skip, /restaurant 99/);
    assert.match(mapLegacyEmployee(employee({ employee_role_id: '7' }), maps).skip, /role 7/);
    assert.equal(mapLegacyEmployee(employee({ email: 'nope' }), maps).skip, 'no valid email');
    assert.equal(mapLegacyEmployee(employee({ password: 'plain' }), maps).skip, 'password is not a bcrypt hash');
});
