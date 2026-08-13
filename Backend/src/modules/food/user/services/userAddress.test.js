import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../../config/prisma.js';
import {
    listAddresses,
    addAddress,
    updateAddress,
    deleteAddress,
    setDefaultAddress,
} from './userAddress.service.js';

/**
 * Addresses were an embedded array on FoodUser; they are their own table now,
 * with "exactly one default per customer" enforced by a partial unique index
 * rather than by whatever the last save happened to leave true.
 */
const live = Boolean(process.env.DATABASE_URL);

let userId;

const address = (over = {}) => ({
    label: 'home',
    street: '12 MG Road',
    city: 'Indore',
    state: 'MP',
    latitude: 22.7196,
    longitude: 75.8577,
    ...over,
});

test.before(async () => {
    if (!live) return;
    const user = await prisma.foodUser.create({
        data: { phone: `9${String(Date.now()).slice(-9)}` },
    });
    userId = user.id;
});

test.after(async () => {
    if (!live) return;
    if (userId) await prisma.foodUser.delete({ where: { id: userId } }).catch(() => {});
    await prisma.$disconnect();
});

test('the first address saved becomes the default', { skip: !live }, async () => {
    const { address: first } = await addAddress(userId, address());
    assert.equal(first.isDefault, true);
    assert.equal(first.label, 'Home', 'label is normalised to the enum casing');
});

test('later addresses do not steal the default', { skip: !live }, async () => {
    const { address: second } = await addAddress(userId, address({ label: 'work', street: '9 AB Road' }));
    assert.equal(second.isDefault, false);
    assert.equal(second.label, 'Office', '"work" maps to Office');
});

test('adding a second address of the same label keeps both', { skip: !live }, async () => {
    // Adding used to overwrite any address sharing a label, which capped a
    // customer at three and destroyed the old one silently.
    await addAddress(userId, address({ label: 'other', street: 'First Other' }));
    await addAddress(userId, address({ label: 'other', street: 'Second Other' }));

    const { addresses } = await listAddresses(userId);
    const others = addresses.filter((a) => a.label === 'Other');
    assert.equal(others.length, 2);
});

test('coordinates come back as a usable point', { skip: !live }, async () => {
    const { addresses } = await listAddresses(userId);
    const [first] = addresses;
    assert.equal(first.latitude, 22.7196);
    assert.deepEqual(first.location.coordinates, [75.8577, 22.7196]);
});

test('the database rejects a second default outright', { skip: !live }, async () => {
    const { addresses } = await listAddresses(userId);
    const notDefault = addresses.find((a) => !a.isDefault);

    // Prisma reports P2002 as "Unique constraint failed on the fields: (`userId`)"
    // and does not name the index, so match on the failure rather than its name.
    await assert.rejects(
        () => prisma.userAddress.update({ where: { id: notDefault.id }, data: { isDefault: true } }),
        (err) => err.code === 'P2002' && /Unique constraint/.test(err.message),
    );
});

test('setting a default clears the previous one', { skip: !live }, async () => {
    const before = await listAddresses(userId);
    const target = before.addresses.find((a) => !a.isDefault);

    await setDefaultAddress(userId, target.id);

    const after = await listAddresses(userId);
    const defaults = after.addresses.filter((a) => a.isDefault);
    assert.equal(defaults.length, 1);
    assert.equal(defaults[0].id, target.id);
});

test('another user cannot touch this address', { skip: !live }, async () => {
    const stranger = await prisma.foodUser.create({
        data: { phone: `8${String(Date.now()).slice(-9)}` },
    });
    const { addresses } = await listAddresses(userId);

    // Ownership is part of the lookup, so it reads as "not found" rather than
    // confirming the address exists.
    await assert.rejects(
        () => updateAddress(stranger.id, addresses[0].id, { street: 'hijacked' }),
        /Address not found/,
    );

    await prisma.foodUser.delete({ where: { id: stranger.id } });
});

test('deleting the default promotes the newest survivor', { skip: !live }, async () => {
    const before = await listAddresses(userId);
    const currentDefault = before.addresses.find((a) => a.isDefault);

    await deleteAddress(userId, currentDefault.id);

    const after = await listAddresses(userId);
    const defaults = after.addresses.filter((a) => a.isDefault);
    assert.equal(defaults.length, 1, 'a customer must never be left without a default');
    assert.notEqual(defaults[0].id, currentDefault.id);
});

test('deleting every address leaves none, and does not throw', { skip: !live }, async () => {
    const { addresses } = await listAddresses(userId);
    for (const a of addresses) await deleteAddress(userId, a.id);

    const after = await listAddresses(userId);
    assert.equal(after.addresses.length, 0);
});
