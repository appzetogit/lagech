import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../../config/prisma.js';
import {
    listRestaurantCategories,
    listPublicCategories,
    createRestaurantCategory,
    updateRestaurantCategory,
    deleteRestaurantCategory,
} from './restaurantCategory.service.js';
import { createRestaurantFood, updateRestaurantFood } from './restaurantFood.service.js';
import { getCategoryStats } from '../../shared/categoryWorkflow.js';
import { uniquePhone } from '../../../../utils/testIds.js';

/**
 * The category/dish cluster.
 *
 * The visibility rules are the fiddly part: a restaurant sees approved global
 * categories plus its own at any approval state, and the menu-builder picker
 * (compact) additionally hides its own unapproved ones. Getting that wrong
 * leaks one restaurant's private categories into another's menu builder.
 */
const live = Boolean(process.env.DATABASE_URL);

const created = { restaurants: [], categories: [], foods: [] };

const makeRestaurant = async (overrides = {}) => {
    const restaurant = await prisma.foodRestaurant.create({
        data: {
            restaurantName: `Cat Test ${Date.now()}${created.restaurants.length}`,
            ownerName: 'Owner',
            ownerPhone: uniquePhone('9'),
            status: 'approved',
            ...overrides,
        },
    });
    created.restaurants.push(restaurant.id);
    return restaurant;
};

const makeCategory = async (data) => {
    const category = await prisma.foodCategory.create({ data });
    created.categories.push(category.id);
    return category;
};

test.after(async () => {
    if (!live) return;
    await prisma.foodItem.deleteMany({ where: { id: { in: created.foods } } });
    await prisma.foodItem.deleteMany({ where: { restaurantId: { in: created.restaurants } } });
    await prisma.foodCategory.deleteMany({ where: { id: { in: created.categories } } });
    await prisma.foodRestaurant.deleteMany({ where: { id: { in: created.restaurants } } });
    await prisma.$disconnect();
});

test('a restaurant sees approved global categories and its own', { skip: !live }, async () => {
    const mine = await makeRestaurant();
    const other = await makeRestaurant();

    const global = await makeCategory({
        name: `Global ${Date.now()}`, approvalStatus: 'approved', isApproved: true,
    });
    const pendingGlobal = await makeCategory({
        name: `Pending Global ${Date.now()}`, approvalStatus: 'pending', isApproved: false,
    });
    const ownPending = await makeCategory({
        name: `Mine ${Date.now()}`, restaurantId: mine.id, createdByRestaurantId: mine.id,
        approvalStatus: 'pending', isApproved: false,
    });
    const theirs = await makeCategory({
        name: `Theirs ${Date.now()}`, restaurantId: other.id, createdByRestaurantId: other.id,
        approvalStatus: 'approved', isApproved: true,
    });

    const { categories } = await listRestaurantCategories(mine.id, { limit: 1000 });
    const ids = new Set(categories.map((c) => c._id));

    assert.ok(ids.has(global.id), 'approved global categories are shared');
    assert.ok(ids.has(ownPending.id), 'its own pending category is visible in the manage list');
    assert.ok(!ids.has(pendingGlobal.id), 'an unapproved global category is not shared yet');
    assert.ok(!ids.has(theirs.id), "another restaurant's private category must never appear");
});

test('the compact picker hides the restaurant\'s own unapproved categories', { skip: !live }, async () => {
    const mine = await makeRestaurant();
    const approved = await makeCategory({
        name: `Ready ${Date.now()}`, restaurantId: mine.id, createdByRestaurantId: mine.id,
        approvalStatus: 'approved', isApproved: true,
    });
    const pending = await makeCategory({
        name: `Waiting ${Date.now()}`, restaurantId: mine.id, createdByRestaurantId: mine.id,
        approvalStatus: 'pending', isApproved: false,
    });

    const { categories } = await listRestaurantCategories(mine.id, { compact: 'true' });
    const ids = new Set(categories.map((c) => c._id));

    assert.ok(ids.has(approved.id));
    // Offering it would let a dish be filed under a category customers cannot see.
    assert.ok(!ids.has(pending.id), 'an unapproved category is not selectable');
});

