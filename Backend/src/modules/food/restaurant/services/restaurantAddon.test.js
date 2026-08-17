import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../../config/prisma.js';
import { uniquePhone, uniqueTag } from '../../../../utils/testIds.js';
import {
    listRestaurantAddons,
    createRestaurantAddon,
    updateRestaurantAddon,
    deleteRestaurantAddon,
} from './restaurantAddon.service.js';

/**
 * A restaurant's own add-ons.
 *
 * Two things carry risk here: the draft is a Json column, so a partial write
 * erases the keys it does not mention; and the linked menu items must belong to
 * the restaurant doing the linking.
 */
const live = Boolean(process.env.DATABASE_URL);

const created = { restaurants: [], foods: [], addons: [] };
let restaurantId = null;
let otherRestaurantId = null;

const makeRestaurant = async () => {
    const r = await prisma.foodRestaurant.create({
        data: {
            restaurantName: `Addon ${uniqueTag('R')}`,
            ownerName: 'Owner',
            ownerPhone: uniquePhone('9'),
            status: 'approved',
        },
    });
    created.restaurants.push(r.id);
    return r.id;
};

const makeFood = async (ownerId) => {
    const f = await prisma.foodItem.create({
        data: { restaurantId: ownerId, name: `Dish ${uniqueTag('F')}`, price: 100 },
    });
    created.foods.push(f.id);
    return f.id;
};

const track = async (body) => {
    const a = await createRestaurantAddon(restaurantId, body);
    created.addons.push(a.id);
    return a;
};

test.before(async () => {
    if (!live) return;
    restaurantId = await makeRestaurant();
    otherRestaurantId = await makeRestaurant();
});

test.after(async () => {
    if (!live) return;
    await prisma.foodAddon.deleteMany({ where: { restaurantId: { in: created.restaurants } } });
    await prisma.foodItem.deleteMany({ where: { id: { in: created.foods } } });
    await prisma.foodRestaurant.deleteMany({ where: { id: { in: created.restaurants } } });
    await prisma.$disconnect();
});

test('a new add-on starts as an unpublished draft', { skip: !live }, async () => {
    const addon = await track({
        name: `Extra Cheese ${uniqueTag('A')}`,
        description: 'A generous slice',
        price: 40,
        foodType: 'non-veg',
        images: ['a.png', '', 'b.png'],
    });

    assert.equal(addon.approvalStatus, 'pending');
    assert.ok(addon.requestedAt);
    // Nothing reaches the customer app until an admin approves.
    assert.equal(addon.published, null);
    assert.equal(addon.price, 40);
    assert.equal(addon.foodType, 'non-veg');
    assert.equal(addon.isVeg, false);
    assert.deepEqual(addon.images, ['a.png', 'b.png'], 'blank entries dropped');
    assert.equal(addon.isItemSpecific, false, 'no foodIds means the whole menu');
    assert.equal(addon.group.maxSelect, 1);
});

test('the name is unique per restaurant, ignoring case', { skip: !live }, async () => {
    const name = `Paneer ${uniqueTag('N')}`;
    await track({ name });

    await assert.rejects(() => createRestaurantAddon(restaurantId, { name }), /already exists/);
    // Prisma cannot compare a Json string case-insensitively for equality, so
    // this is the check that would quietly stop working if that were assumed.
    await assert.rejects(
        () => createRestaurantAddon(restaurantId, { name: name.toUpperCase() }),
        /already exists/,
    );

    // A name that merely contains it is a different add-on.
    const longer = await track({ name: `${name} Tikka` });
    assert.ok(longer.id);

    // And another restaurant is free to use the same name.
    const elsewhere = await createRestaurantAddon(otherRestaurantId, { name });
    created.addons.push(elsewhere.id);
    assert.ok(elsewhere.id);

    await assert.rejects(() => createRestaurantAddon(restaurantId, { name: '  ' }), /name is required/);
    await assert.rejects(() => createRestaurantAddon('not-an-id', { name }), /Invalid restaurant id/);
});

test('add-ons can only link to this restaurant\'s own dishes', { skip: !live }, async () => {
    const mine = await makeFood(restaurantId);
    const theirs = await makeFood(otherRestaurantId);

    const addon = await track({ name: `Linked ${uniqueTag('L')}`, foodIds: [mine, mine] });
    assert.deepEqual(addon.foodIds, [mine], 'duplicates collapse');
    assert.equal(addon.isItemSpecific, true);

    // Otherwise a restaurant could hang its add-on off a competitor's dish, at
    // a price that competitor never set.
    await assert.rejects(
        () => createRestaurantAddon(restaurantId, { name: uniqueTag('X'), foodIds: [theirs] }),
        /do not belong to this restaurant/,
    );
    await assert.rejects(
        () => updateRestaurantAddon(restaurantId, addon.id, { foodIds: [mine, theirs] }),
        /do not belong to this restaurant/,
    );
});

