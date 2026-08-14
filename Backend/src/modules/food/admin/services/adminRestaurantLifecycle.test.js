import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../../config/prisma.js';
import { uniquePhone, uniqueTag } from '../../../../utils/testIds.js';
import {
    getPendingRestaurants,
    getUnregisteredRestaurants,
    deleteUnregisteredRestaurant,
    updateRestaurantStatus,
    updateRestaurantLocation,
    approveRestaurant,
    rejectRestaurant,
    deleteRestaurant,
} from './adminRestaurantLifecycle.service.js';

/**
 * Restaurant approval.
 *
 * The queue holds two different requests: a new registration, and a location
 * change from a restaurant that is already trading. Approving or rejecting has
 * to act on whichever is outstanding — rejecting a move must not close the
 * restaurant.
 */
const live = Boolean(process.env.DATABASE_URL);

const created = { restaurants: [], zones: [], unregistered: [], users: [], invoices: [] };

const makeZone = async () => {
    const zone = await prisma.foodZone.create({
        data: {
            name: `Lifecycle Zone ${uniqueTag('Z')}`,
            zoneName: 'Central',
            coordinates: [
                { latitude: 22.6, longitude: 75.7 },
                { latitude: 22.9, longitude: 75.7 },
                { latitude: 22.9, longitude: 76.0 },
            ],
        },
    });
    created.zones.push(zone.id);
    return zone;
};

const makeRestaurant = async (over = {}) => {
    const r = await prisma.foodRestaurant.create({
        data: {
            restaurantName: `Lifecycle ${uniqueTag('R')}`,
            ownerName: 'Owner',
            ownerPhone: uniquePhone('9'),
            status: 'pending',
            ...over,
        },
    });
    created.restaurants.push(r.id);
    return r;
};

test.after(async () => {
    if (!live) return;
    await prisma.foodSubscriptionInvoice.deleteMany({ where: { id: { in: created.invoices } } });
    await prisma.foodUnregisteredRestaurant.deleteMany({ where: { id: { in: created.unregistered } } });
    await prisma.foodRestaurant.deleteMany({ where: { id: { in: created.restaurants } } });
    await prisma.foodUser.deleteMany({ where: { id: { in: created.users } } });
    await prisma.foodZone.deleteMany({ where: { id: { in: created.zones } } });
    await prisma.$disconnect();
});

test('approving a registration clears any earlier rejection', { skip: !live }, async () => {
    const restaurant = await makeRestaurant();

    const rejected = await rejectRestaurant(restaurant.id, 'Licence expired');
    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.rejectionReason, 'Licence expired');

    const approved = await approveRestaurant(restaurant.id);
    assert.equal(approved.status, 'approved');
    assert.ok(approved.approvedAt);
    // undefined would leave the restaurant approved and still carrying a reason.
    assert.equal(approved.rejectedAt, null);
    assert.equal(approved.rejectionReason, '');
});

test('approving publishes a pending move', { skip: !live }, async () => {
    const zone = await makeZone();
    const restaurant = await makeRestaurant({
        status: 'approved',
        latitude: 22.70,
        longitude: 75.85,
        locationUpdateStatus: 'pending',
        pendingLatitude: 22.75,
        pendingLongitude: 75.90,
        pendingZoneId: zone.id,
        locationUpdateRequestedAt: new Date(),
    });

    const approved = await approveRestaurant(restaurant.id);

    // The live pin moves to where the restaurant asked to go.
    assert.equal(Number(approved.latitude).toFixed(2), '22.75');
    assert.equal(Number(approved.longitude).toFixed(2), '75.90');
    assert.equal(approved.zoneId, zone.id);

    assert.equal(approved.locationUpdateStatus, 'approved');
    assert.ok(approved.locationUpdateReviewedAt);
    // The request is consumed, not left to be applied twice.
    assert.equal(approved.pendingLatitude, null);
    assert.equal(approved.pendingZoneId, null);
});

test('rejecting a move leaves the restaurant trading', { skip: !live }, async () => {
    const restaurant = await makeRestaurant({
        status: 'approved',
        latitude: 22.70,
        longitude: 75.85,
        locationUpdateStatus: 'pending',
        pendingLatitude: 1.5,
        pendingLongitude: 1.5,
    });

    const rejected = await rejectRestaurant(restaurant.id, 'Pin is in the sea');

    // Only the move is refused — closing the restaurant would be a different
    // and much worse outcome.
    assert.equal(rejected.status, 'approved');
    assert.equal(rejected.locationUpdateStatus, 'rejected');
    assert.equal(rejected.locationRejectionReason, 'Pin is in the sea');
    assert.equal(Number(rejected.latitude).toFixed(2), '22.70', 'the live pin is untouched');
    assert.equal(rejected.pendingLatitude, null);
});

test('the queue holds registrations and moves alike', { skip: !live }, async () => {
    const zone = await makeZone();
    const waiting = await makeRestaurant({ status: 'pending' });
    const moving = await makeRestaurant({
        status: 'approved',
        locationUpdateStatus: 'pending',
        pendingLatitude: 22.8,
        pendingLongitude: 75.9,
        pendingZoneId: zone.id,
        zoneId: zone.id,
    });
    const settled = await makeRestaurant({ status: 'approved' });

    const queue = await getPendingRestaurants();
    const ids = new Set(queue.map((r) => r.id));

    assert.ok(ids.has(waiting.id), 'a new registration');
    assert.ok(ids.has(moving.id), 'an approved restaurant asking to move');
    assert.ok(!ids.has(settled.id), 'nothing outstanding');

    // The queue shows the zone names, not ids.
    const movingRow = queue.find((r) => r.id === moving.id);
    assert.equal(movingRow.zone, 'Central');
    assert.equal(movingRow.pendingZone, 'Central');
});

