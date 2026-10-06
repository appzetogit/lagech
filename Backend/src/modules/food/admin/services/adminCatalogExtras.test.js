import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../../config/prisma.js';
import { uniquePhone, uniqueTag } from '../../../../utils/testIds.js';
import { listFoodReviews, setFoodReviewHidden } from './adminFoodReviews.service.js';
import { getRestaurantReviews } from '../../restaurant/services/restaurantReviews.service.js';
import { createAddonCategory, deleteAddonCategory, setAddonCategory } from './adminAddonCategory.service.js';
import { getRestaurantAddonsAdmin } from './adminAddon.service.js';
import { saveRecommendedRestaurants, listRecommendedRestaurants } from './adminRecommendedRestaurants.service.js';
import { listApprovedRestaurants } from '../../restaurant/services/restaurant.service.js';
import { importCategories, importRestaurants } from './adminBulkCatalog.service.js';
import { listFoodGallery } from './adminFoodGallery.service.js';

const made = { restaurants: [], users: [], categories: [], addonCategories: [], phones: [] };

test.after(async () => {
    await prisma.foodRestaurant.updateMany({ where: { id: { in: made.restaurants } }, data: { isRecommended: false } });
    await prisma.foodOrder.deleteMany({ where: { restaurantId: { in: made.restaurants } } });
    await prisma.foodAddon.deleteMany({ where: { restaurantId: { in: made.restaurants } } });
    await prisma.foodItem.deleteMany({ where: { restaurantId: { in: made.restaurants } } });
    await prisma.foodRestaurantOutletTimings.deleteMany({ where: { restaurantId: { in: made.restaurants } } });
    await prisma.foodRestaurant.deleteMany({ where: { OR: [{ id: { in: made.restaurants } }, { ownerPhone: { in: made.phones } }] } });
    await prisma.foodUser.deleteMany({ where: { id: { in: made.users } } });
    await prisma.foodCategory.deleteMany({ where: { id: { in: made.categories }, parentId: { not: null } } });
    await prisma.foodCategory.deleteMany({ where: { id: { in: made.categories } } });
    await prisma.foodAddonCategory.deleteMany({ where: { id: { in: made.addonCategories } } });
    await prisma.$disconnect();
});

const restaurant = async (extra = {}) => {
    const r = await prisma.foodRestaurant.create({
        data: { restaurantName: uniqueTag('Rest '), ownerName: 'O', ownerPhone: uniquePhone('9'), status: 'approved', ...extra },
    });
    made.restaurants.push(r.id);
    return r;
};

const csv = (text, name = 'rows.csv') => ({ originalname: name, mimetype: 'text/csv', buffer: Buffer.from(text, 'utf8') });

test('a hidden dish review leaves the admin list filter and the public restaurant reviews', async () => {
    const r = await restaurant();
    const dish = await prisma.foodItem.create({ data: { restaurantId: r.id, name: uniqueTag('Dish '), price: 100, image: '/uploads/d.webp' } });
    const user = await prisma.foodUser.create({ data: { phone: uniquePhone('5'), name: 'neha sharma' } });
    made.users.push(user.id);
    const order = await prisma.foodOrder.create({
        data: {
            userId: user.id, restaurantId: r.id, orderStatus: 'delivered', paymentMethod: 'cash',
            addrStreet: '1 Street', addrCity: 'Indore', addrState: 'MP', subtotal: 100, total: 100,
            restaurantRating: 1, restaurantRatingComment: 'rude words', restaurantRatedAt: new Date(),
            itemRatings: { create: [{ itemId: dish.id, name: dish.name, rating: 1, comment: 'rude words' }] },
        },
        include: { itemRatings: true },
    });
    const ratingId = order.itemRatings[0].id;

    const listed = await listFoodReviews({ restaurantId: r.id });
    assert.equal(listed.reviews.length, 1);
    assert.equal(listed.reviews[0].customerName, 'Neha S.');
    assert.equal(listed.reviews[0].dishImage, '/uploads/d.webp');
    assert.equal((await getRestaurantReviews(r.id)).reviews.length, 1);

    await setFoodReviewHidden(ratingId, true);
    assert.equal((await listFoodReviews({ restaurantId: r.id, visibility: 'visible' })).reviews.length, 0);
    assert.equal((await listFoodReviews({ restaurantId: r.id, visibility: 'hidden' })).summary.hidden, 1);
    assert.equal((await getRestaurantReviews(r.id)).reviews.length, 0, 'the order review is hidden with it');

    await setFoodReviewHidden(ratingId, false);
    assert.equal((await getRestaurantReviews(r.id)).reviews.length, 1);
    await assert.rejects(() => setFoodReviewHidden(ratingId, 'yes'), /hide or show/);

    const gallery = await listFoodGallery({ restaurantId: r.id });
    assert.equal(gallery.foods[0].id, dish.id);
});

