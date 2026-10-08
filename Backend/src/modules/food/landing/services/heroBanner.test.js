import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../../config/prisma.js';
import { uniquePhone, uniqueTag } from '../../../../utils/testIds.js';
import { testPatch } from '../../../../utils/testGeo.js';
import {
    createHeroBanner,
    updateHeroBanner,
    deleteHeroBanner,
    listHeroBanners,
    listPublicHeroBanners,
    setHeroBannerFeatured,
} from './heroBanner.service.js';
import { getPublicHeroBannersController } from '../controllers/publicLanding.controller.js';

/**
 * Home banners as the old Banners page had them: a zone, a type (store wise /
 * item wise / default link) with its target, and a Featured switch -- and the
 * public list filtered to the customer's zone.
 */
const HERE = testPatch(43);
const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
);
const image = () => ({ originalname: 'b.png', mimetype: 'image/png', buffer: PNG });

const created = { zones: [], restaurants: [], foods: [], categories: [], banners: [] };
let zoneId = null;
let otherZoneId = null;
let restaurantId = null;
let foodId = null;

const make = async (body) => {
    const banner = await createHeroBanner(image(), body);
    created.banners.push(banner.id);
    return banner;
};

/** Call the public controller the way Express would, and return its payload. */
const publicList = async (query) => {
    let payload = null;
    const res = {
        status() { return this; },
        json(body) { payload = body; return this; },
    };
    await getPublicHeroBannersController({ query }, res, (err) => { throw err; });
    return payload.data;
};

test.before(async () => {
    const tag = uniqueTag('Banner');
    const zone = await prisma.foodZone.create({ data: { name: `${tag} Zone`, coordinates: HERE.ring } });
    const other = await prisma.foodZone.create({ data: { name: `${tag} Other`, coordinates: testPatch(44).ring } });
    created.zones.push(zone.id, other.id);
    zoneId = zone.id;
    otherZoneId = other.id;

    const restaurant = await prisma.foodRestaurant.create({
        data: { restaurantName: `${tag} Kitchen`, ownerName: 'Owner', ownerPhone: uniquePhone('9'), status: 'approved', zoneId },
    });
    created.restaurants.push(restaurant.id);
    restaurantId = restaurant.id;
    const category = await prisma.foodCategory.create({ data: { name: `${tag} Mains`, restaurantId, approvalStatus: 'approved' } });
    created.categories.push(category.id);
    const food = await prisma.foodItem.create({
        data: { restaurantId, categoryId: category.id, categoryName: category.name, name: `${tag} Thali`, price: 120, approvalStatus: 'approved' },
    });
    created.foods.push(food.id);
    foodId = food.id;
});

test.after(async () => {
    for (const id of created.banners) await deleteHeroBanner(id);
    await prisma.foodItem.deleteMany({ where: { id: { in: created.foods } } });
    await prisma.foodCategory.deleteMany({ where: { id: { in: created.categories } } });
    await prisma.foodRestaurant.deleteMany({ where: { id: { in: created.restaurants } } });
    await prisma.foodZone.deleteMany({ where: { id: { in: created.zones } } });
    await prisma.$disconnect();
});

test('each banner type needs its target, and the target must exist', async () => {
    await assert.rejects(createHeroBanner(null, { bannerType: 'link' }), /image is required/);
    await assert.rejects(createHeroBanner(image(), { bannerType: 'store' }), /restaurant, food or link/);
    await assert.rejects(createHeroBanner(image(), { bannerType: 'restaurant' }), /Select the restaurant/);
    await assert.rejects(createHeroBanner(image(), { bannerType: 'restaurant', restaurantId: 'aaaaaaaaaaaaaaaaaaaaaaaa' }), /does not exist/);
    await assert.rejects(createHeroBanner(image(), { bannerType: 'food' }), /Select the dish/);
    await assert.rejects(createHeroBanner(image(), { bannerType: 'link', ctaLink: 'javascript:alert(1)' }), /http/);
    await assert.rejects(createHeroBanner(image(), { bannerType: 'link', zoneId: 'aaaaaaaaaaaaaaaaaaaaaaaa' }), /zone does not exist/);
});

