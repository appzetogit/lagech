import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../../config/prisma.js';
import {
    getCategories,
    createCategory,
    approveCategory,
    rejectCategory,
    makeCategoryGlobal,
    updateCategory,
    deleteCategory,
    toggleCategoryStatus,
} from './adminCategory.service.js';
import { uniquePhone } from '../../../../utils/testIds.js';

/**
 * Admin category moderation.
 *
 * The rule worth pinning is what happens to a private category when an admin
 * promotes it: restaurantId is cleared so everyone can use it, but
 * createdByRestaurantId survives so there is still a record of who proposed it.
 */
const live = Boolean(process.env.DATABASE_URL);

const created = { categories: [], restaurants: [], zones: [], foods: [] };
const stamp = () => `${Date.now()}${Math.floor(performance.now() * 1000) % 1000}`;

const makeRestaurant = async () => {
    const r = await prisma.foodRestaurant.create({
        data: {
            restaurantName: `Cat Admin ${stamp()}`,
            ownerName: 'Owner',
            ownerPhone: uniquePhone('9'),
            status: 'approved',
        },
    });
    created.restaurants.push(r.id);
    return r;
};

const makeCategory = async (data) => {
    const category = await prisma.foodCategory.create({ data });
    created.categories.push(category.id);
    return category;
};

test.after(async () => {
    if (!live) return;
    await prisma.foodItem.deleteMany({ where: { id: { in: created.foods } } });
    await prisma.foodCategory.deleteMany({ where: { id: { in: created.categories } } });
    await prisma.foodRestaurant.deleteMany({ where: { id: { in: created.restaurants } } });
    await prisma.foodZone.deleteMany({ where: { id: { in: created.zones } } });
    await prisma.$disconnect();
});

test('an admin-created category is global and live at once', { skip: !live }, async () => {
    const category = await createCategory({ name: `Desserts ${stamp()}` });
    created.categories.push(category.id);

    // The admin creating it is the approval.
    assert.equal(category.approvalStatus, 'approved');
    assert.equal(category.isApproved, true);
    assert.ok(category.approvedAt);
    assert.equal(category.restaurantId, null, 'global: no owning restaurant');
    assert.equal(category.zoneId, null);

    await assert.rejects(() => createCategory({ name: '  ' }), /name is required/);
    await assert.rejects(
        () => createCategory({ name: 'Zoned', zoneId: 'not-an-id' }),
        /Invalid zoneId/,
    );
});

test('a category can be scoped to one zone, or explicitly global', { skip: !live }, async () => {
    const zone = await prisma.foodZone.create({
        data: {
            name: `Cat Zone ${stamp()}`,
            coordinates: [
                { latitude: 10, longitude: 10 },
                { latitude: 11, longitude: 10 },
                { latitude: 11, longitude: 11 },
            ],
        },
    });
    created.zones.push(zone.id);

    const zoned = await createCategory({ name: `Zoned ${stamp()}`, zoneId: zone.id });
    created.categories.push(zoned.id);
    assert.equal(zoned.zoneId, zone.id);

    // The string 'global' means "no zone", not a zone called global.
    const global = await createCategory({ name: `Global ${stamp()}`, zoneId: 'global' });
    created.categories.push(global.id);
    assert.equal(global.zoneId, null);

    const byZone = await getCategories({ zoneId: zone.id, limit: 1000 });
    assert.ok(byZone.categories.some((c) => c._id === zoned.id));
    assert.ok(!byZone.categories.some((c) => c._id === global.id));

    const onlyGlobal = await getCategories({ zoneId: 'global', limit: 1000 });
    assert.ok(onlyGlobal.categories.some((c) => c._id === global.id));
    assert.ok(!onlyGlobal.categories.some((c) => c._id === zoned.id));
});

test('approving a category clears the previous rejection', { skip: !live }, async () => {
    const restaurant = await makeRestaurant();
    const category = await makeCategory({
        name: `Pending ${stamp()}`,
        restaurantId: restaurant.id,
        approvalStatus: 'pending',
        isApproved: false,
    });

    const rejected = await rejectCategory(category.id, 'Name is misleading');
    assert.equal(rejected.approvalStatus, 'rejected');
    assert.equal(rejected.rejectionReason, 'Name is misleading');
    // The proposer is backfilled on the first admin action.
    assert.equal(rejected.createdByRestaurantId, restaurant.id);

    const approved = await approveCategory(category.id);
    assert.equal(approved.approvalStatus, 'approved');
    // undefined would have left the rejection in place alongside the approval.
    assert.equal(approved.rejectedAt, null);
    assert.equal(approved.rejectionReason, '');
});