test('editing the draft keeps the fields it did not mention', { skip: !live }, async () => {
    const addon = await track({
        name: `Merge ${uniqueTag('M')}`,
        description: 'Original text',
        price: 25,
        image: 'cover.png',
        images: ['one.png'],
    });
    await prisma.foodAddon.update({
        where: { id: addon.id },
        data: { approvalStatus: 'approved', approvedAt: new Date() },
    });

    const updated = await updateRestaurantAddon(restaurantId, addon.id, { draft: { price: 35 } });

    assert.equal(updated.price, 35);
    // The draft is one Json column. Writing only { price } would erase the rest.
    assert.equal(updated.description, 'Original text');
    assert.equal(updated.image, 'cover.png');
    assert.deepEqual(updated.images, ['one.png']);

    // Content changed, so it needs approving again.
    assert.equal(updated.approvalStatus, 'pending');
    assert.equal(updated.approvedAt, null);
});

test('availability and grouping do not force re-approval', { skip: !live }, async () => {
    const addon = await track({ name: `Group ${uniqueTag('G')}` });
    await prisma.foodAddon.update({
        where: { id: addon.id },
        data: { approvalStatus: 'approved', approvedAt: new Date() },
    });

    const updated = await updateRestaurantAddon(restaurantId, addon.id, {
        isAvailable: false,
        group: { name: 'Toppings', minSelect: 1, maxSelect: 3, sortOrder: 2 },
    });

    assert.equal(updated.isAvailable, false);
    assert.equal(updated.group.name, 'Toppings');
    assert.equal(updated.group.maxSelect, 3);
    // Presentation, not content — the live add-on stays live.
    assert.equal(updated.approvalStatus, 'approved');
});

test('a draft edit is validated', { skip: !live }, async () => {
    const addon = await track({ name: `Valid ${uniqueTag('V')}` });

    await assert.rejects(
        () => updateRestaurantAddon(restaurantId, addon.id, { draft: { name: '' } }),
        /name is required/,
    );
    await assert.rejects(
        () => updateRestaurantAddon(restaurantId, addon.id, { draft: { name: 'x'.repeat(201) } }),
        /name is too long/,
    );
    await assert.rejects(
        () => updateRestaurantAddon(restaurantId, addon.id, { draft: { foodType: 'vegan' } }),
        /veg or non-veg/,
    );
    await assert.rejects(
        () => updateRestaurantAddon(restaurantId, addon.id, { draft: { price: -1 } }),
        /Price must be/,
    );

    // An empty update is not an error; it just returns what is there.
    const unchanged = await updateRestaurantAddon(restaurantId, addon.id, {});
    assert.equal(unchanged.id, addon.id);

    // Another restaurant cannot reach it at all.
    assert.equal(await updateRestaurantAddon(otherRestaurantId, addon.id, { isAvailable: false }), null);
});

test('deleting is a soft delete that only works once', { skip: !live }, async () => {
    const addon = await track({ name: `Gone ${uniqueTag('D')}` });

    assert.deepEqual(await deleteRestaurantAddon(restaurantId, addon.id), { id: addon.id });
    assert.equal(await deleteRestaurantAddon(restaurantId, addon.id), null, 'already deleted');
    assert.equal(await deleteRestaurantAddon(otherRestaurantId, addon.id), null);

    const visible = await listRestaurantAddons(restaurantId, { limit: 100 });
    assert.ok(!visible.addons.some((a) => a.id === addon.id));

    const withDeleted = await listRestaurantAddons(restaurantId, { limit: 100, includeDeleted: true });
    assert.ok(withDeleted.addons.some((a) => a.id === addon.id));

    // A deleted name is free again.
    const reused = await track({ name: `Gone ${addon.name.split(' ')[1]}` });
    assert.ok(reused.id);
});

test('the list filters by status and searches the draft name', { skip: !live }, async () => {
    const tag = uniqueTag('Srch');
    const addon = await track({ name: `${tag} Mayo Dip` });

    const bySearch = await listRestaurantAddons(restaurantId, { search: tag.toLowerCase() });
    assert.equal(bySearch.total, 1, 'case-insensitive, through the Json column');
    assert.equal(bySearch.addons[0].id, addon.id);

    const byStatus = await listRestaurantAddons(restaurantId, { status: 'approved', limit: 100 });
    assert.ok(!byStatus.addons.some((a) => a.id === addon.id));

    // An unrecognised status is ignored rather than matching nothing.
    const bogus = await listRestaurantAddons(restaurantId, { status: 'banana', search: tag });
    assert.equal(bogus.total, 1);
});
