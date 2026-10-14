import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../src/config/prisma.js';
import { ADMIN_PERMISSION_SECTIONS } from '../../../src/constants/permissions.js';
import { isBcryptHash, mapLegacyAdmin, mapRoleModules } from './adminStaff.mjs';

/**
 * Old 6amMart roles and admins, as the backup holds them (the role module
 * lists are the backup's own).
 */
test.after(() => prisma.$disconnect());

const FULL = ['view', 'create', 'edit', 'delete', 'export'];
const granted = (permissions) => Object.entries(permissions).filter(([, actions]) => actions.length).map(([s]) => s).sort();

test('"Order Manage": orders, riders and restaurants, plus the dashboard', () => {
    const { data, notGranted, unknown } = mapRoleModules('["deliveryman","order","store"]');
    assert.deepEqual(granted(data.permissions), ['dashboard', 'delivery_management', 'order_management', 'restaurant_management']);
    assert.deepEqual(data.permissions.order_management, FULL);
    assert.deepEqual(data.permissions.system_settings, [], 'nothing outside the role');
    assert.equal(data.accessLevel, 'full');
    assert.ok(data.menuPaths.includes('/admin/food'));
    assert.ok(data.menuPaths.includes('/admin/food/orders/all'));
    assert.ok(data.menuPaths.includes('/admin/food/delivery-partners'));
    assert.ok(data.menuPaths.includes('/admin/food/restaurants'));
    assert.ok(!data.menuPaths.includes('/admin/food/coupons'));
    assert.deepEqual(notGranted, []);
    assert.deepEqual(unknown, []);
});

test('the wide role: employee management and settings are never granted', () => {
    const { data, notGranted, unknown } = mapRoleModules(JSON.stringify([
        'collect_cash', 'addon', 'attribute', 'advertisement', 'banner', 'campaign', 'category', 'coupon', 'cashback',
        'customer_management', 'deliveryman', 'disbursement', 'provide_dm_earning', 'employee', 'item', 'notification',
        'order', 'store', 'report', 'withdraw_list', 'zone', 'module', 'parcel', 'pos', 'unit', 'subscription', 'brand',
        'common_condition',
    ]));
    const sections = granted(data.permissions);
    assert.ok(!sections.includes('system_settings'));
    assert.ok(!('sub_admin_management' in data.permissions), 'not grantable at all');
    assert.ok(!data.menuPaths.some((p) => p.startsWith('/admin/food/employees')));
    for (const section of ['point_of_sale', 'food_management', 'promotions_management', 'banner_management',
        'customer_management', 'transaction_management', 'report_management']) {
        assert.ok(sections.includes(section), section);
    }
    assert.ok(data.menuPaths.includes('/admin/food/chattings'), 'customer management covers live chat');
    assert.equal(notGranted.length, 4, notGranted.join('; '));
    assert.deepEqual(unknown, []);
    for (const path of data.menuPaths) assert.match(path, /^\/admin\/food(\/|$)/);
    for (const section of Object.keys(data.permissions)) assert.ok(ADMIN_PERMISSION_SECTIONS.includes(section));
});

test('an unknown module is reported; an empty or broken list gives the dashboard only', () => {
    assert.deepEqual(mapRoleModules('["store","teleport"]').unknown, ['teleport']);
    for (const raw of [null, '', 'not json', '{}']) {
        const { data } = mapRoleModules(raw);
        assert.deepEqual(granted(data.permissions), ['dashboard'], String(raw));
        assert.deepEqual(data.menuPaths, ['/admin/food']);
    }
});

const HASH = `$2y$10$${'a'.repeat(53)}`;
const role = { id: 'r'.repeat(24), permissions: { order_management: ['view'] }, menuPaths: ['/admin/food/orders/all'] };
const admin = (over = {}) => ({
    id: 2, f_name: 'Gauri', l_name: 'Mane', phone: '918208318432', email: ' GauriMane@Gmail.com ',
    image: 'x.jpg', password: HASH, role_id: 3, zone_id: 1, created_at: new Date('2026-05-28T07:33:21Z'), ...over,
});

test('an old admin becomes a sub-admin on the imported role, with the old hash', () => {
    const { data, skip } = mapLegacyAdmin(admin(), role, '/uploads/legacy/admin/x.jpg');
    assert.equal(skip, undefined);
    assert.equal(data.email, 'gaurimane@gmail.com');
    assert.equal(data.name, 'Gauri Mane');
    assert.equal(data.phone, '8208318432');
    assert.equal(data.password, HASH, 'kept as the old panel wrote it');
    assert.equal(data.adminType, 'sub_admin');
    assert.equal(data.role, 'ADMIN');
    assert.equal(data.roleId, role.id);
    assert.deepEqual(data.permissions.order_management, ['view']);
    assert.deepEqual(data.menuPaths, ['/admin/food/orders/all']);
    assert.equal(data.isActive, true);
});

test('an admin that cannot sign in is skipped, never imported with a bad password', () => {
    assert.match(mapLegacyAdmin(admin({ password: 'plaintext' }), role).skip, /not a bcrypt hash/);
    assert.match(mapLegacyAdmin(admin({ email: 'nope' }), role).skip, /email/);
    assert.match(mapLegacyAdmin(admin(), null).skip, /role 3 was not imported/);
    assert.ok(isBcryptHash(`$2a$12$${'b'.repeat(53)}`));
    assert.ok(!isBcryptHash(`$2x$10$${'a'.repeat(53)}`));
    assert.ok(!isBcryptHash(`$2y$10$${'a'.repeat(52)}`));
});