test('a restaurant banner, a dish banner and a link banner keep their own target only', async () => {
    const store = await make({ title: 'Store', bannerType: 'restaurant', restaurantId, zoneId, isFeatured: 'true' });
    assert.deepEqual(store.linkedRestaurantIds, [restaurantId]);
    assert.equal(store.linkedFoodId, null);
    assert.equal(store.zoneId, zoneId);
    assert.equal(store.isFeatured, true);
    assert.equal(store.isActive, true);

    const dish = await make({ title: 'Dish', bannerType: 'food', linkedFoodId: foodId, linkedRestaurantIds: JSON.stringify([restaurantId]) });
    assert.equal(dish.linkedFoodId, foodId);
    assert.deepEqual(dish.linkedRestaurantIds, [], 'a dish banner does not also open a restaurant');
    assert.equal(dish.zoneId, null, 'no zone = every zone');

    const link = await make({ title: 'Link', bannerType: 'link', ctaLink: 'https://example.com/offer', zoneId: otherZoneId });
    assert.equal(link.ctaLink, 'https://example.com/offer');

    const listed = (await listHeroBanners()).filter((b) => created.banners.includes(b.id));
    const byTitle = Object.fromEntries(listed.map((b) => [b.title, b]));
    assert.equal(byTitle.Store.zoneName.endsWith('Zone'), true);
    assert.equal(byTitle.Store.linkedRestaurantNames.length, 1);
    assert.equal(byTitle.Dish.linkedFood.id, foodId);
});

test('editing changes the type and target and keeps the rest', async () => {
    const banner = await make({ title: 'Before', bannerType: 'restaurant', restaurantId, zoneId });
    const updated = await updateHeroBanner(banner.id, null, { bannerType: 'food', linkedFoodId: foodId });
    assert.equal(updated.title, 'Before');
    assert.equal(updated.zoneId, zoneId);
    assert.equal(updated.bannerType, 'food');
    assert.deepEqual(updated.linkedRestaurantIds, []);
    assert.equal(updated.imageUrl, banner.imageUrl, 'no new file, same image');

    const replaced = await updateHeroBanner(banner.id, image(), { zoneId: 'all' });
    assert.notEqual(replaced.imageUrl, banner.imageUrl);
    assert.equal(replaced.zoneId, null);

    assert.equal(await updateHeroBanner('aaaaaaaaaaaaaaaaaaaaaaaa', null, {}), null);
    assert.equal((await setHeroBannerFeatured(banner.id, true)).isFeatured, true);
});

test('the public list shows every-zone banners plus the customer zone\'s own', async () => {
    const mine = await make({ title: 'Mine', bannerType: 'restaurant', restaurantId, zoneId });
    const theirs = await make({ title: 'Theirs', bannerType: 'link', zoneId: otherZoneId });
    const everywhere = await make({ title: 'Everywhere', bannerType: 'food', linkedFoodId: foodId });
    const off = await make({ title: 'Off', bannerType: 'link', zoneId, isActive: 'false' });

    const ids = (rows) => rows.map((b) => b.id).filter((id) => [mine.id, theirs.id, everywhere.id, off.id].includes(id));

    const byZone = await listPublicHeroBanners({ zoneId });
    assert.deepEqual(new Set(ids(byZone)), new Set([mine.id, everywhere.id]));

    // Resolved from the customer's coordinates, like the restaurant list.
    const atPoint = await publicList({ lat: String(HERE.lat), lng: String(HERE.lng) });
    assert.deepEqual(new Set(ids(atPoint.banners)), new Set([mine.id, everywhere.id]));
    assert.equal(atPoint.zoneId, zoneId);
    const row = atPoint.banners.find((b) => b.id === everywhere.id);
    // Existing fields unchanged, new ones additive.
    assert.ok(row.imageUrl);
    assert.ok(Array.isArray(row.linkedRestaurants));
    assert.equal(row.bannerType, 'food');
    assert.equal(row.linkedFood.id, foodId);
    assert.equal(typeof row.linkedFood.price, 'number');
    const store = atPoint.banners.find((b) => b.id === mine.id);
    assert.deepEqual(store.linkedRestaurantIds, [restaurantId]);
    assert.equal(store.linkedRestaurants[0].id, restaurantId);

    // No zone known: every active banner, as before zones existed.
    const all = await publicList({});
    assert.deepEqual(new Set(ids(all.banners)), new Set([mine.id, theirs.id, everywhere.id]));

    // A point outside every zone is out of service.
    const nowhere = await publicList({ lat: '-60', lng: '-120' });
    assert.equal(nowhere.outOfService, true);
    assert.deepEqual(nowhere.banners, []);

    const featuredOnly = await listPublicHeroBanners({ zoneId, featured: true });
    assert.deepEqual(ids(featuredOnly), []);
});
