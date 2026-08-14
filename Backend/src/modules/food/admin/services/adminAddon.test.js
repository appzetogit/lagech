import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../../config/prisma.js';
import { uniquePhone, uniqueTag } from '../../../../utils/testIds.js';
import {
    getRestaurantAddonsAdmin,
    updateRestaurantAddonAdmin,
    approveRestaurantAddon,
    rejectRestaurantAddon,
} from './adminAddon.service.js';

/**
 * Add-on approval.
 *
 * The draft/published split is the whole point: a restaurant edits `draft`, the
 * customer app serves `published`, and approving copies one over the other. An
 * edit to a live add-on must not reach customers before an admin sees it.
 */
const live = Boolean(process.env.DATABASE_URL);

const created = { addons: [], restaurants: [] };

const makeRestaurant = async () => {
    const r = await prisma.foodRestaurant.create({
        data: {
            restaurantName: `Addon Rest ${uniqueTag('R')}`,
            ownerName: 'Owner',
            ownerPhone: uniquePhone('9'),
            status: 'approved',
        },
    });
    created.restaurants.push(r.id);
    return r;
};

const makeAddon = async (restaurant, over = {}) => {
    const addon = await prisma.foodAddon.create({
        data: {
            restaurantId: restaurant.id,
            draft: { name: 'Extra Cheese', price: 30, foodType: 'veg' },
            requestedAt: new Date(),
            ...over,
        },
    });
    created.addons.push(addon.id);
    return addon;
};

test.after(async () => {
    if (!live) return;
    await prisma.foodAddon.deleteMany({ where: { id: { in: created.addons } } });
    await prisma.foodRestaurant.deleteMany({ where: { id: { in: created.restaurants } } });
    await prisma.$disconnect();
});

test('approving copies the draft over to published', { skip: !live }, async () => {
    const restaurant = await makeRestaurant();
    const addon = await makeAddon(restaurant);

    // Until approval there is nothing for customers to see.
    assert.equal(addon.published, null);

    const approved = await approveRestaurantAddon(addon.id);
    assert.equal(approved.approvalStatus, 'approved');
    assert.deepEqual(approved.published, approved.draft);
    assert.equal(approved.published.name, 'Extra Cheese');
    assert.ok(approved.approvedAt);
});

test('approving after a rejection clears the old reason', { skip: !live }, async () => {
    const restaurant = await makeRestaurant();
    const addon = await makeAddon(restaurant);

    const rejected = await rejectRestaurantAddon(addon.id, 'Photo is unusable');
    assert.equal(rejected.approvalStatus, 'rejected');
    assert.equal(rejected.rejectionReason, 'Photo is unusable');

    const approved = await approveRestaurantAddon(addon.id);
    // Left set, the add-on would read approved and still carry a rejection.
    assert.equal(approved.rejectionReason, '');
    assert.equal(approved.rejectedAt, null);
});

test('a rejection needs a reason the restaurant can act on', { skip: !live }, async () => {
    const restaurant = await makeRestaurant();
    const addon = await makeAddon(restaurant);

    await assert.rejects(() => rejectRestaurantAddon(addon.id, '   '), /reason is required/);
    await assert.rejects(() => rejectRestaurantAddon(addon.id), /reason is required/);

    // Still pending, since the rejection never happened.
    const row = await prisma.foodAddon.findUnique({ where: { id: addon.id } });
    assert.equal(row.approvalStatus, 'pending');
});

test('editing a pending add-on touches only the draft', { skip: !live }, async () => {
    const restaurant = await makeRestaurant();
    const addon = await makeAddon(restaurant);

    const updated = await updateRestaurantAddonAdmin(addon.id, { price: 45, name: 'Double Cheese' });

    assert.equal(updated.draft.price, 45);
    assert.equal(updated.draft.name, 'Double Cheese');
    // Unmentioned keys survive: the Json column is replaced whole, so the merge
    // has to happen in the service.
    assert.equal(updated.draft.foodType, 'veg');
    assert.equal(updated.published, null, 'nothing is live yet');
});

