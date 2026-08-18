import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../../config/prisma.js';
import { uniquePhone, uniqueTag } from '../../../../utils/testIds.js';
import {
    listPendingFoodApprovals,
    approveFoodItem,
    rejectFoodItem,
} from './foodApproval.service.js';

/**
 * The admin approval queue for dishes and add-ons.
 */
const created = { restaurants: [], foods: [], addons: [] };
let restaurantId = null;
let restaurantName = null;

const makeFood = async (over = {}) => {
    const food = await prisma.foodItem.create({
        data: {
            restaurantId,
            name: `Dish ${uniqueTag('F')}`,
            price: 199,
            approvalStatus: 'pending',
            requestedAt: new Date(),
            ...over,
        },
    });
    created.foods.push(food.id);
    return food;
};

test.before(async () => {
    restaurantName = `Approvals ${uniqueTag('R')}`;
    const r = await prisma.foodRestaurant.create({
        data: {
            restaurantName,
            ownerName: 'Owner',
            ownerPhone: uniquePhone('9'),
            status: 'approved',
        },
    });
    created.restaurants.push(r.id);
    restaurantId = r.id;
});

test.after(async () => {
    await prisma.foodItemVariant.deleteMany({ where: { foodItemId: { in: created.foods } } });
    await prisma.foodItem.deleteMany({ where: { id: { in: created.foods } } });
    await prisma.foodAddon.deleteMany({ where: { id: { in: created.addons } } });
    await prisma.foodRestaurant.deleteMany({ where: { id: { in: created.restaurants } } });
    await prisma.$disconnect();
});

test('the queue merges dishes and add-ons', async () => {
    const food = await makeFood({ categoryName: 'Starters', foodType: 'NonVeg' });
    const addon = await prisma.foodAddon.create({
        data: {
            restaurantId,
            draft: { name: 'Extra cheese', price: 30, images: ['https://cdn/cheese.png'] },
            approvalStatus: 'pending',
            requestedAt: new Date(),
        },
    });
    created.addons.push(addon.id);

    const { requests, total } = await listPendingFoodApprovals({ restaurantId });

    const dishRow = requests.find((r) => r.id === food.id);
    assert.equal(dishRow.entityType, 'food');
    assert.equal(dishRow.restaurantName, restaurantName);
    // The Prisma enum member is NonVeg; the panel shows the hyphenated form.
    assert.equal(dishRow.foodType, 'Non-Veg');
    assert.equal(dishRow.restaurantId.length, 5, 'shortened for display');

    const addonRow = requests.find((r) => r.id === addon.id);
    assert.equal(addonRow.entityType, 'addon');
    assert.equal(addonRow.itemName, 'Extra cheese');
    assert.equal(addonRow.price, 30);
    assert.equal(addonRow.image, 'https://cdn/cheese.png', 'falls back to the first gallery image');

    // The old code reported the merged page length here, so the table believed
    // there was never a second page.
    assert.ok(total >= 2);
});

test('the queue is searchable by dish and category', async () => {
    const tag = uniqueTag('Q');
    const food = await makeFood({ name: `${tag} Paneer Tikka`, categoryName: 'Grill' });

    const byName = await listPendingFoodApprovals({ restaurantId, search: tag.toLowerCase() });
    assert.ok(byName.requests.some((r) => r.id === food.id), 'case-insensitive');

    const byOther = await listPendingFoodApprovals({ restaurantId, search: 'nothing-matches-this' });
    assert.ok(!byOther.requests.some((r) => r.id === food.id));
});

test('approving stamps the dish and clears any old rejection', async () => {
    const food = await makeFood({
        approvalStatus: 'pending',
        rejectionReason: 'Blurry photo',
        rejectedAt: new Date(),
    });

    const approved = await approveFoodItem(food.id);
    assert.equal(approved.approvalStatus, 'approved');
    assert.ok(approved.approvedAt);
    assert.equal(approved.rejectionReason, '', 'the old reason does not linger');
    assert.equal(approved.rejectedAt, null);
});

test('a dish can only be decided once', async () => {
    const food = await makeFood();

    assert.ok(await approveFoodItem(food.id));
    // The status is part of the filter, so a second admin clicking approve or
    // reject on an already-decided dish changes nothing.
    assert.equal(await approveFoodItem(food.id), null);
    assert.equal(await rejectFoodItem(food.id, 'Too late'), null);

    const after = await prisma.foodItem.findUnique({ where: { id: food.id } });
    assert.equal(after.approvalStatus, 'approved');
});

test('a rejection needs a reason and drops out of the queue', async () => {
    const food = await makeFood();

    await assert.rejects(() => rejectFoodItem(food.id, '   '), /Rejection reason is required/);
    await assert.rejects(() => rejectFoodItem(food.id, 'x'.repeat(501)), /too long/);
    await assert.rejects(() => rejectFoodItem('not-an-id', 'Bad photo'), /Invalid food id/);
    await assert.rejects(() => approveFoodItem('not-an-id'), /Invalid food id/);

    const rejected = await rejectFoodItem(food.id, '  Photo does not match the dish  ');
    assert.equal(rejected.approvalStatus, 'rejected');
    assert.equal(rejected.rejectionReason, 'Photo does not match the dish');
    assert.equal(rejected.approvedAt, null);

    const { requests } = await listPendingFoodApprovals({ restaurantId });
    assert.ok(!requests.some((r) => r.id === food.id));
});
