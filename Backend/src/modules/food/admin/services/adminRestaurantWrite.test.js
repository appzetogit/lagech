import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../../config/prisma.js';
import { uniquePhone, uniqueTag } from '../../../../utils/testIds.js';
import { createRestaurantByAdmin, updateRestaurantById } from './adminRestaurantWrite.service.js';

/**
 * Creating and editing a restaurant from the admin panel.
 *
 * The two things worth pinning are the duplicate-phone guard — a restaurant's
 * phone is how its owner signs in — and the outlet timings, because a
 * restaurant with no timings row reads as closed every day.
 */
const live = Boolean(process.env.DATABASE_URL);

const created = { restaurants: [], zones: [], users: [] };

const baseBody = (over = {}) => ({
    restaurantName: `Written ${uniqueTag('R')}`,
    ownerName: 'Owner Name',
    ownerPhone: uniquePhone('9'),
    ...over,
});

const track = async (body) => {
    const r = await createRestaurantByAdmin(body);
    created.restaurants.push(r.id);
    return r;
};

test.after(async () => {
    if (!live) return;
    await prisma.foodRestaurantOutletTimings.deleteMany({
        where: { restaurantId: { in: created.restaurants } },
    });
    await prisma.foodRestaurant.deleteMany({ where: { id: { in: created.restaurants } } });
    await prisma.foodUser.deleteMany({ where: { id: { in: created.users } } });
    await prisma.foodZone.deleteMany({ where: { id: { in: created.zones } } });
    await prisma.$disconnect();
});

test('an admin-created restaurant is approved and open', { skip: !live }, async () => {
    const r = await track(baseBody({ openingTime: '10:00', closingTime: '23:00' }));

    // An admin creating it is the approval.
    assert.equal(r.status, 'approved');
    assert.ok(r.approvedAt);
    assert.equal(r.openingTime, '10:00');

    // Seeded in the same transaction: with no timings row the restaurant reads
    // as closed every day and could never take an order.
    const timings = await prisma.foodRestaurantOutletTimings.findUnique({
        where: { restaurantId: r.id },
    });
    assert.ok(timings, 'timings exist from the start');
    assert.equal(timings.timings.length, 7);
    assert.ok(timings.timings.every((t) => t.openingTime === '10:00' || !t.isOpen));
});

test('opening hours default when not supplied', { skip: !live }, async () => {
    const r = await track(baseBody());
    assert.equal(r.openingTime, '09:00');
    assert.equal(r.closingTime, '22:00');
});

test('times are normalised and validated', { skip: !live }, async () => {
    // 12-hour input is accepted and stored as 24-hour.
    const r = await track(baseBody({ openingTime: '9:30 AM', closingTime: '11:00 PM' }));
    assert.equal(r.openingTime, '09:30');
    assert.equal(r.closingTime, '23:00');

    await assert.rejects(
        () => createRestaurantByAdmin(baseBody({ openingTime: '22:00', closingTime: '09:00' })),
        /Closing time cannot be less than opening time/,
    );
    await assert.rejects(
        () => createRestaurantByAdmin(baseBody({ openingTime: '10:00', closingTime: '10:00' })),
        /cannot be same/,
    );
});

test('a restaurant needs a name, an owner and a number', { skip: !live }, async () => {
    await assert.rejects(
        () => createRestaurantByAdmin({ ownerName: 'X', ownerPhone: uniquePhone('9') }),
        /name and owner name are required/,
    );
    await assert.rejects(
        () => createRestaurantByAdmin({ restaurantName: 'X', ownerName: 'Y' }),
        /phone or primary contact number is required/,
    );
});

test('the same phone cannot reach two restaurants', { skip: !live }, async () => {
    const phone = uniquePhone('9');
    await track(baseBody({ ownerPhone: phone }));

    // The phone is the owner's login, so a second account on it would be a
    // second way into the first restaurant.
    await assert.rejects(
        () => createRestaurantByAdmin(baseBody({ ownerPhone: phone })),
        /phone number already exists/,
    );

    // Every spelling of it is checked, not just the exact string.
    await assert.rejects(
        () => createRestaurantByAdmin(baseBody({ ownerPhone: `+91 ${phone}` })),
        /phone number already exists/,
    );

    // And it collides with a restaurant login too, not only another restaurant.
    const otherPhone = uniquePhone('8');
    const user = await prisma.foodUser.create({ data: { phone: otherPhone, role: 'RESTAURANT' } });
    created.users.push(user.id);

    await assert.rejects(
        () => createRestaurantByAdmin(baseBody({ ownerPhone: otherPhone })),
        /account with this phone number already exists/,
    );
});