test('a global category cannot be rejected', { skip: !live }, async () => {
    const category = await createCategory({ name: `Platform ${stamp()}` });
    created.categories.push(category.id);

    // There is no proposer to reject — it is the platform's own.
    await assert.rejects(
        () => rejectCategory(category.id, 'no'),
        /Only restaurant-created categories/,
    );
});

test('promoting a category keeps the proposer and drops the owner', { skip: !live }, async () => {
    const restaurant = await makeRestaurant();
    const category = await makeCategory({
        name: `Promotable ${stamp()}`,
        restaurantId: restaurant.id,
        approvalStatus: 'approved',
        isApproved: true,
    });

    const global = await makeCategoryGlobal(category.id);

    assert.equal(global.restaurantId, null, 'every restaurant can use it now');
    assert.equal(global.createdByRestaurantId, restaurant.id, 'but the record of who proposed it survives');
    assert.equal(global.zoneId, null, 'a global category is not zone-bound');
    assert.ok(global.globalizedAt);

    // Promoting again is a no-op rather than an error.
    const again = await makeCategoryGlobal(global.id);
    assert.equal(again.id, global.id);
});

test('an unapproved category cannot be promoted', { skip: !live }, async () => {
    const restaurant = await makeRestaurant();
    const category = await makeCategory({
        name: `Unapproved ${stamp()}`,
        restaurantId: restaurant.id,
        approvalStatus: 'pending',
        isApproved: false,
    });

    await assert.rejects(() => makeCategoryGlobal(category.id), /Only approved categories/);
});

test('narrowing the diet scope is refused while dishes conflict', { skip: !live }, async () => {
    const restaurant = await makeRestaurant();
    const category = await makeCategory({ name: `Mixed ${stamp()}`, foodTypeScope: 'Both' });

    const food = await prisma.foodItem.create({
        data: {
            restaurantId: restaurant.id,
            categoryId: category.id,
            name: 'Chicken Roll',
            price: 150,
            foodType: 'NonVeg',
        },
    });
    created.foods.push(food.id);

    await assert.rejects(
        () => updateCategory(category.id, { foodTypeScope: 'Veg' }),
        /1 food item\(s\) outside the selected diet scope/,
    );

    // Widening is always fine.
    const widened = await updateCategory(category.id, { foodTypeScope: 'Both' });
    assert.equal(widened.foodTypeScope, 'Both');
});

test('deleting a category detaches its dishes rather than orphaning them', { skip: !live }, async () => {
    const restaurant = await makeRestaurant();
    const category = await makeCategory({ name: `Doomed ${stamp()}` });

    const food = await prisma.foodItem.create({
        data: {
            restaurantId: restaurant.id,
            categoryId: category.id,
            categoryName: 'Doomed',
            name: 'Orphan Dish',
            price: 100,
        },
    });
    created.foods.push(food.id);

    assert.deepEqual(await deleteCategory(category.id), { id: category.id });

    // categoryId is a foreign key, so the dish must be detached in the same
    // transaction — it survives, uncategorised.
    const after = await prisma.foodItem.findUnique({ where: { id: food.id } });
    assert.equal(after.categoryId, null);
    assert.equal(after.categoryName, '');

    assert.equal(await deleteCategory(category.id), null);
    created.categories = created.categories.filter((id) => id !== category.id);
});

test('the list filters by approval status and search', { skip: !live }, async () => {
    const restaurant = await makeRestaurant();
    const unique = `Filt${stamp()}`;

    const pending = await makeCategory({
        name: `${unique} Pending`,
        restaurantId: restaurant.id,
        approvalStatus: 'pending',
        isApproved: false,
    });
    const approved = await makeCategory({
        name: `${unique} Approved`,
        approvalStatus: 'approved',
        isApproved: true,
    });

    const all = await getCategories({ search: unique, limit: 1000 });
    assert.equal(all.total, 2);
    // The list carries dish counts.
    assert.ok(all.categories.every((c) => typeof c.itemCount === 'number'));

    const onlyPending = await getCategories({ search: unique, approvalStatus: 'pending' });
    assert.equal(onlyPending.total, 1);
    assert.equal(onlyPending.categories[0]._id, pending.id);

    const byFlag = await getCategories({ search: unique, isApproved: true });
    assert.equal(byFlag.total, 1);
    assert.equal(byFlag.categories[0]._id, approved.id);
});

test('toggling a category flips its visibility', { skip: !live }, async () => {
    const category = await createCategory({ name: `Toggle ${stamp()}` });
    created.categories.push(category.id);

    assert.equal((await toggleCategoryStatus(category.id)).isActive, false);
    assert.equal((await toggleCategoryStatus(category.id)).isActive, true);

    assert.equal(await toggleCategoryStatus('a'.repeat(24)), null);
    assert.equal(await approveCategory('not-an-id'), null);
    assert.equal(await updateCategory('a'.repeat(24), {}), null);
});
