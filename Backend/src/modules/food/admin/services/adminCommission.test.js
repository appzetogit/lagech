import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../../config/prisma.js';
import {
    getRestaurantCommissions,
    getRestaurantCommissionById,
    createRestaurantCommission,
    updateRestaurantCommission,
    deleteRestaurantCommission,
    toggleRestaurantCommissionStatus,
    getDeliveryCommissionRules,
    createDeliveryCommissionRule,
    updateDeliveryCommissionRule,
    deleteDeliveryCommissionRule,
    toggleDeliveryCommissionRuleStatus,
} from './adminCommission.service.js';
import { uniquePhone } from '../../../../utils/testIds.js';

/**
 * Commission rates and delivery payout slabs.
 *
 * Both decide what money moves, so the interesting assertions are the ones
 * about what the database refuses rather than what the happy path returns.
 */
const live = Boolean(process.env.DATABASE_URL);

const created = { restaurants: [], commissions: [], rules: [] };
const stamp = () => `${Date.now()}${Math.floor(performance.now() * 1000) % 1000}`;

const makeRestaurant = async () => {
    const r = await prisma.foodRestaurant.create({
        data: {
            restaurantName: `Commission Test ${stamp()}`,
            ownerName: 'Owner',
            ownerPhone: uniquePhone('9'),
            status: 'approved',
        },
    });
    created.restaurants.push(r.id);
    return r;
};

const makeRule = async (body) => {
    const rule = await createDeliveryCommissionRule(body);
    created.rules.push(rule.id);
    return rule;
};

// The slab ladder is global, so each test starts from a clean one.
const clearRules = async () => {
    await prisma.foodDeliveryCommissionRule.deleteMany({});
    created.rules = [];
};

test.after(async () => {
    if (!live) return;
    await prisma.foodRestaurantCommission.deleteMany({ where: { id: { in: created.commissions } } });
    await prisma.foodDeliveryCommissionRule.deleteMany({ where: { id: { in: created.rules } } });
    await prisma.foodRestaurant.deleteMany({ where: { id: { in: created.restaurants } } });
    await prisma.$disconnect();
});

test('a commission round-trips through its nested shape', { skip: !live }, async () => {
    const restaurant = await makeRestaurant();

    const created1 = await createRestaurantCommission({
        restaurantId: restaurant.id,
        defaultCommission: { type: 'percentage', value: 18.5 },
        notes: 'Standard rate',
    });
    created.commissions.push(created1.id);

    // Stored as two columns, read back nested — the admin screens send and
    // expect { type, value }.
    assert.deepEqual(created1.defaultCommission, { type: 'percentage', value: 18.5 });
    assert.equal(created1.restaurantName, restaurant.restaurantName);

    const row = await prisma.foodRestaurantCommission.findUnique({ where: { id: created1.id } });
    assert.equal(row.commissionType, 'percentage');
    assert.equal(Number(row.commissionValue), 18.5);

    const fetched = await getRestaurantCommissionById(created1.id);
    assert.deepEqual(fetched.defaultCommission, { type: 'percentage', value: 18.5 });
});

test('one commission per restaurant', { skip: !live }, async () => {
    const restaurant = await makeRestaurant();

    const first = await createRestaurantCommission({
        restaurantId: restaurant.id,
        defaultCommission: { type: 'amount', value: 25 },
    });
    created.commissions.push(first.id);

    // The unique index settles it, not a lookup two admins could both pass.
    await assert.rejects(
        () => createRestaurantCommission({
            restaurantId: restaurant.id,
            defaultCommission: { type: 'amount', value: 30 },
        }),
        /already exists/,
    );
});

test('a nonsensical commission value is refused', { skip: !live }, async () => {
    const restaurant = await makeRestaurant();

    await assert.rejects(
        () => createRestaurantCommission({
            restaurantId: restaurant.id,
            defaultCommission: { type: 'percentage', value: 150 },
        }),
        /cannot exceed 100/,
        'a rate over 100% would pay the platform more than the order was worth',
    );

    await assert.rejects(
        () => createRestaurantCommission({
            restaurantId: restaurant.id,
            defaultCommission: { type: 'percentage', value: -5 },
        }),
        /non-negative/,
    );
});

test('a commission for an unknown restaurant is refused', { skip: !live }, async () => {
    await assert.rejects(
        () => createRestaurantCommission({
            restaurantId: 'a'.repeat(24),
            defaultCommission: { type: 'percentage', value: 10 },
        }),
        /Restaurant not found/,
        'the foreign key would otherwise surface as a raw database error',
    );
});

test('a commission updates, toggles and deletes', { skip: !live }, async () => {
    const restaurant = await makeRestaurant();
    const commission = await createRestaurantCommission({
        restaurantId: restaurant.id,
        defaultCommission: { type: 'percentage', value: 10 },
    });
    created.commissions.push(commission.id);

    const updated = await updateRestaurantCommission(commission.id, {
        defaultCommission: { type: 'amount', value: 40 },
        notes: 'Negotiated',
    });
    assert.deepEqual(updated.defaultCommission, { type: 'amount', value: 40 });
    assert.equal(updated.notes, 'Negotiated');

    assert.equal((await toggleRestaurantCommissionStatus(commission.id)).status, false);
    assert.equal((await toggleRestaurantCommissionStatus(commission.id)).status, true);

    const { commissions } = await getRestaurantCommissions();
    assert.ok(commissions.some((c) => c._id === commission.id));

    assert.deepEqual(await deleteRestaurantCommission(commission.id), { id: commission.id });
    assert.equal(await getRestaurantCommissionById(commission.id), null);
    // Deleting one that has already gone is null, not a thrown P2025.
    assert.equal(await deleteRestaurantCommission(commission.id), null);

    created.commissions = created.commissions.filter((id) => id !== commission.id);
});

