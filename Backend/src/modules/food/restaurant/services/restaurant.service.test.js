import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../../config/prisma.js';
import {
    listApprovedRestaurants,
    getApprovedRestaurantByIdOrSlug,
    listPublicOffers,
    createRestaurantOffer,
    listRestaurantOffers,
    deleteRestaurantOffer,
    updateRestaurantOfferStatus,
    updateRestaurantProfile,
    updateRestaurantAcceptingOrders,
    getCurrentRestaurantProfile,
    deleteCurrentRestaurantAccount,
} from './restaurant.service.js';
import { uniquePhone } from '../../../../utils/testIds.js';

/**
 * The public restaurant feed and the offer/profile writes.
 *
 * The parts worth pinning are the ones whose Mongo originals had no direct
 * Prisma equivalent: $geoNear became an indexed ST_DWithin, and the "not yet
 * used up" offer clause was a $expr comparing two fields.
 */
const live = Boolean(process.env.DATABASE_URL);

// Indore, and a point ~400km away.
const HERE = { lat: 22.7196, lng: 75.8577 };
const FAR = { lat: 19.076, lng: 72.8777 };

const created = { restaurants: [], offers: [], zones: [], invoices: [] };
const stamp = () => `${Date.now()}${Math.floor(performance.now() * 1000) % 1000}`;

const makeRestaurant = async (overrides = {}) => {
    const restaurant = await prisma.foodRestaurant.create({
        data: {
            restaurantName: `Feed Test ${stamp()}`,
            ownerName: 'Owner',
            ownerPhone: uniquePhone('9'),
            status: 'approved',
            ...overrides,
        },
    });
    created.restaurants.push(restaurant.id);
    return restaurant;
};

const makeOffer = async (data) => {
    const offer = await prisma.foodOffer.create({
        data: { couponCode: `T${stamp()}`, discountType: 'percentage', discountValue: 10, ...data },
    });
    created.offers.push(offer.id);
    return offer;
};

test.after(async () => {
    if (!live) return;
    await prisma.foodSubscriptionInvoice.deleteMany({ where: { id: { in: created.invoices } } });
    await prisma.foodOffer.deleteMany({ where: { id: { in: created.offers } } });
    await prisma.foodRestaurantOutletTimings.deleteMany({
        where: { restaurantId: { in: created.restaurants } },
    });
    await prisma.foodRestaurant.deleteMany({ where: { id: { in: created.restaurants } } });
    await prisma.foodZone.deleteMany({ where: { id: { in: created.zones } } });
    await prisma.$disconnect();
});

test('the feed lists approved restaurants and hides the rest', { skip: !live }, async () => {
    const open = await makeRestaurant();
    const pending = await makeRestaurant({ status: 'pending' });

    const { restaurants } = await listApprovedRestaurants({ limit: 1000 });
    const ids = new Set(restaurants.map((r) => r.id));

    assert.ok(ids.has(open.id));
    assert.ok(!ids.has(pending.id), 'an unapproved restaurant is not public');
});

test('a radius search returns only what is inside it, with a distance', { skip: !live }, async () => {
    const near = await makeRestaurant({ latitude: HERE.lat, longitude: HERE.lng });
    const far = await makeRestaurant({ latitude: FAR.lat, longitude: FAR.lng });

    const { restaurants } = await listApprovedRestaurants({
        lat: HERE.lat, lng: HERE.lng, radiusKm: 25, limit: 1000,
    });
    const ids = new Set(restaurants.map((r) => r.id));

    assert.ok(ids.has(near.id), 'a restaurant in the radius is returned');
    assert.ok(!ids.has(far.id), 'one 400km away is not');

    // $geoNear used to supply this; it is ST_Distance now.
    const row = restaurants.find((r) => r.id === near.id);
    assert.ok(Number.isFinite(row.distanceInKm), 'the distance comes back as a number');
    assert.ok(row.distanceInKm < 5, `expected a short distance, got ${row.distanceInKm}`);
});

test('a restaurant with no coordinates still shows in the default feed', { skip: !live }, async () => {
    const noGeo = await makeRestaurant();

    // No radius and no nearest sort, so the geo path must not run — otherwise a
    // restaurant that has not pinned itself yet silently disappears.
    const { restaurants } = await listApprovedRestaurants({ lat: HERE.lat, lng: HERE.lng, limit: 1000 });
    assert.ok(new Set(restaurants.map((r) => r.id)).has(noGeo.id));
});

test('searching matches the name', { skip: !live }, async () => {
    const unique = `Zqx${stamp()}`;
    const match = await makeRestaurant({ restaurantName: `${unique} Kitchen` });
    await makeRestaurant();

    const { restaurants, total } = await listApprovedRestaurants({ search: unique });
    assert.equal(total, 1);
    assert.equal(restaurants[0].id, match.id);
});