test('a pure veg restaurant cannot create a non-veg category', { skip: !live }, async () => {
    const veg = await makeRestaurant({ pureVegRestaurant: true });

    await assert.rejects(
        () => createRestaurantCategory(veg.id, { name: 'Chicken', foodTypeScope: 'Non-Veg' }),
        /only create veg categories/,
    );

    const ok = await createRestaurantCategory(veg.id, { name: 'Paneer', foodTypeScope: 'Veg' });
    created.categories.push(ok.id);
    assert.equal(ok.approvalStatus, 'pending', 'a new category starts unapproved');
});

test('editing a visible field sends the category back for approval', { skip: !live }, async () => {
    const mine = await makeRestaurant();
    const category = await createRestaurantCategory(mine.id, {
        name: 'Starters', foodTypeScope: 'Both',
    });
    created.categories.push(category.id);

    await prisma.foodCategory.update({
        where: { id: category.id },
        data: { approvalStatus: 'approved', isApproved: true, approvedAt: new Date() },
    });

    const updated = await updateRestaurantCategory(mine.id, category.id, { name: 'Appetisers' });
    assert.equal(updated.approvalStatus, 'pending');
    // undefined would mean "leave alone" to Prisma, so the stale approval
    // timestamp had to be written as null explicitly.
    assert.equal(updated.approvedAt, null, 'the old approval timestamp is cleared');
});

test('a category in use cannot be deleted', { skip: !live }, async () => {
    const mine = await makeRestaurant();
    const category = await makeCategory({
        name: `Used ${Date.now()}`, restaurantId: mine.id, createdByRestaurantId: mine.id,
        approvalStatus: 'approved', isApproved: true,
    });

    const food = await createRestaurantFood(mine.id, {
        name: 'Fries', price: 99, categoryId: category.id, foodType: 'Veg',
    });
    created.foods.push(food.id);

    await assert.rejects(
        () => deleteRestaurantCategory(mine.id, category.id),
        /has items/,
    );

    await prisma.foodItem.delete({ where: { id: food.id } });
    assert.deepEqual(await deleteRestaurantCategory(mine.id, category.id), { id: category.id });
});

test('a dish cannot be filed under a category that rejects its diet', { skip: !live }, async () => {
    const mine = await makeRestaurant();
    const vegOnly = await makeCategory({
        name: `Veg Only ${Date.now()}`, restaurantId: mine.id, createdByRestaurantId: mine.id,
        approvalStatus: 'approved', isApproved: true, foodTypeScope: 'Veg',
    });

    await assert.rejects(
        () => createRestaurantFood(mine.id, {
            name: 'Chicken Roll', price: 150, categoryId: vegOnly.id, foodType: 'Non-Veg',
        }),
        /cannot accept Non-Veg food/,
    );
});

test('editing variants keeps the ids of the ones that stayed', { skip: !live }, async () => {
    const mine = await makeRestaurant();
    const food = await createRestaurantFood(mine.id, {
        name: 'Pizza',
        foodType: 'Veg',
        variants: [
            { name: 'Small', price: 199 },
            { name: 'Large', price: 349 },
        ],
    });
    created.foods.push(food.id);

    assert.equal(food.variants.length, 2);
    assert.equal(Number(food.price), 199, 'the dish is priced from its cheapest variant');

    const small = food.variants.find((v) => v.name === 'Small');

    const updated = await updateRestaurantFood(mine.id, food.id, {
        variants: [
            { id: small.id, name: 'Small', price: 219 },
            { name: 'Family', price: 499 },
        ],
    });

    const names = updated.variants.map((v) => v.name).sort();
    assert.deepEqual(names, ['Family', 'Small'], 'Large was dropped, Family added');

    const keptSmall = updated.variants.find((v) => v.name === 'Small');
    // Replacing the set wholesale would reissue every id, and a cart already
    // holding one would fail checkout with "that size no longer exists".
    assert.equal(keptSmall.id, small.id, 'an edited variant keeps its id');
    assert.equal(Number(keptSmall.price), 219);
    assert.equal(Number(updated.price), 219, 'the dish reprices to the new cheapest');
});

