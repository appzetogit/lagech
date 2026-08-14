import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../../config/prisma.js';
import { compareAdminPassword } from '../../../../core/auth/adminPassword.util.js';
import {
    createSubAdmin,
    getSubAdmins,
    getSubAdminById,
    updateSubAdminProfile,
    updateSubAdminPermissions,
    updateSubAdminStatus,
    deleteSubAdmin,
} from './adminSubAdmin.service.js';
import { getZones, getZoneById, createZone, updateZone, deleteZone } from './adminZone.service.js';

/**
 * Sub-admin accounts and zone CRUD, the first two domains lifted out of
 * admin.service.js.
 *
 * The password test is the one that matters: Mongoose hashed in a pre('save')
 * hook that went with the model, so a straight port would have stored what the
 * admin typed.
 */
const live = Boolean(process.env.DATABASE_URL);

const created = { admins: [], zones: [] };
const stamp = () => `${Date.now()}${Math.floor(performance.now() * 1000) % 1000}`;

const makeSubAdmin = async (payload = {}) => {
    const admin = await createSubAdmin({
        email: `sub${stamp()}@test.local`,
        password: 'correct horse battery',
        name: 'Sub Admin',
        ...payload,
    });
    created.admins.push(admin.id);
    return admin;
};

test.after(async () => {
    if (!live) return;
    await prisma.foodAdmin.deleteMany({ where: { id: { in: created.admins } } });
    await prisma.foodZone.deleteMany({ where: { id: { in: created.zones } } });
    await prisma.$disconnect();
});

test('a sub-admin password is stored hashed, never in the clear', { skip: !live }, async () => {
    const admin = await makeSubAdmin({ password: 'plaintext-secret' });

    const row = await prisma.foodAdmin.findUnique({ where: { id: admin.id } });
    assert.notEqual(row.password, 'plaintext-secret');
    assert.ok(row.password.startsWith('$2'), 'a bcrypt hash');
    assert.equal(await compareAdminPassword('plaintext-secret', row.password), true);
    assert.equal(await compareAdminPassword('wrong', row.password), false);
});

test('no read returns the password column', { skip: !live }, async () => {
    const admin = await makeSubAdmin();
    assert.equal(admin.password, undefined, 'not from create');
    assert.equal((await getSubAdminById(admin.id)).password, undefined, 'not from a read');

    const { items } = await getSubAdmins({});
    assert.equal(items.find((i) => i.id === admin.id).password, undefined, 'not from the list');

    const updated = await updateSubAdminStatus(admin.id, false);
    assert.equal(updated.password, undefined, 'not from a write');
});

test('a duplicate email is refused', { skip: !live }, async () => {
    const email = `dupe${stamp()}@test.local`;
    await makeSubAdmin({ email });

    await assert.rejects(
        () => makeSubAdmin({ email }),
        /already exists/,
    );
});

test('a new sub-admin starts with no permissions', { skip: !live }, async () => {
    const admin = await makeSubAdmin();
    assert.deepEqual(admin.permissions, {}, 'granted explicitly, never by default');
    assert.equal(admin.adminType, 'sub_admin');
    assert.equal(admin.isActive, true);
});

test('permissions are normalised before being stored', { skip: !live }, async () => {
    const admin = await makeSubAdmin();

    const updated = await updateSubAdminPermissions(admin.id, {
        restaurant_management: ['view', 'EDIT', 'edit'],
        order_management: ['view'],
    });

    // Case-folded and de-duplicated, so the stored grant has one spelling.
    assert.deepEqual(updated.permissions.restaurant_management, ['view', 'edit']);
    assert.deepEqual(updated.permissions.order_management, ['view']);
    // Every known section is present, so a missing key never reads as "allowed".
    assert.deepEqual(updated.permissions.food_management, []);
});

test('an unknown section or action is rejected, not quietly dropped', { skip: !live }, async () => {
    const admin = await makeSubAdmin();

    // Validation runs before sanitisation deliberately: a payload naming
    // something that does not exist is a bug or an attack, and silently
    // trimming it would hide both.
    await assert.rejects(
        () => updateSubAdminPermissions(admin.id, { nonsenseSection: ['view'] }),
        /Invalid permissions payload/,
    );
    await assert.rejects(
        () => updateSubAdminPermissions(admin.id, { order_management: ['launch_missiles'] }),
        /Invalid permissions payload/,
    );

    const untouched = await getSubAdminById(admin.id);
    assert.deepEqual(untouched.permissions, {}, 'a rejected payload changes nothing');
});

test('an invalid permissions payload is refused outright', { skip: !live }, async () => {
    const admin = await makeSubAdmin();
    await assert.rejects(
        () => updateSubAdminPermissions(admin.id, { restaurants: 'view' }),
        /Invalid permissions payload/,
    );
});

test('these endpoints cannot reach a super admin', { skip: !live }, async () => {
    const superAdmin = await prisma.foodAdmin.create({
        data: {
            email: `super${stamp()}@test.local`,
            password: 'hashed-elsewhere',
            adminType: 'super_admin',
        },
    });
    created.admins.push(superAdmin.id);

    // The adminType guard is inside the write, not a check before it, so a
    // super admin's row is unreachable through the sub-admin endpoints.
    await assert.rejects(() => updateSubAdminStatus(superAdmin.id, false), /not found/);
    await assert.rejects(() => deleteSubAdmin(superAdmin.id), /not found/);
    await assert.rejects(
        () => updateSubAdminProfile(superAdmin.id, { name: 'Hijacked' }),
        /not found/,
    );

    const untouched = await prisma.foodAdmin.findUnique({ where: { id: superAdmin.id } });
    assert.equal(untouched.isActive, true);
    assert.equal(untouched.isDeleted, false);
});