test('add-ons can be filed under a category and filtered by it', async () => {
    const r = await restaurant();
    const category = await createAddonCategory({ name: uniqueTag('Drinks ') });
    made.addonCategories.push(category.id);
    await assert.rejects(() => createAddonCategory({ name: category.name.toUpperCase() }), /already exists/);
    const addon = await prisma.foodAddon.create({ data: { restaurantId: r.id, draft: { name: 'Cola', price: 40 }, foodIds: [] } });

    await setAddonCategory(addon.id, category.id);
    const filtered = await getRestaurantAddonsAdmin({ restaurantId: r.id, categoryId: category.id });
    assert.equal(filtered.addons[0].category.name, category.name);
    assert.equal((await getRestaurantAddonsAdmin({ restaurantId: r.id, categoryId: 'none' })).total, 0);

    await deleteAddonCategory(category.id);
    const after = await prisma.foodAddon.findUnique({ where: { id: addon.id } });
    assert.equal(after.categoryId, null, 'deleting the category keeps the add-on');
});

test('recommended restaurants are saved in order and filter the public list', async () => {
    const a = await restaurant();
    const b = await restaurant();
    const pending = await restaurant({ status: 'pending' });
    await assert.rejects(() => saveRecommendedRestaurants([pending.id]), /approved/);

    const before = (await listRecommendedRestaurants()).restaurants.map((r) => r.id);
    await saveRecommendedRestaurants([...before, b.id, a.id]);
    const list = (await listRecommendedRestaurants()).restaurants.map((r) => r.id);
    assert.deepEqual(list.slice(-2), [b.id, a.id]);

    const publicList = await listApprovedRestaurants({ recommended: 'true', limit: 1000 });
    const ids = publicList.restaurants.map((r) => r.id);
    assert.ok(ids.indexOf(b.id) < ids.indexOf(a.id), 'shown in the admin\'s order');
    assert.ok(publicList.restaurants.every((r) => r.isRecommended === true));
    await saveRecommendedRestaurants(before);
});

test('category import creates, updates and reports bad rows', async () => {
    const top = uniqueTag('Top ');
    const sub = uniqueTag('Sub ');
    const first = await importCategories(csv(`Name*,Parent Category,Food Type (Veg/Non-Veg/Both)\n${top},,Veg\n${sub},${top},Veg\n,,\n${top},,\nBad,Nowhere,\n`));
    assert.equal(first.created, 2);
    assert.equal(first.failed, 2);
    assert.deepEqual(first.errors.map((e) => e.row), [5, 6]);
    const rows = await prisma.foodCategory.findMany({ where: { name: { in: [top, sub] } } });
    made.categories.push(...rows.map((c) => c.id));
    const parent = rows.find((c) => c.name === top);
    assert.equal(rows.find((c) => c.name === sub).parentId, parent.id);

    const second = await importCategories(csv(`Id,Name*,Sort Order\n${parent.id},${top},7\n`));
    assert.equal(second.updated, 1);
    assert.equal((await prisma.foodCategory.findUnique({ where: { id: parent.id } })).sortOrder, 7);
    await assert.rejects(() => importCategories(csv('Title\nx\n')), /missing column/);
});

test('restaurant import creates approved restaurants and rejects a phone already in use', async () => {
    const phone = uniquePhone('8');
    made.phones.push(phone);
    const result = await importRestaurants(csv(
        `Restaurant Name*,Owner Name*,Owner Phone*\n${uniqueTag('Imp ')},Asha,${phone}\n${uniqueTag('Imp ')},Ravi,${phone}\nNo owner,,9000000000\n`,
    ));
    assert.equal(result.created, 1);
    assert.equal(result.failed, 2);
    const created = await prisma.foodRestaurant.findFirst({ where: { ownerPhone: phone } });
    assert.equal(created.status, 'approved');

    const again = await importRestaurants(csv(`Restaurant Name*,Owner Name*,Owner Phone*\n${uniqueTag('Imp ')},Asha,${phone}\n`));
    assert.match(again.errors[0].errors[0], /already exists/);
});
