import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';

import { prisma } from '../../../../config/prisma.js';
import { uniquePhone, uniqueTag } from '../../../../utils/testIds.js';
import { generateBulkMenuTemplate, processBulkMenuUpload } from './bulkUpload.service.js';

/**
 * Bulk menu upload, driven by a real spreadsheet.
 *
 * The template this service generates is the input, so a template change that
 * broke the reader would fail here rather than in a restaurant's inbox.
 */
const live = Boolean(process.env.DATABASE_URL);

const created = { restaurants: [], categories: [] };
let restaurantId = null;

/** Build a workbook from the real template and fill in rows. */
const sheetFrom = async (rows) => {
    const workbook = await generateBulkMenuTemplate();
    const sheet = workbook.getWorksheet(1);
    for (const row of rows) sheet.addRow(row);
    return Buffer.from(await workbook.xlsx.writeBuffer());
};

const row = (over = {}) => ({
    category: 'Starters',
    name: `Dish ${uniqueTag('B')}`,
    description: 'Tasty',
    price: 200,
    foodType: 'Veg',
    isRecommended: 'No',
    prepTime: '15-20 mins',
    imageUrl: '',
    ...over,
});

test.before(async () => {
    if (!live) return;
    const r = await prisma.foodRestaurant.create({
        data: {
            restaurantName: `Bulk ${uniqueTag('R')}`,
            ownerName: 'Owner',
            ownerPhone: uniquePhone('9'),
            status: 'approved',
        },
    });
    created.restaurants.push(r.id);
    restaurantId = r.id;
});

test.after(async () => {
    if (!live) return;
    const foods = await prisma.foodItem.findMany({
        where: { restaurantId: { in: created.restaurants } },
        select: { id: true },
    });
    await prisma.foodItemVariant.deleteMany({
        where: { foodItemId: { in: foods.map((f) => f.id) } },
    });
    await prisma.foodItem.deleteMany({ where: { restaurantId: { in: created.restaurants } } });
    await prisma.foodCategory.deleteMany({ where: { restaurantId: { in: created.restaurants } } });
    await prisma.foodRestaurant.deleteMany({ where: { id: { in: created.restaurants } } });
    await prisma.$disconnect();
});

test('a sheet becomes dishes, categories and variant rows', { skip: !live }, async () => {
    const tag = uniqueTag('Cat');
    const plain = row({ category: tag, name: `${tag} Soup` });
    const sized = row({
        category: tag,
        name: `${tag} Pizza`,
        price: 999,
        foodType: 'Non-Veg',
        isRecommended: 'Yes',
        v1Name: 'Small', v1Price: 250,
        v2Name: 'Large', v2Price: 450,
    });

    const result = await processBulkMenuUpload(restaurantId, await sheetFrom([plain, sized]));
    assert.equal(result.success, 2);
    assert.equal(result.failed, 0, JSON.stringify(result.details));

    // The category named in the sheet is created once and reused by both rows.
    const category = await prisma.foodCategory.findFirst({
        where: { name: tag, restaurantId },
    });
    assert.ok(category);

    const pizza = await prisma.foodItem.findFirst({
        where: { restaurantId, name: `${tag} Pizza` },
        include: { variants: { orderBy: { sortOrder: 'asc' } } },
    });
    assert.equal(pizza.categoryId, category.id);
    assert.equal(pizza.categoryName, tag);
    // The Prisma enum member for 'Non-Veg' is NonVeg; the hyphen is a @map.
    assert.equal(pizza.foodType, 'NonVeg');
    assert.equal(pizza.isRecommended, true);
    assert.equal(pizza.preparationTime, '15-20 mins');
    // A dish with sizes is advertised at its cheapest one, not the base price.
    assert.equal(Number(pizza.price), 250);
    // Variants are their own rows now, not an embedded array.
    assert.deepEqual(pizza.variants.map((v) => v.name), ['Small', 'Large']);
    assert.equal(Number(pizza.variants[1].price), 450);

    const soup = await prisma.foodItem.findFirst({ where: { restaurantId, name: `${tag} Soup` } });
    assert.equal(Number(soup.price), 200);
    assert.equal(soup.foodType, 'Veg');
    assert.equal(soup.approvalStatus, 'pending', 'a restaurant upload needs approving');
    assert.ok(soup.requestedAt);
    assert.equal(soup.approvedAt, null);
});

