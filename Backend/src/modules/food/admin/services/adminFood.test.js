import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../../config/prisma.js';
import { uniquePhone, uniqueTag } from '../../../../utils/testIds.js';
import {
    getFoods,
    createFood,
    updateFood,
    deleteFood,
    bulkDeleteFoods,
    bulkApproveFoodItems,
} from './adminFood.service.js';

/**
 * Admin dish management.
 *
 * An admin may file a dish under any category and what they create is approved
 * on the spot — both differ from the restaurant-facing path, so both are pinned.
 */
const created = { restaurants: [], categories: [], foods: [], addons: [] };

const makeRestaurant = async (over = {}) => {
    const r = await prisma.foodRestaurant.create({
        data: {
            restaurantName: `Food Admin ${uniqueTag('R')}`,
            ownerName: 'Owner',
            ownerPhone: uniquePhone('9'),
            status: 'approved',
            ...over,
        },
    });
    created.restaurants.push(r.id);
    return r;
};

const makeCategory = async (over = {}) => {
    const c = await prisma.foodCategory.create({
        data: {
            name: `Cat ${uniqueTag('C')}`,
            approvalStatus: 'approved',
            isApproved: true,
            ...over,
        },
    });
    created.categories.push(c.id);
    return c;
};

const track = (food) => {
    created.foods.push(food.id);
    return food;
};

test.after(async () => {
    await prisma.foodAddon.deleteMany({ where: { id: { in: created.addons } } });
    await prisma.foodItem.deleteMany({ where: { restaurantId: { in: created.restaurants } } });
    await prisma.foodCategory.deleteMany({ where: { id: { in: created.categories } } });
    await prisma.foodRestaurant.deleteMany({ where: { id: { in: created.restaurants } } });
    await prisma.$disconnect();
});

test('an admin-created dish is approved immediately', async () => {
    const restaurant = await makeRestaurant();
    const category = await makeCategory();

    const food = track(await createFood({
        restaurantId: restaurant.id,
        name: 'Paneer Tikka',
        price: 220,
        categoryId: category.id,
        foodType: 'Veg',
    }));

    // The restaurant path starts pending; an admin creating it is the approval.
    assert.equal(food.approvalStatus, 'approved');
    assert.equal(food.categoryName, category.name, 'the name is taken from the category');
    assert.equal(Number(food.price), 220);
    assert.equal(food.foodType, 'Veg');
});

test('a dish with sizes is priced from its cheapest', async () => {
    const restaurant = await makeRestaurant();
    const category = await makeCategory();

    const food = track(await createFood({
        restaurantId: restaurant.id,
        name: 'Pizza',
        categoryId: category.id,
        variants: [
            { name: 'Large', price: 449 },
            { name: 'Small', price: 249 },
        ],
    }));

    assert.equal(food.variants.length, 2);
    assert.equal(Number(food.price), 249);
});

test('editing variants keeps the ids of the ones that stayed', async () => {
    const restaurant = await makeRestaurant();
    const category = await makeCategory();

    const food = track(await createFood({
        restaurantId: restaurant.id,
        name: 'Burger',
        categoryId: category.id,
        variants: [{ name: 'Single', price: 149 }, { name: 'Double', price: 249 }],
    }));

    const single = food.variants.find((v) => v.name === 'Single');

    const updated = await updateFood(food.id, {
        variants: [
            { id: single.id, name: 'Single', price: 159 },
            { name: 'Triple', price: 349 },
        ],
    });

    const kept = updated.variants.find((v) => v.name === 'Single');
    // Reissuing every id would break a cart already holding one.
    assert.equal(kept.id, single.id);
    assert.equal(Number(kept.price), 159);
    assert.equal(updated.variants.length, 2, 'Double dropped, Triple added');
    assert.equal(Number(updated.price), 159, 'repriced to the new cheapest');
});

