import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../../config/prisma.js';
import { testPatch } from '../../../../utils/testGeo.js';
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
import { listPublicCategories } from '../../restaurant/services/restaurantCategory.service.js';
import { categoryAllowsFoodType, normalizeCategoryFoodTypeScope } from '../../shared/categoryWorkflow.js';
import { getAdminCategories, searchUnified } from '../../search/services/search.service.js';
import { uniquePhone } from '../../../../utils/testIds.js';

/**
 * Admin category moderation.
 *
 * The rule worth pinning is what happens to a private category when an admin
 * promotes it: restaurantId is cleared so everyone can use it, but
 * createdByRestaurantId survives so there is still a record of who proposed it.
 */
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
    await prisma.foodItem.deleteMany({ where: { id: { in: created.foods } } });
    // Sub-categories first: parentId is ON DELETE RESTRICT, so a parent cannot
    // go while a child still points at it.
    await prisma.foodCategory.deleteMany({
        where: { id: { in: created.categories }, parentId: { not: null } },
    });
    await prisma.foodCategory.deleteMany({ where: { id: { in: created.categories } } });
    await prisma.foodRestaurant.deleteMany({ where: { id: { in: created.restaurants } } });
    await prisma.foodZone.deleteMany({ where: { id: { in: created.zones } } });
    await prisma.$disconnect();
});

