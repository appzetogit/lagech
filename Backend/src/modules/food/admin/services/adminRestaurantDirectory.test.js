import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../../config/prisma.js';
import { uniquePhone, uniqueTag } from '../../../../utils/testIds.js';
import {
    getRestaurants,
    getRestaurantById,
    getRestaurantMenuById,
    updateRestaurantMenuById,
} from './adminRestaurantDirectory.service.js';

/**
 * The admin restaurant directory.
 *
 * The active/inactive filter is the interesting one: FoodRestaurant has no
 * isActive column and never did, so in Mongo the filter matched everything and
 * both dashboard counts equalled the total.
 */
const created = { restaurants: [], zones: [], categories: [], foods: [] };

const makeRestaurant = async (over = {}) => {
    const r = await prisma.foodRestaurant.create({
        data: {
            restaurantName: `Directory ${uniqueTag('R')}`,
            ownerName: 'Owner',
            ownerPhone: uniquePhone('9'),
            status: 'approved',
            ...over,
        },
    });
    created.restaurants.push(r.id);
    return r;
};

test.after(async () => {
    await prisma.foodItem.deleteMany({ where: { id: { in: created.foods } } });
    await prisma.foodCategory.deleteMany({ where: { id: { in: created.categories } } });
    await prisma.foodRestaurant.deleteMany({ where: { id: { in: created.restaurants } } });
    await prisma.foodZone.deleteMany({ where: { id: { in: created.zones } } });
    await prisma.$disconnect();
});

test('the active filter means approved', async () => {
    const tag = uniqueTag('Active');
    const open = await makeRestaurant({ restaurantName: `${tag} Open`, status: 'approved' });
    const waiting = await makeRestaurant({ restaurantName: `${tag} Waiting`, status: 'pending' });

    const active = await getRestaurants({ search: tag, isActive: 'true' });
    assert.equal(active.total, 1);
    assert.equal(active.restaurants[0].id, open.id);

    // In Mongo this matched nothing, because the column it filtered on did not
    // exist on any document.
    const inactive = await getRestaurants({ search: tag, isActive: 'false' });
    assert.equal(inactive.total, 1);
    assert.equal(inactive.restaurants[0].id, waiting.id);

    const all = await getRestaurants({ search: tag });
    assert.equal(all.total, 2);
});

test('the header counts add up', async () => {
    const { stats } = await getRestaurants({ includeStats: 'true', limit: 1 });

    assert.ok(stats.total >= 1);
    // Both of these used to equal the total.
    assert.equal(stats.active + stats.inactive, stats.total);
    assert.ok(stats.active >= 0 && stats.inactive >= 0);

    const scoped = await getRestaurants({ status: 'pending', includeStats: 'true', limit: 1 });
    assert.equal(scoped.stats.active, 0, 'nothing pending is approved');
    assert.equal(scoped.stats.inactive, scoped.stats.total);
});

test('search matches a name, an owner, or a partial phone', async () => {
    const tag = uniqueTag('Findable');
    const phone = uniquePhone('9');
    const r = await makeRestaurant({
        restaurantName: `${tag} Kitchen`,
        ownerName: `${tag} Owner`,
        ownerPhone: phone,
        ownerPhoneDigits: phone,
        ownerPhoneLast10: phone,
    });

    assert.equal((await getRestaurants({ search: tag })).total, 1);
    assert.equal((await getRestaurants({ search: `${tag} Owner` })).total, 1);

    // A partial number, as an admin would type it.
    const byPhone = await getRestaurants({ search: phone.slice(-6) });
    assert.ok(byPhone.restaurants.some((x) => x.id === r.id));
});

test('sorting is applied by the database', async () => {
    const tag = uniqueTag('Sorted');
    await makeRestaurant({ restaurantName: `${tag} Bravo`, rating: 2 });
    await makeRestaurant({ restaurantName: `${tag} Alpha`, rating: 5 });

    const byName = await getRestaurants({ search: tag, sortBy: 'name-asc' });
    assert.match(byName.restaurants[0].restaurantName, /Alpha/);

    const byRating = await getRestaurants({ search: tag, sortBy: 'rating-desc' });
    assert.match(byRating.restaurants[0].restaurantName, /Alpha/);

    // An unknown sort falls back to newest first rather than erroring.
    const fallback = await getRestaurants({ search: tag, sortBy: 'nonsense' });
    assert.equal(fallback.total, 2);
});

test('a restaurant reads back with its zone and nested location', async () => {
    const zone = await prisma.foodZone.create({
        data: {
            name: `Dir Zone ${uniqueTag('Z')}`,
            zoneName: 'North',
            coordinates: [
                { latitude: 20, longitude: 70 },
                { latitude: 21, longitude: 70 },
                { latitude: 21, longitude: 71 },
            ],
        },
    });
    created.zones.push(zone.id);

    const r = await makeRestaurant({
        zoneId: zone.id,
        latitude: 22.71,
        longitude: 75.85,
        city: 'Indore',
        addressLine1: '9 Market Road',
    });

    const doc = await getRestaurantById(r.id);
    assert.equal(doc.id, r.id);
    assert.equal(doc.zone.zoneName, 'North');
    // The flat columns are rebuilt into the nested shape the panel reads.
    assert.equal(doc.location.city, 'Indore');
    assert.equal(doc.location.latitude, 22.71);

    assert.equal(await getRestaurantById('a'.repeat(24)), null);
    assert.equal(await getRestaurantById('not-an-id'), null);
});

test('the menu is generated from dishes, not stored', async () => {
    const restaurant = await makeRestaurant();
    const category = await prisma.foodCategory.create({
        data: { name: `Starters ${uniqueTag('C')}`, approvalStatus: 'approved', isApproved: true },
    });
    created.categories.push(category.id);

    const food = await prisma.foodItem.create({
        data: {
            restaurantId: restaurant.id,
            categoryId: category.id,
            categoryName: category.name,
            name: 'Spring Roll',
            price: 120,
            approvalStatus: 'approved',
        },
    });
    created.foods.push(food.id);

    const menu = await getRestaurantMenuById(restaurant.id);
    assert.ok(Array.isArray(menu.sections));
    assert.ok(menu.sections.some((s) => s.items.some((i) => i.id === food.id)));

    // The stored snapshot is gone, so editing it says so rather than writing to
    // a column that no longer exists.
    await assert.rejects(
        () => updateRestaurantMenuById(restaurant.id, { sections: [] }),
        /Menu editing is disabled/,
    );

    assert.equal(await getRestaurantMenuById('not-an-id'), null);
});
