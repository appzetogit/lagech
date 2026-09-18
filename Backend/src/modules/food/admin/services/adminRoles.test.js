import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../../config/prisma.js';
import {
    createAdminRole,
    createSubAdmin,
    deleteAdminRole,
    listAdminRoles,
    updateAdminRole,
    updateSubAdminPermissions,
} from './adminSubAdmin.service.js';

/**
 * Roles: a named set of pages given to many sub-admins, changed in one place.
 */
const made = { admins: [], roles: [] };
test.after(async () => {
    await prisma.foodAdmin.deleteMany({ where: { id: { in: made.admins } } });
    await prisma.foodAdminRole.deleteMany({ where: { id: { in: made.roles } } });
    await prisma.$disconnect();
});

const stamp = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;

test('editing a role changes every sub-admin on it; custom access detaches one', async () => {
    const role = await createAdminRole({
        name: `Order desk ${stamp()}`,
        accessLevel: 'view',
        menuPaths: ['/admin/food/orders/all'],
        permissions: { order_management: ['view', 'export'] },
    });
    made.roles.push(role.id);

    const make = async () => {
        const admin = await createSubAdmin({ email: `role-${stamp()}@lagech.test`, password: 'Aa1!aaaa', name: 'Role Test', roleId: role.id });
        made.admins.push(admin.id);
        return admin;
    };
    const a = await make();
    const b = await make();
    assert.equal(a.roleId, role.id);
    assert.deepEqual(a.menuPaths, ['/admin/food/orders/all']);
    assert.deepEqual(a.permissions.order_management, ['view', 'export']);

    await updateAdminRole(role.id, {
        menuPaths: ['/admin/food/orders/all', '/admin/food/dispatch'],
        permissions: { order_management: ['view', 'create', 'edit', 'delete', 'export'] },
        accessLevel: 'full',
    });
    const [a2, b2] = await Promise.all([a, b].map((x) => prisma.foodAdmin.findUnique({ where: { id: x.id } })));
    for (const admin of [a2, b2]) {
        assert.deepEqual(admin.menuPaths, ['/admin/food/orders/all', '/admin/food/dispatch'], 'the role change reached them');
        assert.ok(admin.permissions.order_management.includes('edit'));
    }

    // Access set by hand leaves the role; the next role edit no longer touches it.
    await updateSubAdminPermissions(b.id, { customer_management: ['view'] }, null, ['/admin/food/customers']);
    await updateAdminRole(role.id, { menuPaths: ['/admin/food/orders/all'] });
    const b3 = await prisma.foodAdmin.findUnique({ where: { id: b.id } });
    assert.equal(b3.roleId, null);
    assert.deepEqual(b3.menuPaths, ['/admin/food/customers']);

    const listed = (await listAdminRoles()).find((r) => r.id === role.id);
    assert.equal(listed.adminCount, 1);

    await assert.rejects(() => createAdminRole({ name: listed.name }), /already exists/);

    // Deleting the role keeps its admins' access.
    await deleteAdminRole(role.id);
    made.roles = made.roles.filter((id) => id !== role.id);
    const a4 = await prisma.foodAdmin.findUnique({ where: { id: a.id } });
    assert.equal(a4.roleId, null);
    assert.deepEqual(a4.menuPaths, ['/admin/food/orders/all']);
});