test('deleting a sub-admin is a soft delete', { skip: !live }, async () => {
    const admin = await makeSubAdmin();

    const deleted = await deleteSubAdmin(admin.id);
    assert.equal(deleted.isDeleted, true);
    assert.equal(deleted.isActive, false, 'a deleted account cannot still be active');

    // The row survives for the audit trail, but is out of the default list.
    const { items } = await getSubAdmins({});
    assert.ok(!items.some((i) => i.id === admin.id));

    const withDeleted = await getSubAdmins({ includeDeleted: 'true' });
    assert.ok(withDeleted.items.some((i) => i.id === admin.id));

    // And it cannot be edited back to life through the normal endpoints.
    await assert.rejects(() => updateSubAdminStatus(admin.id, true), /not found/);
});

test('sub-admins can be searched and filtered by status', { skip: !live }, async () => {
    const unique = `Findme${stamp()}`;
    const admin = await makeSubAdmin({ name: `${unique} Person` });

    const found = await getSubAdmins({ search: unique });
    assert.equal(found.items.length, 1);
    assert.equal(found.items[0].id, admin.id);

    await updateSubAdminStatus(admin.id, false);
    assert.ok(!(await getSubAdmins({ search: unique, status: 'active' })).items.length);
    assert.equal((await getSubAdmins({ search: unique, status: 'inactive' })).items.length, 1);
});

test('a zone needs a name and at least three points', { skip: !live }, async () => {
    assert.deepEqual(await createZone({ coordinates: [] }), { error: 'Zone name is required' });

    const tooFew = await createZone({
        name: 'Sliver',
        coordinates: [{ latitude: 1, longitude: 1 }, { latitude: 2, longitude: 2 }],
    });
    // Caught here so the admin gets a sentence, not a constraint violation.
    assert.match(tooFew.error, /3 coordinates/);
});

test('a created zone gets its derived boundary', { skip: !live }, async () => {
    const { zone } = await createZone({
        name: `Zone ${stamp()}`,
        coordinates: [
            { latitude: 22.6, longitude: 75.7 },
            { latitude: 22.9, longitude: 75.7 },
            { latitude: 22.9, longitude: 76.0 },
        ],
    });
    created.zones.push(zone.id);

    assert.equal(zone.serviceLocation, zone.name, 'the label defaults to the name');
    assert.equal(zone.country, 'India');
    assert.equal(zone.unit, 'kilometer');

    // coordinates is the editable record; boundary is derived by the trigger and
    // is what zone matching actually queries.
    const [row] = await prisma.$queryRaw`
        SELECT "boundary" IS NOT NULL AS "hasBoundary" FROM "food_zones" WHERE "id" = ${zone.id}
    `;
    assert.equal(row.hasBoundary, true, 'the trigger built the polygon');
});

test('editing the ring re-derives the boundary, a short ring is ignored', { skip: !live }, async () => {
    const { zone } = await createZone({
        name: `Editable ${stamp()}`,
        coordinates: [
            { latitude: 20.0, longitude: 70.0 },
            { latitude: 20.5, longitude: 70.0 },
            { latitude: 20.5, longitude: 70.5 },
        ],
    });
    created.zones.push(zone.id);

    const widened = await updateZone(zone.id, {
        coordinates: [
            { latitude: 20.0, longitude: 70.0 },
            { latitude: 21.0, longitude: 70.0 },
            { latitude: 21.0, longitude: 71.0 },
            { latitude: 20.0, longitude: 71.0 },
        ],
    });
    assert.equal(widened.zone.coordinates.length, 4);

    // A two-point ring would make the zone match nothing, so it is not applied.
    const ignored = await updateZone(zone.id, {
        coordinates: [{ latitude: 1, longitude: 1 }, { latitude: 2, longitude: 2 }],
    });
    assert.equal(ignored.zone.coordinates.length, 4, 'the usable ring survives');
});

test('zones list, filter, and delete cleanly', { skip: !live }, async () => {
    const name = `Listed ${stamp()}`;
    const { zone } = await createZone({
        name,
        isActive: false,
        coordinates: [
            { latitude: 10, longitude: 10 },
            { latitude: 11, longitude: 10 },
            { latitude: 11, longitude: 11 },
        ],
    });
    created.zones.push(zone.id);

    assert.equal((await getZoneById(zone.id)).id, zone.id);
    assert.equal(await getZoneById('a'.repeat(24)), null);

    const inactive = await getZones({ search: name, isActive: 'false' });
    assert.equal(inactive.total, 1);
    assert.equal((await getZones({ search: name, isActive: 'true' })).total, 0);

    assert.deepEqual(await deleteZone(zone.id), { id: zone.id });
    // Deleting one that has already gone is null, not a thrown P2025.
    assert.equal(await deleteZone(zone.id), null);

    created.zones = created.zones.filter((id) => id !== zone.id);
});