test('status accepts a name or a boolean-ish toggle', { skip: !live }, async () => {
    const restaurant = await makeRestaurant();

    assert.equal((await updateRestaurantStatus(restaurant.id, { status: 'approved' })).status, 'approved');
    assert.equal((await updateRestaurantStatus(restaurant.id, { status: 'pending' })).status, 'pending');

    // The same endpoint serves an on/off switch.
    const off = await updateRestaurantStatus(restaurant.id, { isActive: 'false' });
    assert.equal(off.status, 'rejected');
    assert.equal(off.rejectionReason, 'Disabled by admin');

    const on = await updateRestaurantStatus(restaurant.id, { isActive: true });
    assert.equal(on.status, 'approved');

    await assert.rejects(
        () => updateRestaurantStatus(restaurant.id, { status: 'maybe' }),
        /must be a boolean/,
    );
    assert.equal(await updateRestaurantStatus('a'.repeat(24), { status: 'approved' }), null);
});

test('an admin location edit applies at once', { skip: !live }, async () => {
    const zone = await makeZone();
    const restaurant = await makeRestaurant({ status: 'approved' });

    const updated = await updateRestaurantLocation(restaurant.id, {
        location: {
            latitude: 22.72,
            longitude: 75.86,
            addressLine1: '12 Test Road',
            city: 'Indore',
            state: 'MP',
            pincode: '452001',
        },
        zoneId: zone.id,
    });

    // No approval step: an admin moving the pin does not need their own sign-off.
    assert.equal(updated.locationUpdateStatus, 'none');
    assert.equal(Number(updated.latitude).toFixed(2), '22.72');
    assert.equal(updated.city, 'Indore');
    assert.equal(updated.zoneId, zone.id);
    // The nested shape the clients read is rebuilt from the flat columns.
    assert.equal(updated.location.city, 'Indore');

    await assert.rejects(
        () => updateRestaurantLocation(restaurant.id, { zoneId: 'nope' }),
        /Invalid zoneId/,
    );
    assert.equal(await updateRestaurantLocation('a'.repeat(24), {}), null);
});

test('a restaurant that has billed cannot be deleted', { skip: !live }, async () => {
    const restaurant = await makeRestaurant({ status: 'approved' });

    const invoice = await prisma.foodSubscriptionInvoice.create({
        data: {
            restaurantId: restaurant.id,
            billingMonth: '2026-08',
            planName: 'starter',
            planAmount: 1000,
            totalAmount: 1180,
            outstandingAmount: 1180,
        },
    });
    created.invoices.push(invoice.id);

    // Mongo deleted the restaurant and left the invoice pointing at nothing.
    await assert.rejects(() => deleteRestaurant(restaurant.id), /cannot be deleted/);
});

test('deleting a clean restaurant removes its owner login too', { skip: !live }, async () => {
    const restaurant = await makeRestaurant();

    const owner = await prisma.foodUser.create({
        data: { phone: restaurant.ownerPhone, role: 'RESTAURANT' },
    });
    created.users.push(owner.id);

    const deleted = await deleteRestaurant(restaurant.id);
    assert.equal(deleted.id, restaurant.id);

    assert.equal(await prisma.foodRestaurant.findUnique({ where: { id: restaurant.id } }), null);
    assert.equal(await prisma.foodUser.findUnique({ where: { id: owner.id } }), null);

    assert.equal(await deleteRestaurant(restaurant.id), null);
    await assert.rejects(() => deleteRestaurant('not-an-id'), /Invalid restaurant ID/);

    created.restaurants = created.restaurants.filter((id) => id !== restaurant.id);
});

test('deleting a restaurant keeps a category it only proposed', { skip: !live }, async () => {
    const restaurant = await makeRestaurant();

    const owned = await prisma.foodCategory.create({
        data: { name: `Owned ${uniqueTag('C')}`, restaurantId: restaurant.id },
    });
    const promoted = await prisma.foodCategory.create({
        data: { name: `Promoted ${uniqueTag('C')}`, createdByRestaurantId: restaurant.id },
    });

    await deleteRestaurant(restaurant.id);

    assert.equal(await prisma.foodCategory.findUnique({ where: { id: owned.id } }), null);

    // A category promoted to global outlives the restaurant that proposed it —
    // other restaurants are using it.
    const survivor = await prisma.foodCategory.findUnique({ where: { id: promoted.id } });
    assert.ok(survivor);
    assert.equal(survivor.createdByRestaurantId, null);

    await prisma.foodCategory.delete({ where: { id: promoted.id } });
    created.restaurants = created.restaurants.filter((id) => id !== restaurant.id);
});

test('unregistered leads list and delete', { skip: !live }, async () => {
    const lead = await prisma.foodUnregisteredRestaurant.create({
        data: {
            ownerName: 'Prospect',
            restaurantName: `Lead ${uniqueTag('L')}`,
            mobileNumber: uniquePhone('8'),
            emailId: `lead${uniqueTag('e')}@test.local`,
            location: 'Indore, MP',
        },
    });
    created.unregistered.push(lead.id);

    const list = await getUnregisteredRestaurants();
    const row = list.find((r) => r.id === lead.id);
    assert.ok(row);
    assert.ok(row.sl >= 1, 'rows are numbered for the table');

    assert.equal((await deleteUnregisteredRestaurant(lead.id)).id, lead.id);
    assert.equal(await deleteUnregisteredRestaurant(lead.id), null);
    await assert.rejects(() => deleteUnregisteredRestaurant('bad'), /Invalid unregistered restaurant id/);

    created.unregistered = created.unregistered.filter((id) => id !== lead.id);
});