test('changing a dish sends it back for approval', { skip: !live }, async () => {
    const mine = await makeRestaurant();
    const food = await createRestaurantFood(mine.id, { name: 'Momos', price: 120 });
    created.foods.push(food.id);

    await prisma.foodItem.update({
        where: { id: food.id },
        data: { approvalStatus: 'approved', approvedAt: new Date(), rejectionReason: 'stale' },
    });

    const updated = await updateRestaurantFood(mine.id, food.id, { price: 140 });
    assert.equal(updated.approvalStatus, 'pending');
    assert.equal(updated.approvedAt, null);
    assert.equal(updated.rejectionReason, '');
});

test('toggling availability back on clears the scheduled restock', { skip: !live }, async () => {
    const mine = await makeRestaurant();
    const food = await createRestaurantFood(mine.id, { name: 'Soup', price: 80 });
    created.foods.push(food.id);

    const off = await updateRestaurantFood(mine.id, food.id, {
        isAvailable: false,
        stockOffMode: 'next-business-day',
        stockResumeAt: new Date(Date.now() + 86400000).toISOString(),
    });
    assert.equal(off.isAvailable, false);
    assert.equal(off.stockOffMode, 'next_business_day', 'the hyphenated input maps to the enum');
    assert.ok(off.stockResumeAt);

    const on = await updateRestaurantFood(mine.id, food.id, { isAvailable: true });
    assert.equal(on.isAvailable, true);
    // Left set, a maintenance job would switch the dish off again later.
    assert.equal(on.stockResumeAt, null);
    assert.equal(on.stockOffMode, null);
});

test('public categories only list ones with an approved dish', { skip: !live }, async () => {
    const mine = await makeRestaurant();
    const empty = await makeCategory({
        name: `Empty ${Date.now()}`, approvalStatus: 'approved', isApproved: true,
    });
    const stocked = await makeCategory({
        name: `Stocked ${Date.now()}`, approvalStatus: 'approved', isApproved: true,
    });

    const food = await createRestaurantFood(mine.id, {
        name: 'Biryani', price: 250, categoryId: stocked.id,
    });
    created.foods.push(food.id);
    await prisma.foodItem.update({
        where: { id: food.id },
        data: { approvalStatus: 'approved' },
    });

    const { categories } = await listPublicCategories({ limit: 1000 });
    const ids = new Set(categories.map((c) => c._id));

    assert.ok(ids.has(stocked.id));
    // An empty category is a tab that opens onto nothing.
    assert.ok(!ids.has(empty.id), 'a category with no approved dish is not public');
});

test('category stats count total, veg and approved separately', { skip: !live }, async () => {
    const mine = await makeRestaurant();
    const category = await makeCategory({
        name: `Counted ${Date.now()}`, approvalStatus: 'approved', isApproved: true,
    });

    const veg = await createRestaurantFood(mine.id, {
        name: 'Dal', price: 100, categoryId: category.id, foodType: 'Veg',
    });
    const nonVeg = await createRestaurantFood(mine.id, {
        name: 'Kebab', price: 200, categoryId: category.id, foodType: 'Non-Veg',
    });
    created.foods.push(veg.id, nonVeg.id);
    await prisma.foodItem.update({ where: { id: veg.id }, data: { approvalStatus: 'approved' } });

    const stats = (await getCategoryStats([category.id])).get(category.id);
    assert.equal(stats.totalFoods, 2);
    assert.equal(stats.vegFoods, 1);
    assert.equal(stats.approvedFoods, 1);
});

test('an unknown category id is refused rather than silently dropped', { skip: !live }, async () => {
    const mine = await makeRestaurant();
    await assert.rejects(
        () => createRestaurantFood(mine.id, {
            name: 'Ghost', price: 100, categoryId: 'a'.repeat(24),
        }),
        /Category not found/,
    );
});
