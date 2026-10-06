import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../../config/prisma.js';
import { uniquePhone, uniqueTag } from '../../../../utils/testIds.js';
import { buildTemplate, exportFoods, importFoods } from './adminBulkCatalog.service.js';
import { parseCsv } from '../../shared/sheet.util.js';
import { FOOD_COLUMNS, FOOD_EXPORT_COLUMNS } from './bulkRows.js';

const made = { restaurants: [], categories: [] };

test.after(async () => {
    await prisma.foodItem.deleteMany({ where: { restaurantId: { in: made.restaurants } } });
    await prisma.foodCategory.deleteMany({ where: { id: { in: made.categories }, parentId: { not: null } } });
    await prisma.foodCategory.deleteMany({ where: { id: { in: made.categories } } });
    await prisma.foodRestaurant.deleteMany({ where: { id: { in: made.restaurants } } });
    await prisma.$disconnect();
});

const restaurant = async (extra = {}) => {
    const r = await prisma.foodRestaurant.create({
        data: { restaurantName: uniqueTag('Rest '), ownerName: 'O', ownerPhone: uniquePhone('9'), status: 'approved', ...extra },
    });
    made.restaurants.push(r.id);
    return r;
};

const category = async (extra = {}) => {
    const c = await prisma.foodCategory.create({ data: { name: uniqueTag('Cat '), ...extra } });
    made.categories.push(c.id);
    return c;
};

const csv = (lines) => ({ originalname: 'foods.csv', mimetype: 'text/csv', buffer: Buffer.from(lines.join('\n'), 'utf8') });

const HEAD = 'Id,Name*,Restaurant Id*,Category Id*,Sub Category Id,Price*,Compare-at Price,Food Type (Veg/Non-Veg),Image URL,Nutrition,Available (Yes/No)';

test('food import creates approved dishes, files them under a sub-category and reports bad rows by row number', async () => {
    const r = await restaurant();
    const veg = await restaurant({ pureVegRestaurant: true });
    const top = await category();
    const sub = await category({ parentId: top.id });
    const other = await category();
    const vegOnly = await category({ foodTypeScope: 'Veg' });
    const privateElsewhere = await category({ restaurantId: veg.id });
    const momos = uniqueTag('Momos ');
    const paneer = uniqueTag('Paneer ');

    const report = await importFoods(csv([
        HEAD,
        `,${momos},${r.id},${top.id},${sub.id},120,150,Non-Veg,https://cdn.example.com/m.webp,"Calories 250 kcal, High protein",`,
        `,${paneer},${veg.id},${vegOnly.id},,200,,,,,No`,
        `,${uniqueTag('Bad ')},${r.id},${sub.id},,100,,,,,`,
        `,${uniqueTag('Bad ')},${r.id},${top.id},${sub.id.replace(/./, (c) => (c === 'a' ? 'b' : 'a'))},100,,,,,`,
        `,${uniqueTag('Bad ')},${r.id},${other.id},${sub.id},100,,,,,`,
        `,${uniqueTag('Bad ')},${r.id},${vegOnly.id},,100,,Non-Veg,,,`,
        `,${uniqueTag('Bad ')},${r.id},${privateElsewhere.id},,100,,,,,`,
        `,${momos.toUpperCase()},${r.id},${top.id},,100,,,,,`,
        `,,nope,,,0,,,,,`,
    ]));
    assert.equal(report.created, 2);
    assert.equal(report.updated, 0);
    assert.equal(report.failed, 7);
    assert.deepEqual(report.errors.map((e) => e.row), [4, 5, 6, 7, 8, 9, 10]);
    assert.match(report.errors[0].errors[0], /is a sub-category/);
    assert.match(report.errors[1].errors[0], /No category has this Sub Category Id/);
    assert.match(report.errors[2].errors[0], /not a sub-category of this Category Id/);
    assert.match(report.errors[3].errors[0], /Veg category cannot accept Non-Veg/, 'the admin form\'s diet rule');
    assert.match(report.errors[4].errors[0], /belongs to a different restaurant/);
    assert.match(report.errors[5].errors[0], /already has a dish named/);
    assert.ok(report.errors[6].errors.length >= 4, 'every problem in the row is listed');

    const dish = await prisma.foodItem.findFirst({ where: { restaurantId: r.id, name: momos } });
    assert.equal(dish.approvalStatus, 'approved');
    assert.equal(dish.categoryId, sub.id);
    assert.equal(dish.categoryName, sub.name);
    assert.equal(Number(dish.price), 120);
    assert.equal(Number(dish.otherPrice), 150);
    assert.equal(dish.foodType, 'NonVeg');
    assert.deepEqual(dish.images, ['https://cdn.example.com/m.webp']);
    assert.deepEqual(dish.nutrition, ['Calories 250 kcal', 'High protein']);

    const vegDish = await prisma.foodItem.findFirst({ where: { restaurantId: veg.id, name: paneer } });
    assert.equal(vegDish.foodType, 'Veg', 'a blank food type at a pure veg restaurant is Veg');
    assert.equal(vegDish.isAvailable, false);
});

