import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../../config/prisma.js';
import {
    serializeFoodVariants,
    getFoodDisplayPrice,
    getFoodDisplayOtherPrice,
    hasFoodVariants,
} from './foodVariant.service.js';
import { resolveOrderCartItems } from '../../orders/helpers/order-cart-items.helper.js';

/**
 * Variants moved from a Json array on FoodItem to their own table, because the
 * checkout price lookup reads them: the customer picks a size, and that row
 * decides what they are charged.
 *
 * The pure serialize/display helpers work on plain objects and need no database.
 * The constraint and checkout tests do.
 */
// ── pure helpers: the read contract must survive the storage change ──

test('rows from the variants relation serialize like the old Json entries', () => {
    // Real rows carry `id` and Decimal prices; the helper has to keep emitting
    // the { id, _id, name, price, otherPrice } shape clients already consume.
    const rows = [
        { id: 'aaaaaaaaaaaaaaaaaaaaaaaa', name: 'Regular', price: 199, otherPrice: 249 },
        { id: 'bbbbbbbbbbbbbbbbbbbbbbbb', name: 'Large', price: 299, otherPrice: 0 },
    ];
    const out = serializeFoodVariants(rows);

    assert.equal(out.length, 2);
    assert.equal(out[0].id, 'aaaaaaaaaaaaaaaaaaaaaaaa');
    assert.equal(out[0]._id, 'aaaaaaaaaaaaaaaaaaaaaaaa');
    assert.equal(out[0].name, 'Regular');
    assert.equal(out[1].otherPrice, 0);
});

test('the display price is the cheapest variant, not the base price', () => {
    const food = { price: 500, variants: [{ id: 'x', name: 'S', price: 199 }, { id: 'y', name: 'L', price: 299 }] };
    assert.equal(getFoodDisplayPrice(food), 199);
    // No variants: fall back to the dish's own price.
    assert.equal(getFoodDisplayPrice({ price: 500, variants: [] }), 500);
});

test('the display strike-through price ignores zeroes', () => {
    const food = { variants: [{ id: 'x', name: 'S', price: 199, otherPrice: 0 }, { id: 'y', name: 'L', price: 299, otherPrice: 349 }] };
    assert.equal(getFoodDisplayOtherPrice(food), 349);
});

test('hasFoodVariants accepts either key the clients send', () => {
    assert.equal(hasFoodVariants({ variants: [{ id: 'x', name: 'S', price: 1 }] }), true);
    assert.equal(hasFoodVariants({ variations: [{ id: 'x', name: 'S', price: 1 }] }), true);
    assert.equal(hasFoodVariants({ variants: [] }), false);
});

// ── the constraints, and the checkout path that reads them ──

let restaurantId;
let foodId;

test.before(async () => {
    const restaurant = await prisma.foodRestaurant.create({
        data: { restaurantName: 'Variant Test Co', ownerName: 'Owner', status: 'approved' },
    });
    restaurantId = restaurant.id;

    const food = await prisma.foodItem.create({
        data: {
            restaurantId,
            name: 'Pizza',
            price: 500,
            approvalStatus: 'approved',
            isAvailable: true,
            variants: {
                create: [
                    { name: 'Regular', price: 199, otherPrice: 249, sortOrder: 0 },
                    { name: 'Large', price: 299, sortOrder: 1 },
                ],
            },
        },
    });
    foodId = food.id;
});

test.after(async () => {
    if (restaurantId) {
        await prisma.foodRestaurant.delete({ where: { id: restaurantId } }).catch(() => {});
    }
    await prisma.$disconnect();
});

test('a variant priced at or below zero is rejected', async () => {
    // normalizeFoodVariantsInput enforced this, but it was the only thing that
    // did — the bulk uploader and admin scripts wrote straight past it.
    await assert.rejects(
        () => prisma.foodItemVariant.create({ data: { foodItemId: foodId, name: 'Free', price: 0 } }),
        /food_item_variant_price_positive/,
    );
});

test('two variants cannot share a name on one dish', async () => {
    // The size picker gives the customer no way to tell them apart.
    await assert.rejects(
        () => prisma.foodItemVariant.create({ data: { foodItemId: foodId, name: 'Large', price: 350 } }),
        /Unique constraint/,
    );
});

test('deleting the dish removes its variants', async () => {
    const throwaway = await prisma.foodItem.create({
        data: {
            restaurantId,
            name: 'Temp Dish',
            price: 100,
            variants: { create: [{ name: 'Only', price: 100 }] },
        },
    });
    await prisma.foodItem.delete({ where: { id: throwaway.id } });

    const orphans = await prisma.foodItemVariant.count({ where: { foodItemId: throwaway.id } });
    assert.equal(orphans, 0);
});

test('checkout prices the chosen variant, not the base price', async () => {
    const large = await prisma.foodItemVariant.findFirst({ where: { foodItemId: foodId, name: 'Large' } });

    const [line] = await resolveOrderCartItems(restaurantId, [
        { itemId: foodId, variantId: large.id, quantity: 2 },
    ]);

    assert.equal(line.price, 299, 'must charge the variant price, not the 500 base');
    assert.equal(line.variantName, 'Large');
    assert.equal(line.variantId, large.id);
});

test('checkout refuses a dish with sizes when none was chosen', async () => {
    await assert.rejects(
        () => resolveOrderCartItems(restaurantId, [{ itemId: foodId, quantity: 1 }]),
        /Please select a size/,
    );
});

test('checkout refuses a variant that no longer exists', async () => {
    await assert.rejects(
        () => resolveOrderCartItems(restaurantId, [
            { itemId: foodId, variantId: 'ffffffffffffffffffffffff', quantity: 1 },
        ]),
        /no longer available in the selected size/,
    );
});