test('editing a live add-on updates what customers see too', { skip: !live }, async () => {
    const restaurant = await makeRestaurant();
    const addon = await makeAddon(restaurant);
    await approveRestaurantAddon(addon.id);

    const updated = await updateRestaurantAddonAdmin(addon.id, { price: 60 });

    // An admin correcting an already-approved add-on should not have to
    // re-approve their own edit.
    assert.equal(updated.draft.price, 60);
    assert.equal(updated.published.price, 60);
    assert.equal(updated.published.name, 'Extra Cheese', 'other fields are untouched');
});

test('add-on edits are validated', { skip: !live }, async () => {
    const restaurant = await makeRestaurant();
    const addon = await makeAddon(restaurant);

    await assert.rejects(
        () => updateRestaurantAddonAdmin(addon.id, { foodType: 'vegan' }),
        /veg or non-veg/,
    );
    await assert.rejects(
        () => updateRestaurantAddonAdmin(addon.id, { price: -5 }),
        /valid positive number/,
    );
    await assert.rejects(
        () => updateRestaurantAddonAdmin(addon.id, { price: 'free' }),
        /valid positive number/,
    );
});

test('a single image is mirrored into the images list', { skip: !live }, async () => {
    const restaurant = await makeRestaurant();
    const addon = await makeAddon(restaurant);

    const one = await updateRestaurantAddonAdmin(addon.id, { image: 'https://cdn/a.png' });
    assert.deepEqual(one.draft.images, ['https://cdn/a.png']);

    // An explicit list wins, and accepts either strings or { url } entries.
    const many = await updateRestaurantAddonAdmin(addon.id, {
        images: ['https://cdn/b.png', { url: 'https://cdn/c.png' }, null],
    });
    assert.deepEqual(many.draft.images, ['https://cdn/b.png', 'https://cdn/c.png']);
});

test('the queue filters by status, restaurant and search', { skip: !live }, async () => {
    const restaurant = await makeRestaurant();
    const other = await makeRestaurant();

    const unique = uniqueTag('Truffle');
    const mine = await makeAddon(restaurant, { draft: { name: `${unique} Oil`, price: 90 } });
    await makeAddon(other);

    const byRestaurant = await getRestaurantAddonsAdmin({ restaurantId: restaurant.id });
    assert.equal(byRestaurant.total, 1);
    assert.equal(byRestaurant.addons[0].id, mine.id);
    assert.equal(byRestaurant.addons[0].restaurant.name, restaurant.restaurantName);

    // draft is Json, so the name search is a JSON path filter.
    const bySearch = await getRestaurantAddonsAdmin({ search: unique });
    assert.equal(bySearch.total, 1);
    assert.equal(bySearch.addons[0].id, mine.id);

    // And the same search box matches a restaurant name.
    const byRestaurantName = await getRestaurantAddonsAdmin({ search: restaurant.restaurantName });
    assert.ok(byRestaurantName.addons.some((a) => a.id === mine.id));

    await approveRestaurantAddon(mine.id);
    const pending = await getRestaurantAddonsAdmin({ approvalStatus: 'pending', restaurantId: restaurant.id });
    assert.equal(pending.total, 0);
    const approved = await getRestaurantAddonsAdmin({ approvalStatus: 'approved', restaurantId: restaurant.id });
    assert.equal(approved.total, 1);
});

test('a soft-deleted add-on is invisible to every path', { skip: !live }, async () => {
    const restaurant = await makeRestaurant();
    const addon = await makeAddon(restaurant);

    await prisma.foodAddon.update({ where: { id: addon.id }, data: { isDeleted: true } });

    const { total } = await getRestaurantAddonsAdmin({ restaurantId: restaurant.id });
    assert.equal(total, 0);

    // Not just hidden from the list — it cannot be acted on either.
    assert.equal(await approveRestaurantAddon(addon.id), null);
    assert.equal(await rejectRestaurantAddon(addon.id, 'why'), null);
    assert.equal(await updateRestaurantAddonAdmin(addon.id, { price: 1 }), null);
});

test('an unknown add-on id returns null', { skip: !live }, async () => {
    assert.equal(await approveRestaurantAddon('a'.repeat(24)), null);
    assert.equal(await approveRestaurantAddon('not-an-id'), null);
    assert.equal(await rejectRestaurantAddon('a'.repeat(24), 'why'), null);
});