test('food import updates by Id, approves a pending dish, keeps images when blank and leaves sized prices alone', async () => {
    const r = await restaurant();
    const elsewhere = await restaurant();
    const top = await category();
    const pending = await prisma.foodItem.create({
        data: {
            restaurantId: r.id, name: uniqueTag('Thali '), price: 100, categoryId: top.id, categoryName: top.name,
            image: '/uploads/a.webp', images: ['/uploads/a.webp', '/uploads/b.webp'], approvalStatus: 'pending', requestedAt: new Date(),
        },
    });
    const sized = await prisma.foodItem.create({
        data: {
            restaurantId: r.id, name: uniqueTag('Pizza '), price: 200, categoryId: top.id, categoryName: top.name,
            variants: { create: [{ name: 'Regular', price: 200 }, { name: 'Large', price: 350, sortOrder: 1 }] },
        },
    });
    const renamed = uniqueTag('Veg Thali ');

    const report = await importFoods(csv([
        HEAD,
        `${pending.id},${renamed},${r.id},${top.id},,140,,Veg,,,`,
        `${sized.id},${sized.name},${r.id},${top.id},,999,,,,,No`,
        `${pending.id},${pending.name},${elsewhere.id},${top.id},,140,,,,,`,
        `${'f'.repeat(24)},Ghost,${r.id},${top.id},,140,,,,,`,
    ]));
    assert.equal(report.updated, 2);
    assert.equal(report.failed, 2);
    assert.match(report.errors[0].errors[0], /different restaurant/);
    assert.match(report.errors[1].errors[0], /No dish has this Id/);

    const updated = await prisma.foodItem.findUnique({ where: { id: pending.id } });
    assert.equal(updated.name, renamed);
    assert.equal(Number(updated.price), 140);
    assert.equal(updated.foodType, 'Veg');
    assert.equal(updated.approvalStatus, 'approved');
    assert.ok(updated.approvedAt);
    assert.deepEqual(updated.images, ['/uploads/a.webp', '/uploads/b.webp'], 'a blank Image URL keeps the gallery');

    const stillSized = await prisma.foodItem.findUnique({ where: { id: sized.id }, include: { variants: true } });
    assert.equal(Number(stillSized.price), 200, 'priced from its sizes, not the Price column');
    assert.equal(stillSized.variants.length, 2);
    assert.equal(stillSized.isAvailable, false);
});

test('food export filters by restaurant, category (with its sub-categories), approval and availability', async () => {
    const r = await restaurant();
    const top = await category();
    const sub = await category({ parentId: top.id });
    const elsewhere = await category();
    const inSub = await prisma.foodItem.create({ data: { restaurantId: r.id, name: uniqueTag('A '), price: 50, categoryId: sub.id, categoryName: sub.name } });
    await prisma.foodItem.create({ data: { restaurantId: r.id, name: uniqueTag('B '), price: 60, categoryId: elsewhere.id, categoryName: elsewhere.name } });
    await prisma.foodItem.create({ data: { restaurantId: r.id, name: uniqueTag('C '), price: 70, categoryId: top.id, categoryName: top.name, approvalStatus: 'pending', isAvailable: false } });

    const read = async (query) => {
        const { buffer, filename } = await exportFoods({ format: 'csv', restaurantId: r.id, ...query });
        assert.equal(filename, 'Foods.csv');
        const [headers, ...rows] = parseCsv(buffer.toString('utf8')).filter((row) => row.some(Boolean));
        assert.deepEqual(headers, FOOD_EXPORT_COLUMNS);
        return rows;
    };
    assert.equal((await read({})).length, 3);
    const byCategory = await read({ categoryId: top.id });
    assert.equal(byCategory.length, 2, 'the parent covers its sub-category');
    const subRow = byCategory.find((row) => row[0] === inSub.id);
    assert.equal(subRow[FOOD_COLUMNS.indexOf('Category Id*')], top.id);
    assert.equal(subRow[FOOD_COLUMNS.indexOf('Sub Category Id')], sub.id);
    assert.equal((await read({ approvalStatus: 'pending' })).length, 1);
    assert.equal((await read({ available: 'yes' })).length, 2);

    const template = await buildTemplate('foods', 'csv');
    assert.deepEqual(parseCsv(template.buffer.toString('utf8'))[0], FOOD_COLUMNS);
});