test('a restaurant resolves by id and by slug', { skip: !live }, async () => {
    const name = `Slugged ${stamp()}`;
    const r = await makeRestaurant({
        restaurantName: name,
        restaurantNameNormalized: name.toLowerCase().replace(/\s+/g, ' '),
    });

    const byId = await getApprovedRestaurantByIdOrSlug(r.id);
    assert.equal(byId.id, r.id);

    const bySlug = await getApprovedRestaurantByIdOrSlug(name);
    assert.equal(bySlug.id, r.id);

    assert.equal(await getApprovedRestaurantByIdOrSlug('no-such-restaurant'), null);
});

test('an offer that has been used up is not offered again', { skip: !live }, async () => {
    const live1 = await makeOffer({ usageLimit: 5, usedCount: 2 });
    const exhausted = await makeOffer({ usageLimit: 5, usedCount: 5 });
    const unlimited = await makeOffer({ usageLimit: null, usedCount: 999 });
    const zeroMeansUnlimited = await makeOffer({ usageLimit: 0, usedCount: 999 });

    const { allOffers } = await listPublicOffers({});
    const ids = new Set(allOffers.map((o) => o.id));

    // This clause was a Mongo $expr comparing usedCount against usageLimit; it
    // is a Prisma field reference, so it still resolves in the database.
    assert.ok(ids.has(live1.id), 'an offer with headroom is listed');
    assert.ok(!ids.has(exhausted.id), 'one at its limit is not');
    assert.ok(ids.has(unlimited.id), 'no limit means no limit');
    assert.ok(ids.has(zeroMeansUnlimited.id), '0 means unlimited, not exhausted');
});

test('an expired offer is not listed, one ending today still is', { skip: !live }, async () => {
    const expired = await makeOffer({ endDate: new Date(Date.now() - 86400000) });
    const endsToday = await makeOffer({ endDate: new Date() });
    const notStarted = await makeOffer({ startDate: new Date(Date.now() + 86400000) });

    const { allOffers } = await listPublicOffers({});
    const ids = new Set(allOffers.map((o) => o.id));

    assert.ok(!ids.has(expired.id));
    // The end bound is midnight, so a coupon ending today lasts all day.
    assert.ok(ids.has(endsToday.id));
    assert.ok(!ids.has(notStarted.id));
});

test('a restaurant-scoped offer only surfaces for that restaurant', { skip: !live }, async () => {
    const mine = await makeRestaurant();
    const other = await makeRestaurant();

    const scoped = await makeOffer({ restaurantScope: 'selected', restaurantId: mine.id });
    // The array form: an offer naming several restaurants.
    const listed = await makeOffer({ restaurantScope: 'selected', restaurantIds: [mine.id] });

    const forMine = new Set((await listPublicOffers({ restaurantId: mine.id })).allOffers.map((o) => o.id));
    assert.ok(forMine.has(scoped.id));
    assert.ok(forMine.has(listed.id), 'hasSome matches the array column');

    const forOther = new Set((await listPublicOffers({ restaurantId: other.id })).allOffers.map((o) => o.id));
    assert.ok(!forOther.has(scoped.id));
    assert.ok(!forOther.has(listed.id));
});

test('a duplicate coupon code is refused', { skip: !live }, async () => {
    const r = await makeRestaurant();
    const code = `DUP${stamp()}`;

    const first = await createRestaurantOffer(r.id, {
        couponCode: code, discountType: 'percentage', discountValue: 15,
    });
    created.offers.push(first.id);
    assert.equal(Number(first.restaurantBearPercentage), 100, 'a restaurant offer is restaurant-funded');

    await assert.rejects(
        () => createRestaurantOffer(r.id, {
            couponCode: code, discountType: 'percentage', discountValue: 20,
        }),
        /already exists/,
    );
});

test('a restaurant cannot touch another restaurant\'s offer', { skip: !live }, async () => {
    const mine = await makeRestaurant();
    const other = await makeRestaurant();

    const offer = await createRestaurantOffer(mine.id, {
        couponCode: `OWN${stamp()}`, discountType: 'flat_price', discountValue: 50,
    });
    created.offers.push(offer.id);

    assert.equal((await listRestaurantOffers(mine.id)).length, 1);
    assert.equal((await listRestaurantOffers(other.id)).length, 0);

    // Ownership is part of the write, not a lookup before it.
    await assert.rejects(() => deleteRestaurantOffer(other.id, offer.id), /not owned by you/);
    await assert.rejects(
        () => updateRestaurantOfferStatus(other.id, offer.id, 'paused'),
        /not owned by you/,
    );

    const paused = await updateRestaurantOfferStatus(mine.id, offer.id, 'paused');
    assert.equal(paused.status, 'paused');
    assert.equal(await deleteRestaurantOffer(mine.id, offer.id), true);
});