test('an admin-created category is global and live at once', async () => {
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

test('a category can be scoped to one zone, or explicitly global', async () => {
    const zone = await prisma.foodZone.create({
        data: {
            name: `Cat Zone ${stamp()}`,
            coordinates: testPatch(1).ring,
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

test('approving a category clears the previous rejection', async () => {
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

test('a global category cannot be rejected', async () => {
    const category = await createCategory({ name: `Platform ${stamp()}` });
    created.categories.push(category.id);

    // There is no proposer to reject — it is the platform's own.
    await assert.rejects(
        () => rejectCategory(category.id, 'no'),
        /Only restaurant-created categories/,
    );
});

test('promoting a category keeps the proposer and drops the owner', async () => {
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

test('an unapproved category cannot be promoted', async () => {
    const restaurant = await makeRestaurant();
    const category = await makeCategory({
        name: `Unapproved ${stamp()}`,
        restaurantId: restaurant.id,
        approvalStatus: 'pending',
        isApproved: false,
    });

    await assert.rejects(() => makeCategoryGlobal(category.id), /Only approved categories/);
});

test('narrowing the diet scope is refused while dishes conflict', async () => {
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

test('deleting a category detaches its dishes rather than orphaning them', async () => {
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

test('the list filters by approval status and search', async () => {
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

test('toggling a category flips its visibility', async () => {
    const category = await createCategory({ name: `Toggle ${stamp()}` });
    created.categories.push(category.id);

    assert.equal((await toggleCategoryStatus(category.id)).isActive, false);
    assert.equal((await toggleCategoryStatus(category.id)).isActive, true);

    assert.equal(await toggleCategoryStatus('a'.repeat(24)), null);
    assert.equal(await approveCategory('not-an-id'), null);
    assert.equal(await updateCategory('a'.repeat(24), {}), null);
});

test('a Non-Veg category can be created, and reads back as Non-Veg', async () => {
    // Prisma's member is NonVeg; the API says Non-Veg. Writing the API spelling
    // used to throw, and reading used to fall back to 'Both' -- which also let a
    // Non-Veg category accept veg dishes.
    const category = await createCategory({ name: `Grill House ${stamp()}`, foodTypeScope: 'Non-Veg' });
    created.categories.push(category.id);

    const listed = (await getCategories({ search: category.name })).categories[0];
    assert.equal(listed.foodTypeScope, 'Non-Veg');
    assert.equal(categoryAllowsFoodType(category.foodTypeScope, 'Veg'), false);
    assert.equal(categoryAllowsFoodType(category.foodTypeScope, 'Non-Veg'), true);

    const widened = await updateCategory(category.id, { foodTypeScope: 'Both' });
    assert.equal(widened.foodTypeScope, 'Both');
    const narrowed = await updateCategory(category.id, { foodTypeScope: 'Non-Veg' });
    assert.equal(normalizeCategoryFoodTypeScope(narrowed.foodTypeScope), 'Non-Veg');
});

// ─── sub-categories ──────────────────────────────────────────────────────────

test('a sub-category takes its parent zone and is listed under it', async () => {
    const zone = await prisma.foodZone.create({
        data: { name: `Sub Zone ${stamp()}`, coordinates: testPatch(2).ring },
    });
    created.zones.push(zone.id);

    const parent = await createCategory({ name: `Hotel VEG ${stamp()}`, zoneId: zone.id, foodTypeScope: 'Veg' });
    created.categories.push(parent.id);

    // Zone is ignored for a child: it is visible exactly where its parent is.
    const child = await createCategory({ name: `Starter ${stamp()}`, parentId: parent.id, zoneId: 'global' });
    created.categories.push(child.id);

    assert.equal(child.parentId, parent.id);
    assert.equal(child.zoneId, zone.id);
    assert.equal(child.foodTypeScope, 'Veg', 'scope defaults to the parent');

    const roots = await getCategories({ parentId: 'root', limit: 1000 });
    assert.ok(roots.categories.some((c) => c._id === parent.id));
    assert.ok(!roots.categories.some((c) => c._id === child.id), 'root excludes sub-categories');

    const allSubs = await getCategories({ parentId: 'sub', limit: 1000 });
    assert.ok(allSubs.categories.some((c) => c._id === child.id));
    assert.ok(allSubs.categories.every((c) => c.isSubCategory), "'sub' lists only sub-categories");

    const underParent = await getCategories({ parentId: parent.id });
    assert.equal(underParent.total, 1);
    assert.equal(underParent.categories[0].parentName, parent.name);
    assert.equal(underParent.categories[0].isSubCategory, true);

    const listedParent = roots.categories.find((c) => c._id === parent.id);
    assert.equal(listedParent.childCount, 1);
});

test('the tree is one level, under an approved global parent', async () => {
    const parent = await createCategory({ name: `Root ${stamp()}` });
    created.categories.push(parent.id);
    const child = await createCategory({ name: `Child ${stamp()}`, parentId: parent.id });
    created.categories.push(child.id);

    await assert.rejects(
        () => createCategory({ name: 'Grandchild', parentId: child.id }),
        /one level deep/,
    );
    await assert.rejects(() => createCategory({ name: 'X', parentId: 'nope' }), /Invalid parentId/);
    await assert.rejects(
        () => createCategory({ name: 'X', parentId: 'a'.repeat(24) }),
        /Parent category not found/,
    );

    const restaurant = await makeRestaurant();
    const privateParent = await makeCategory({
        name: `Private ${stamp()}`, restaurantId: restaurant.id, approvalStatus: 'approved',
    });
    await assert.rejects(
        () => createCategory({ name: 'X', parentId: privateParent.id }),
        /global parent/,
    );

    const pendingParent = await makeCategory({ name: `Pending root ${stamp()}`, approvalStatus: 'pending' });
    await assert.rejects(
        () => createCategory({ name: 'X', parentId: pendingParent.id }),
        /must be approved/,
    );

    await assert.rejects(
        () => updateCategory(parent.id, { parentId: parent.id }),
        /its own parent/,
    );
});

test('a sub-category must fit inside its parent diet scope', async () => {
    const vegParent = await createCategory({ name: `Veg root ${stamp()}`, foodTypeScope: 'Veg' });
    created.categories.push(vegParent.id);

    await assert.rejects(
        () => createCategory({ name: 'Chicken', parentId: vegParent.id, foodTypeScope: 'Non-Veg' }),
        /Non-Veg sub-category cannot sit under a Veg category/,
    );

    // Narrowing a parent is refused while a child would fall outside it.
    const bothParent = await createCategory({ name: `Both root ${stamp()}`, foodTypeScope: 'Both' });
    created.categories.push(bothParent.id);
    const meatChild = await createCategory({
        name: `Grill ${stamp()}`, parentId: bothParent.id, foodTypeScope: 'Non-Veg',
    });
    created.categories.push(meatChild.id);

    await assert.rejects(
        () => updateCategory(bothParent.id, { foodTypeScope: 'Veg' }),
        /1 sub-category is outside the selected diet scope/,
    );
});

test('moving a parent to another zone carries its sub-categories along', async () => {
    const zone = await prisma.foodZone.create({
        data: { name: `Move Zone ${stamp()}`, coordinates: testPatch(3).ring },
    });
    created.zones.push(zone.id);

    const parent = await createCategory({ name: `Mover ${stamp()}` });
    created.categories.push(parent.id);
    const child = await createCategory({ name: `Moved ${stamp()}`, parentId: parent.id });
    created.categories.push(child.id);

    await updateCategory(parent.id, { zoneId: zone.id });
    const after = await prisma.foodCategory.findUnique({ where: { id: child.id } });
    assert.equal(after.zoneId, zone.id);

    // A child's own zone field cannot pull it away from its parent.
    const stubborn = await updateCategory(child.id, { zoneId: 'global' });
    assert.equal(stubborn.zoneId, zone.id);
});

test('a parent cannot become a child, and a child can be made top-level again', async () => {
    const a = await createCategory({ name: `A ${stamp()}` });
    created.categories.push(a.id);
    const b = await createCategory({ name: `B ${stamp()}` });
    created.categories.push(b.id);
    const underA = await createCategory({ name: `Under A ${stamp()}`, parentId: a.id });
    created.categories.push(underA.id);

    await assert.rejects(
        () => updateCategory(a.id, { parentId: b.id }),
        /with sub-categories cannot itself become a sub-category/,
    );

    const restaurant = await makeRestaurant();
    const privateCat = await makeCategory({ name: `Mine ${stamp()}`, restaurantId: restaurant.id });
    await assert.rejects(
        () => updateCategory(privateCat.id, { parentId: b.id }),
        /Only global categories can be sub-categories/,
    );

    // null detaches; leaving parentId out of the body leaves it alone.
    const renamed = await updateCategory(underA.id, { name: `Renamed ${stamp()}` });
    assert.equal(renamed.parentId, a.id);
    const detached = await updateCategory(underA.id, { parentId: null });
    assert.equal(detached.parentId, null);
});

test('a category with sub-categories cannot be deleted until they are gone', async () => {
    const parent = await createCategory({ name: `Keeper ${stamp()}` });
    created.categories.push(parent.id);
    const child = await createCategory({ name: `Kept ${stamp()}`, parentId: parent.id });
    created.categories.push(child.id);

    await assert.rejects(() => deleteCategory(parent.id), /Delete or move its 1 sub-category first/);

    assert.deepEqual(await deleteCategory(child.id), { id: child.id });
    assert.deepEqual(await deleteCategory(parent.id), { id: parent.id });
    created.categories = created.categories.filter((id) => id !== parent.id && id !== child.id);
});

test('the customer app sees parents only, and a parent covers its sub-category dishes', async () => {
    const restaurant = await makeRestaurant();

    const parent = await createCategory({ name: `Tabbed ${stamp()}` });
    created.categories.push(parent.id);
    const child = await createCategory({ name: `Inner ${stamp()}`, parentId: parent.id });
    created.categories.push(child.id);

    // The only dish sits one level down.
    const food = await prisma.foodItem.create({
        data: {
            restaurantId: restaurant.id,
            categoryId: child.id,
            name: 'Paneer Tikka',
            price: 220,
            foodType: 'Veg',
            approvalStatus: 'approved',
        },
    });
    created.foods.push(food.id);

    const chips = await getAdminCategories();
    assert.ok(chips.some((c) => c.id === parent.id));
    assert.ok(!chips.some((c) => c.id === child.id), 'sub-categories are not app tabs');

    // Without the child rule, this parent has no dish of its own and would vanish.
    const tabs = await listPublicCategories({ limit: 1000 });
    assert.ok(tabs.categories.some((c) => c._id === parent.id));
    assert.ok(!tabs.categories.some((c) => c._id === child.id));

    const byParent = await searchUnified({ categoryId: parent.id, limit: 50 });
    const restaurants = byParent?.data?.restaurants || [];
    assert.ok(
        restaurants.some((r) => String(r.id || r._id) === restaurant.id),
        'filtering by the parent finds the restaurant whose dish is in the sub-category',
    );
});