test('the slab ladder needs exactly one base slab', { skip: !live }, async () => {
    await clearRules();

    await assert.rejects(
        () => makeRule({ minDistance: 2, maxDistance: 5, commissionPerKm: 5, basePayout: 20 }),
        /base slab with minDistance = 0/,
        'without a slab starting at 0, a short trip prices at nothing',
    );

    const base = await makeRule({ minDistance: 0, maxDistance: 3, commissionPerKm: 0, basePayout: 30 });
    assert.equal(base.basePayout, 30);

    await assert.rejects(
        () => makeRule({ minDistance: 0, maxDistance: 8, commissionPerKm: 4, basePayout: 25 }),
        /base slab with minDistance = 0/,
        'a second slab starting at 0 is a second base, caught before the overlap rule',
    );
});

test('slabs that sit flush are accepted, overlapping ones are not', { skip: !live }, async () => {
    await clearRules();

    await makeRule({ minDistance: 0, maxDistance: 3, commissionPerKm: 0, basePayout: 30 });
    // [0,3) and [3,7) share an endpoint but no distance — the ranges are
    // half-open, exactly as the fee bands are.
    const next = await makeRule({ minDistance: 3, maxDistance: 7, commissionPerKm: 6, basePayout: 0 });
    assert.equal(next.minDistance, 3);

    // A final open-ended slab: everything beyond 7km.
    const tail = await makeRule({ minDistance: 7, maxDistance: null, commissionPerKm: 8, basePayout: 0 });
    assert.equal(tail.maxDistance, null);

    await assert.rejects(
        () => makeRule({ minDistance: 5, maxDistance: 9, commissionPerKm: 7, basePayout: 0 }),
        /must not overlap/,
    );
});

test('the database refuses an overlap the JS check never saw', { skip: !live }, async () => {
    await clearRules();
    await makeRule({ minDistance: 0, maxDistance: 5, commissionPerKm: 0, basePayout: 30 });

    // Straight past the service, as a second admin's concurrent save would
    // effectively be: its validation ran against a set without this slab.
    await assert.rejects(
        () => prisma.foodDeliveryCommissionRule.create({
            data: { minDistance: 2, maxDistance: 8, commissionPerKm: 5, basePayout: 0, status: true },
        }),
        /no_overlap|exclusion/i,
        'the EXCLUDE constraint is what makes the rule true under concurrency',
    );
});

test('an inactive slab may sit under a live one', { skip: !live }, async () => {
    await clearRules();
    await makeRule({ minDistance: 0, maxDistance: 5, commissionPerKm: 0, basePayout: 30 });

    // A disabled slab prices nothing, so it is allowed to overlap while an
    // admin reworks the ladder.
    const parked = await prisma.foodDeliveryCommissionRule.create({
        data: { minDistance: 1, maxDistance: 4, commissionPerKm: 9, basePayout: 0, status: false },
    });
    created.rules.push(parked.id);

    assert.equal(parked.status, false);

    // Switching it back on would collide, and is refused.
    await assert.rejects(
        () => toggleDeliveryCommissionRuleStatus(parked.id, true),
        /no_overlap|exclusion/i,
    );
});

test('an inverted slab is refused', { skip: !live }, async () => {
    await clearRules();
    await makeRule({ minDistance: 0, maxDistance: 5, commissionPerKm: 0, basePayout: 30 });

    await assert.rejects(
        () => makeRule({ minDistance: 9, maxDistance: 6, commissionPerKm: 5, basePayout: 0 }),
        /maxDistance must be greater/,
    );
});

test('slabs list, update and delete', { skip: !live }, async () => {
    await clearRules();
    const base = await makeRule({ minDistance: 0, maxDistance: 4, commissionPerKm: 0, basePayout: 30 });
    await makeRule({ minDistance: 4, maxDistance: null, commissionPerKm: 7, basePayout: 0 });

    const { commissions } = await getDeliveryCommissionRules();
    assert.equal(commissions.length, 2);
    assert.equal(typeof commissions[0].basePayout, 'number', 'Decimal is converted for the client');

    const widened = await updateDeliveryCommissionRule(base.id, {
        name: 'Base', minDistance: 0, maxDistance: 4, commissionPerKm: 0, basePayout: 35,
    });
    assert.equal(widened.basePayout, 35);
    assert.equal(widened.name, 'Base');

    assert.equal(await updateDeliveryCommissionRule('a'.repeat(24), {}), null);
    assert.deepEqual(await deleteDeliveryCommissionRule(base.id), { id: base.id });
    assert.equal(await deleteDeliveryCommissionRule(base.id), null);

    created.rules = created.rules.filter((id) => id !== base.id);
});