test('the first location goes live, a later move needs approval', { skip: !live }, async () => {
    const zone = await prisma.foodZone.create({
        data: {
            name: `Test Zone ${stamp()}`,
            isActive: true,
            coordinates: [
                { latitude: 22.6, longitude: 75.7 },
                { latitude: 22.9, longitude: 75.7 },
                { latitude: 22.9, longitude: 76.0 },
                { latitude: 22.6, longitude: 76.0 },
            ],
        },
    });
    created.zones.push(zone.id);

    const r = await makeRestaurant();

    // Nothing published yet, so it is applied straight away.
    const first = await updateRestaurantProfile(r.id, {
        location: { latitude: HERE.lat, longitude: HERE.lng, city: 'Indore', area: 'Vijay Nagar' },
    });
    assert.equal(first.locationUpdateStatus, 'none');

    const afterFirst = await prisma.foodRestaurant.findUnique({ where: { id: r.id } });
    assert.equal(Number(afterFirst.latitude).toFixed(3), HERE.lat.toFixed(3));
    assert.equal(afterFirst.zoneId, zone.id, 'the zone is resolved from the pin');
    assert.equal(afterFirst.city, 'Indore', 'the address columns are written too');

    // Moving an already-published restaurant is a request: the live location
    // keeps serving orders until an admin approves.
    const second = await updateRestaurantProfile(r.id, {
        location: { latitude: 22.75, longitude: 75.9, city: 'Indore' },
    });
    assert.equal(second.locationUpdateStatus, 'pending');

    const afterSecond = await prisma.foodRestaurant.findUnique({ where: { id: r.id } });
    assert.equal(Number(afterSecond.latitude).toFixed(3), HERE.lat.toFixed(3), 'the live pin is untouched');
    assert.equal(Number(afterSecond.pendingLatitude).toFixed(2), '22.75');
    assert.equal(afterSecond.pendingZoneId, zone.id);
});

test('a pin outside every zone is refused', { skip: !live }, async () => {
    const r = await makeRestaurant();
    await assert.rejects(
        () => updateRestaurantProfile(r.id, { location: { latitude: 1.5, longitude: 1.5 } }),
        /outside the service zone/,
    );
});

test('editing a reviewable field clears the previous decision', { skip: !live }, async () => {
    const r = await makeRestaurant({ status: 'approved', approvedAt: new Date(), rejectionReason: 'old' });

    const updated = await updateRestaurantProfile(r.id, { restaurantName: `Renamed ${stamp()}` });
    assert.equal(updated.status, 'pending');

    const row = await prisma.foodRestaurant.findUnique({ where: { id: r.id } });
    // Left set, the admin screen shows the restaurant as pending and approved.
    assert.equal(row.approvedAt, null);
    assert.equal(row.rejectionReason, '');
});

test('going online clears the manual offline override', { skip: !live }, async () => {
    const r = await makeRestaurant({ isAcceptingOrders: false, outsideHoursOverride: true });

    const profile = await updateRestaurantAcceptingOrders(r.id, true);
    assert.equal(profile.isAcceptingOrders, true);

    const row = await prisma.foodRestaurant.findUnique({ where: { id: r.id } });
    assert.equal(row.outsideHoursOverride, false);
});

test('the profile does not leak auth fields', { skip: !live }, async () => {
    const r = await makeRestaurant();
    const profile = await getCurrentRestaurantProfile(r.id);

    assert.ok(profile.restaurantName);
    assert.equal(profile.fcmTokens, undefined, 'device tokens are not part of a profile');
    assert.equal(profile.tokenVersion, undefined);
});

test('a restaurant that has billed cannot be deleted', { skip: !live }, async () => {
    const r = await makeRestaurant();

    const invoice = await prisma.foodSubscriptionInvoice.create({
        data: {
            restaurantId: r.id,
            billingMonth: '2026-08',
            planName: 'starter',
            planAmount: 1000,
            totalAmount: 1180,
            outstandingAmount: 1180,
        },
    });
    created.invoices.push(invoice.id);

    // Mongo deleted the restaurant and left the invoice pointing at nothing.
    await assert.rejects(() => deleteCurrentRestaurantAccount(r.id), /cannot be deleted/);
});

test('a restaurant that never traded deletes, taking its dishes with it', { skip: !live }, async () => {
    const r = await makeRestaurant();
    const food = await prisma.foodItem.create({
        data: { restaurantId: r.id, name: 'Doomed Dish', price: 100 },
    });

    assert.deepEqual(await deleteCurrentRestaurantAccount(r.id), { success: true });

    assert.equal(await prisma.foodRestaurant.findUnique({ where: { id: r.id } }), null);
    // ON DELETE CASCADE, rather than the orphan Mongo left behind.
    assert.equal(await prisma.foodItem.findUnique({ where: { id: food.id } }), null);

    created.restaurants = created.restaurants.filter((id) => id !== r.id);
});