test('re-uploading updates the dish instead of duplicating it', { skip: !live }, async () => {
    const name = `Repeat ${uniqueTag('U')}`;

    await processBulkMenuUpload(restaurantId, await sheetFrom([
        row({ name, price: 100, v1Name: 'Half', v1Price: 60 }),
    ]));

    const second = await processBulkMenuUpload(restaurantId, await sheetFrom([
        row({ name, price: 150, description: 'Now with more' }),
    ]), { approvalStatus: 'approved' });
    assert.equal(second.success, 1);

    const found = await prisma.foodItem.findMany({
        where: { restaurantId, name },
        include: { variants: true },
    });
    assert.equal(found.length, 1, 'matched by name within this restaurant');
    assert.equal(Number(found[0].price), 150);
    assert.equal(found[0].description, 'Now with more');
    // The sizes were dropped from the sheet, so they are dropped from the dish.
    assert.equal(found[0].variants.length, 0);
    // An admin upload is approved on the spot.
    assert.equal(found[0].approvalStatus, 'approved');
    assert.ok(found[0].approvedAt);
    assert.equal(found[0].requestedAt, null);
});

test('the same dish twice in one sheet writes one row', { skip: !live }, async () => {
    const name = `Twice ${uniqueTag('T')}`;

    const result = await processBulkMenuUpload(restaurantId, await sheetFrom([
        row({ name, price: 100 }),
        row({ name, price: 250 }),
    ]));
    assert.equal(result.success, 2);

    const found = await prisma.foodItem.findMany({ where: { restaurantId, name } });
    assert.equal(found.length, 1, 'the second row updates the first');
    assert.equal(Number(found[0].price), 250, 'last one wins');
});

test('a bad row is reported without losing the good ones', { skip: !live }, async () => {
    const good = `Good ${uniqueTag('G')}`;

    const result = await processBulkMenuUpload(restaurantId, await sheetFrom([
        row({ name: good }),
        // No item name: reported, not silently skipped.
        row({ name: '', description: 'Orphan' }),
        // Entirely blank rows are not errors — every sheet has trailing ones.
        {},
    ]));

    assert.equal(result.success, 1);
    assert.equal(result.failed, 1);
    assert.match(result.details[0].error, /Category and Item Name are mandatory/);
    assert.ok(await prisma.foodItem.findFirst({ where: { restaurantId, name: good } }));
});

test('a veg-only category refuses a non-veg row', { skip: !live }, async () => {
    const tag = uniqueTag('Veg');
    const category = await prisma.foodCategory.create({
        data: { name: tag, restaurantId, foodTypeScope: 'Veg', approvalStatus: 'approved' },
    });
    created.categories.push(category.id);

    const result = await processBulkMenuUpload(restaurantId, await sheetFrom([
        row({ category: tag, name: `${tag} Chicken`, foodType: 'Non-Veg' }),
        row({ category: tag, name: `${tag} Salad`, foodType: 'Veg' }),
    ]));

    assert.equal(result.success, 1);
    assert.equal(result.failed, 1);
    assert.match(result.details[0].error, /allows only Veg items/);
});

test('the sheet must have the template columns', { skip: !live }, async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet('Wrong').addRow(['Name', 'Price']);
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

    await assert.rejects(
        () => processBulkMenuUpload(restaurantId, buffer),
        /missing required column/,
    );

    const oneRow = await sheetFrom([row()]);
    const noRows = await sheetFrom([]);

    await assert.rejects(
        () => processBulkMenuUpload('not-an-id', oneRow),
        /Invalid restaurant id/,
    );
    await assert.rejects(
        () => processBulkMenuUpload('a'.repeat(24), oneRow),
        /Restaurant not found/,
    );
    await assert.rejects(
        () => processBulkMenuUpload(restaurantId, noRows),
        /No valid items found/,
    );
});

test('the old template\'s sample row is skipped', { skip: !live }, async () => {
    // Early templates shipped with Paneer Tikka pre-filled, and restaurants
    // uploaded it back untouched.
    const sampleOnly = await sheetFrom([{
        category: 'starters',
        name: 'paneer tikka',
        description: 'spicy marinated paneer grilled to perfection',
        price: 250,
        foodType: 'veg',
        prepTime: '20-25 mins',
        imageUrl: 'https://example.com/paneer.jpg',
        v1Name: 'half', v1Price: 150,
        v2Name: 'full', v2Price: 280,
    }]);

    await assert.rejects(
        () => processBulkMenuUpload(restaurantId, sampleOnly),
        /No valid items found/,
    );
});