test('a price is required and must be positive', async () => {
    const restaurant = await makeRestaurant();
    const category = await makeCategory();

    const base = { restaurantId: restaurant.id, name: 'Soup', categoryId: category.id };

    await assert.rejects(() => createFood({ ...base, price: 0 }), /greater than 0/);
    await assert.rejects(() => createFood({ ...base, price: -5 }), /greater than 0/);
    await assert.rejects(() => createFood({ ...base }), /greater than 0/);
    await assert.rejects(
        () => createFood({ restaurantId: restaurant.id, price: 10, categoryId: category.id }),
        /name is required/,
    );
});

test('a base price cannot be edited on a dish that has sizes', async () => {
    const restaurant = await makeRestaurant();
    const category = await makeCategory();

    const food = track(await createFood({
        restaurantId: restaurant.id,
        name: 'Thali',
        categoryId: category.id,
        variants: [{ name: 'Regular', price: 199 }],
    }));

    // The base price is derived from the sizes, so setting it directly would
    // silently disagree with them.
    await assert.rejects(() => updateFood(food.id, { price: 99 }), /Update variants instead/);

    // Removing the sizes requires supplying a base price to replace them.
    await assert.rejects(
        () => updateFood(food.id, { variants: [] }),
        /Base price must be greater than 0/,
    );

    const flattened = await updateFood(food.id, { variants: [], price: 149 });
    assert.equal(flattened.variants.length, 0);
    assert.equal(Number(flattened.price), 149);
});

test('a pure veg restaurant cannot be given a non-veg dish', async () => {
    const veg = await makeRestaurant({ pureVegRestaurant: true });
    // The rule is strict: a pure-veg restaurant may only use Veg-scoped
    // categories, not even a 'Both' one.
    const category = await makeCategory({ foodTypeScope: 'Veg' });
    const mixed = await makeCategory({ foodTypeScope: 'Both' });

    await assert.rejects(
        () => createFood({
            restaurantId: veg.id, name: 'Chicken', price: 200,
            categoryId: category.id, foodType: 'Non-Veg',
        }),
        /only use veg foods/,
    );

    await assert.rejects(
        () => createFood({
            restaurantId: veg.id, name: 'Paneer', price: 200,
            categoryId: mixed.id, foodType: 'Veg',
        }),
        /only use veg categories/,
    );

    const ok = track(await createFood({
        restaurantId: veg.id, name: 'Paneer', price: 200,
        categoryId: category.id, foodType: 'Veg',
    }));
    assert.equal(ok.foodType, 'Veg');

    // And the rule holds on edit, not just create.
    await assert.rejects(() => updateFood(ok.id, { foodType: 'Non-Veg' }), /only use veg foods/);
});

test('a category that rejects the diet is refused', async () => {
    const restaurant = await makeRestaurant();
    const vegOnly = await makeCategory({ foodTypeScope: 'Veg' });

    await assert.rejects(
        () => createFood({
            restaurantId: restaurant.id, name: 'Mutton Roll', price: 250,
            categoryId: vegOnly.id, foodType: 'Non-Veg',
        }),
        /cannot accept Non-Veg food/,
    );

    await assert.rejects(
        () => createFood({
            restaurantId: restaurant.id, name: 'Ghost', price: 100,
            categoryId: 'a'.repeat(24),
        }),
        /Category not found/,
    );
    await assert.rejects(
        () => createFood({ restaurantId: restaurant.id, name: 'Nameless', price: 100 }),
        /Category is required/,
    );
});

test('the list joins the restaurant name and filters', async () => {
    const restaurant = await makeRestaurant();
    const category = await makeCategory();
    const unique = uniqueTag('Dish');

    const food = track(await createFood({
        restaurantId: restaurant.id, name: `${unique} Special`,
        price: 100, categoryId: category.id,
    }));

    const bySearch = await getFoods({ search: unique });
    assert.equal(bySearch.total, 1);
    // Was a second query and a Map; restaurantId is a foreign key.
    assert.equal(bySearch.foods[0].restaurantName, restaurant.restaurantName);
    assert.equal(bySearch.foods[0].id, food.id);

    const byRestaurant = await getFoods({ restaurantId: restaurant.id });
    assert.ok(byRestaurant.total >= 1);

    const byStatus = await getFoods({ restaurantId: restaurant.id, approvalStatus: 'pending' });
    assert.equal(byStatus.total, 0, 'admin-created dishes are already approved');
});