test('the nested location input becomes flat columns', { skip: !live }, async () => {
    const zone = await prisma.foodZone.create({
        data: {
            name: `Write Zone ${uniqueTag('Z')}`,
            coordinates: [
                { latitude: 22.6, longitude: 75.7 },
                { latitude: 22.9, longitude: 75.7 },
                { latitude: 22.9, longitude: 76.0 },
            ],
        },
    });
    created.zones.push(zone.id);

    const r = await track(baseBody({
        zoneId: zone.id,
        location: {
            // Coordinates win over latitude/longitude when both are given.
            coordinates: [75.86, 22.72],
            addressLine1: '4 Admin Street',
            area: 'Vijay Nagar',
            city: 'Indore',
            state: 'MP',
            pincode: '452010',
        },
    }));

    assert.equal(Number(r.latitude).toFixed(2), '22.72');
    assert.equal(Number(r.longitude).toFixed(2), '75.86');
    assert.equal(r.city, 'Indore');
    assert.equal(r.zoneId, zone.id);
    // And it reads back nested, which is what the panel expects.
    assert.equal(r.location.area, 'Vijay Nagar');

    await assert.rejects(
        () => createRestaurantByAdmin(baseBody({ zoneId: 'not-an-id' })),
        /Invalid zoneId/,
    );
});

test('dining settings become three columns', { skip: !live }, async () => {
    const r = await track(baseBody({
        diningSettings: { isEnabled: true, maxGuests: 8, diningType: 'fine-dining' },
    }));

    assert.equal(r.diningEnabled, true);
    assert.equal(r.diningMaxGuests, 8);
    assert.equal(r.diningType, 'fine-dining');

    // A guest count below 1 makes no sense and is clamped.
    const clamped = await track(baseBody({ diningSettings: { isEnabled: true, maxGuests: 0 } }));
    assert.equal(clamped.diningMaxGuests, 6);
});

test('editing applies only the fields that were sent', { skip: !live }, async () => {
    const r = await track(baseBody({ ownerEmail: 'owner@test.local', offer: '20% off' }));

    const updated = await updateRestaurantById(r.id, { restaurantName: 'Renamed Kitchen' });
    assert.equal(updated.restaurantName, 'Renamed Kitchen');
    assert.equal(updated.ownerEmail, 'owner@test.local', 'an unmentioned field is untouched');
    assert.equal(updated.offer, '20% off');

    await assert.rejects(
        () => updateRestaurantById(r.id, { restaurantName: '   ' }),
        /name cannot be empty/,
    );
    assert.equal(await updateRestaurantById('a'.repeat(24), { offer: 'x' }), null);
});

test('cuisines accept a list or a comma-separated string', { skip: !live }, async () => {
    const r = await track(baseBody());

    const asList = await updateRestaurantById(r.id, { cuisines: ['Indian', 'Chinese'] });
    assert.deepEqual(asList.cuisines, ['Indian', 'Chinese']);

    const asString = await updateRestaurantById(r.id, { cuisines: 'Thai, Italian' });
    assert.deepEqual(asString.cuisines, ['Thai', 'Italian']);

    await assert.rejects(
        () => updateRestaurantById(r.id, { cuisines: 42 }),
        /array or comma-separated string/,
    );
});

test('editing the cover and gallery images works', { skip: !live }, async () => {
    const r = await track(baseBody());

    // These were missing from the admin edit path, so an admin could change a
    // restaurant's documents but not the images customers actually see.
    const updated = await updateRestaurantById(r.id, {
        coverImage: 'https://cdn/cover.png',
        coverImages: ['https://cdn/a.png', { url: 'https://cdn/b.png' }],
        galleryImages: ['https://cdn/g.png'],
    });

    assert.equal(updated.coverImage, 'https://cdn/cover.png');
    assert.deepEqual(updated.coverImages, ['https://cdn/a.png', 'https://cdn/b.png']);
    assert.deepEqual(updated.galleryImages, ['https://cdn/g.png']);
});

test('changing the hours rewrites the timings, keeping closed days closed', { skip: !live }, async () => {
    const r = await track(baseBody({ openingTime: '09:00', closingTime: '21:00' }));

    // Close Sunday by hand, as a restaurant would.
    const before = await prisma.foodRestaurantOutletTimings.findUnique({
        where: { restaurantId: r.id },
    });
    await prisma.foodRestaurantOutletTimings.update({
        where: { restaurantId: r.id },
        data: {
            timings: before.timings.map((t) =>
                t.day === 'Sunday' ? { ...t, isOpen: false, openingTime: '', closingTime: '' } : t),
        },
    });

    await updateRestaurantById(r.id, { openingTime: '11:00', closingTime: '23:30' });

    const after = await prisma.foodRestaurantOutletTimings.findUnique({
        where: { restaurantId: r.id },
    });
    const monday = after.timings.find((t) => t.day === 'Monday');
    const sunday = after.timings.find((t) => t.day === 'Sunday');

    assert.equal(monday.openingTime, '11:00');
    assert.equal(monday.closingTime, '23:30');
    // Only the hours move — a day the restaurant closed stays closed.
    assert.equal(sunday.isOpen, false);
    assert.equal(sunday.openingTime, '');
});