test('bulk delete honours the current search when selecting all', async () => {
    const restaurant = await makeRestaurant();
    const category = await makeCategory();
    const unique = uniqueTag('Bulk');

    track(await createFood({ restaurantId: restaurant.id, name: `${unique} One`, price: 10, categoryId: category.id }));
    track(await createFood({ restaurantId: restaurant.id, name: `${unique} Two`, price: 20, categoryId: category.id }));
    const spared = track(await createFood({
        restaurantId: restaurant.id, name: 'Untouched', price: 30, categoryId: category.id,
    }));

    // "Select all" means everything the search matches, not literally every dish.
    const result = await bulkDeleteFoods({ restaurantId: restaurant.id, selectAll: true, search: unique });
    assert.equal(result.deletedCount, 2);

    assert.ok(await prisma.foodItem.findUnique({ where: { id: spared.id } }));

    await assert.rejects(
        () => bulkDeleteFoods({ restaurantId: restaurant.id, foodIds: [] }),
        /No valid food items selected/,
    );
    await assert.rejects(
        () => bulkDeleteFoods({ restaurantId: 'a'.repeat(24), selectAll: true }),
        /Restaurant not found/,
    );
});

test('deleting a dish takes its variants with it', async () => {
    const restaurant = await makeRestaurant();
    const category = await makeCategory();

    const food = track(await createFood({
        restaurantId: restaurant.id, name: 'Doomed', categoryId: category.id,
        variants: [{ name: 'Only', price: 99 }],
    }));

    assert.deepEqual(await deleteFood(food.id), { id: food.id });

    const variants = await prisma.foodItemVariant.count({ where: { foodItemId: food.id } });
    assert.equal(variants, 0, 'cascaded');

    assert.equal(await deleteFood(food.id), null);
    assert.equal(await deleteFood('not-an-id'), null);
});

test('bulk approve clears the queue for dishes and add-ons alike', async () => {
    const restaurant = await makeRestaurant();
    const category = await makeCategory();

    const pendingFood = await prisma.foodItem.create({
        data: {
            restaurantId: restaurant.id,
            categoryId: category.id,
            name: 'Awaiting',
            price: 120,
            approvalStatus: 'pending',
        },
    });
    created.foods.push(pendingFood.id);

    const addon = await prisma.foodAddon.create({
        data: {
            restaurantId: restaurant.id,
            draft: { name: 'Extra Sauce', price: 20 },
            approvalStatus: 'pending',
        },
    });
    created.addons.push(addon.id);

    const result = await bulkApproveFoodItems(restaurant.id);
    assert.ok(result.modifiedCount >= 2);

    const food = await prisma.foodItem.findUnique({ where: { id: pendingFood.id } });
    assert.equal(food.approvalStatus, 'approved');
    assert.ok(food.approvedAt);

    const approvedAddon = await prisma.foodAddon.findUnique({ where: { id: addon.id } });
    assert.equal(approvedAddon.approvalStatus, 'approved');
    // The draft/published copy Mongo did with an aggregation pipeline; Prisma
    // has no column-to-column copy, so each add-on is written individually.
    assert.deepEqual(approvedAddon.published, approvedAddon.draft);
});

test('bulk approve leaves soft-deleted add-ons alone', async () => {
    const restaurant = await makeRestaurant();

    const deleted = await prisma.foodAddon.create({
        data: {
            restaurantId: restaurant.id,
            draft: { name: 'Removed', price: 5 },
            approvalStatus: 'pending',
            isDeleted: true,
        },
    });
    created.addons.push(deleted.id);

    await bulkApproveFoodItems(restaurant.id);

    const row = await prisma.foodAddon.findUnique({ where: { id: deleted.id } });
    assert.equal(row.approvalStatus, 'pending', 'a deleted add-on is not resurrected by an approval sweep');
});
