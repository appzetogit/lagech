import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../../config/prisma.js';
import {
    getEarningAddons,
    createEarningAddon,
    updateEarningAddon,
    deleteEarningAddon,
    toggleEarningAddonStatus,
    getEarningAddonHistory,
    creditEarningAddonHistory,
    cancelEarningAddonHistory,
    checkEarningAddonCompletions,
} from './adminEarningAddon.service.js';

/**
 * Rider incentives.
 *
 * Both interesting tests are about paying once: crediting a grant, and
 * granting one in the first place. Each used to be a check followed by a
 * separate write.
 */
const live = Boolean(process.env.DATABASE_URL);

const created = { partners: [], restaurants: [], orders: [], addons: [], history: [] };
const stamp = () => `${Date.now()}${Math.floor(performance.now() * 1000) % 1000}`;

const DAY = 86400000;
const past = new Date(Date.now() - DAY);
const future = new Date(Date.now() + DAY);

const makePartner = async () => {
    const partner = await prisma.foodDeliveryPartner.create({
        data: {
            name: `Incentive Rider ${stamp()}`,
            phone: `6${String(Date.now()).slice(-8)}${created.partners.length}`,
            status: 'approved',
        },
    });
    created.partners.push(partner.id);
    return partner;
};

const makeAddon = async (over = {}) => {
    const addon = await createEarningAddon({
        title: `Weekend Push ${stamp()}`,
        requiredOrders: 2,
        earningAmount: 300,
        startDate: past,
        endDate: future,
        ...over,
    });
    created.addons.push(addon.id);
    return addon;
};

const makeDeliveredOrders = async (partner, count) => {
    const restaurant = await prisma.foodRestaurant.create({
        data: {
            restaurantName: `Inc Rest ${stamp()}`,
            ownerName: 'Owner',
            ownerPhone: `9${String(Date.now()).slice(-9)}`,
            status: 'approved',
        },
    });
    created.restaurants.push(restaurant.id);

    const user = await prisma.foodUser.create({
        data: { phone: `5${String(Date.now()).slice(-9)}` },
    });

    for (let i = 0; i < count; i += 1) {
        const order = await prisma.foodOrder.create({
            data: {
                userId: user.id,
                restaurantId: restaurant.id,
                dispatchDeliveryPartnerId: partner.id,
                orderStatus: 'delivered',
                paymentMethod: 'cash',
                addrStreet: '1 Test Street',
                addrCity: 'Indore',
                addrState: 'MP',
                subtotal: 100,
                total: 100,
            },
        });
        created.orders.push(order.id);
    }
    return user;
};

/**
 * The sweep walks every currently-active offer, and these tests share a
 * database — so the global `completionsFound` counts other tests' offers too.
 * Every assertion here is scoped to the offer under test instead.
 */
const grantsFor = (offerId, deliveryPartnerId) =>
    prisma.foodEarningAddonHistory.count({ where: { offerId, deliveryPartnerId } });

const walletOf = (partnerId) =>
    prisma.wallet.findUnique({
        where: { entityType_entityId: { entityType: 'deliveryBoy', entityId: partnerId } },
    });

test.after(async () => {
    if (!live) return;
    await prisma.deliveryBonusTransaction.deleteMany({
        where: { deliveryPartnerId: { in: created.partners } },
    });
    await prisma.foodEarningAddonHistory.deleteMany({ where: { offerId: { in: created.addons } } });
    await prisma.foodEarningAddon.deleteMany({ where: { id: { in: created.addons } } });
    await prisma.foodOrder.deleteMany({ where: { id: { in: created.orders } } });
    await prisma.wallet.deleteMany({ where: { entityId: { in: created.partners } } });
    await prisma.foodDeliveryPartner.deleteMany({ where: { id: { in: created.partners } } });
    await prisma.foodRestaurant.deleteMany({ where: { id: { in: created.restaurants } } });
    await prisma.$disconnect();
});

test('an addon reports expired from its dates, not its status', { skip: !live }, async () => {
    const running = await makeAddon();
    assert.equal(running.isValid, true);
    assert.equal(running.status, 'active');

    const done = await makeAddon({
        startDate: new Date(Date.now() - 3 * DAY),
        endDate: new Date(Date.now() - DAY),
    });

    const { earningAddons } = await getEarningAddons();
    const row = earningAddons.find((a) => a.id === done.id);
    // 'expired' is derived, never stored — the column still says active.
    assert.equal(row.status, 'expired');
    assert.equal(row.isValid, false);
});

test('an addon updates, toggles and deletes', { skip: !live }, async () => {
    const addon = await makeAddon();

    const updated = await updateEarningAddon(addon.id, {
        title: 'Renamed', requiredOrders: 5, earningAmount: 500,
        startDate: past, endDate: future,
    });
    assert.equal(updated.title, 'Renamed');
    assert.equal(updated.earningAmount, 500, 'Decimal converted for the client');

    assert.equal((await toggleEarningAddonStatus(addon.id, 'inactive')).status, 'inactive');
    assert.equal(await updateEarningAddon('a'.repeat(24), {}), null);

    assert.deepEqual(await deleteEarningAddon(addon.id), { id: addon.id });
    assert.equal(await deleteEarningAddon(addon.id), null);
    created.addons = created.addons.filter((id) => id !== addon.id);
});

test('a qualifying partner is granted once, not once per sweep', { skip: !live }, async () => {
    const partner = await makePartner();
    const addon = await makeAddon({ requiredOrders: 2 });
    await makeDeliveredOrders(partner, 3);

    await checkEarningAddonCompletions(partner.id);
    assert.equal(await grantsFor(addon.id, partner.id), 1);

    // The second sweep must not grant this offer again.
    await checkEarningAddonCompletions(partner.id);
    assert.equal(await grantsFor(addon.id, partner.id), 1);
});

test('concurrent sweeps cannot double-grant', { skip: !live }, async () => {
    const partner = await makePartner();
    const addon = await makeAddon({ requiredOrders: 1 });
    await makeDeliveredOrders(partner, 2);

    // Both sweeps look, both find nothing, both try to insert. The partial
    // unique index is what stops the second one.
    await Promise.allSettled([
        checkEarningAddonCompletions(partner.id),
        checkEarningAddonCompletions(partner.id),
    ]);

    assert.equal(await grantsFor(addon.id, partner.id), 1, 'one grant survives the race');
});

test('a partner short of the target is not granted', { skip: !live }, async () => {
    const partner = await makePartner();
    const addon = await makeAddon({ requiredOrders: 10 });
    await makeDeliveredOrders(partner, 2);

    await checkEarningAddonCompletions(partner.id);
    // Two delivered orders against a target of ten.
    assert.equal(await grantsFor(addon.id, partner.id), 0);
});

test('a capped addon stops granting once it is exhausted', { skip: !live }, async () => {
    const addon = await makeAddon({ requiredOrders: 1, maxRedemptions: 1 });

    const first = await makePartner();
    await makeDeliveredOrders(first, 1);
    await checkEarningAddonCompletions(first.id);
    assert.equal(await grantsFor(addon.id, first.id), 1);

    const second = await makePartner();
    await makeDeliveredOrders(second, 1);
    await checkEarningAddonCompletions(second.id);
    // maxRedemptions was stored and never checked, so a capped offer could be
    // granted without limit.
    assert.equal(await grantsFor(addon.id, second.id), 0, 'the cap is reached');

    const row = await prisma.foodEarningAddon.findUnique({ where: { id: addon.id } });
    assert.equal(row.currentRedemptions, 1, 'the counter cannot overshoot the cap');
});

test('crediting pays the wallet and writes a ledger row', { skip: !live }, async () => {
    const partner = await makePartner();
    const addon = await makeAddon({ requiredOrders: 1, earningAmount: 250 });
    await makeDeliveredOrders(partner, 1);
    await checkEarningAddonCompletions(partner.id);

    const grant = await prisma.foodEarningAddonHistory.findFirst({
        where: { offerId: addon.id, deliveryPartnerId: partner.id },
    });

    const credited = await creditEarningAddonHistory(grant.id, 'Verified');
    assert.equal(credited.status, 'credited');

    const wallet = await walletOf(partner.id);
    assert.equal(Number(wallet.balance), 250);
    assert.equal(Number(wallet.totalEarnings), 250);

    // The ledger write shares the transaction: it used to be fire-and-forget,
    // so a failure left the balance moving with nothing explaining it.
    const ledger = await prisma.deliveryBonusTransaction.findMany({
        where: { deliveryPartnerId: partner.id },
    });
    assert.equal(ledger.length, 1);
    assert.equal(Number(ledger[0].amount), 250);
});

test('two admins crediting at once pay once', { skip: !live }, async () => {
    const partner = await makePartner();
    const addon = await makeAddon({ requiredOrders: 1, earningAmount: 400 });
    await makeDeliveredOrders(partner, 1);
    await checkEarningAddonCompletions(partner.id);

    const grant = await prisma.foodEarningAddonHistory.findFirst({
        where: { offerId: addon.id, deliveryPartnerId: partner.id },
    });

    await Promise.allSettled([
        creditEarningAddonHistory(grant.id, 'a'),
        creditEarningAddonHistory(grant.id, 'b'),
    ]);

    const wallet = await walletOf(partner.id);
    assert.equal(Number(wallet.balance), 400, 'credited once, not twice');

    const ledger = await prisma.deliveryBonusTransaction.count({
        where: { deliveryPartnerId: partner.id },
    });
    assert.equal(ledger, 1, 'one ledger row');
});

test('an already-decided grant is not credited again', { skip: !live }, async () => {
    const partner = await makePartner();
    const addon = await makeAddon({ requiredOrders: 1, earningAmount: 100 });
    await makeDeliveredOrders(partner, 1);
    await checkEarningAddonCompletions(partner.id);

    const grant = await prisma.foodEarningAddonHistory.findFirst({
        where: { offerId: addon.id, deliveryPartnerId: partner.id },
    });

    const cancelled = await cancelEarningAddonHistory(grant.id, 'Fraud suspected');
    assert.equal(cancelled.status, 'cancelled');

    // Crediting a cancelled grant returns it unchanged rather than paying.
    const attempted = await creditEarningAddonHistory(grant.id, 'oops');
    assert.equal(attempted.status, 'cancelled');
    assert.equal(await walletOf(partner.id), null, 'no wallet was ever created');
});

test('a cancelled grant can be earned again', { skip: !live }, async () => {
    const partner = await makePartner();
    const addon = await makeAddon({ requiredOrders: 1 });
    await makeDeliveredOrders(partner, 1);
    await checkEarningAddonCompletions(partner.id);

    const grant = await prisma.foodEarningAddonHistory.findFirst({
        where: { offerId: addon.id, deliveryPartnerId: partner.id },
    });
    await cancelEarningAddonHistory(grant.id, 'Mistake');

    // The unique index excludes cancelled rows for exactly this reason.
    // The unique index excludes cancelled rows for exactly this reason.
    await checkEarningAddonCompletions(partner.id);
    const rows = await prisma.foodEarningAddonHistory.findMany({
        where: { offerId: addon.id, deliveryPartnerId: partner.id },
    });
    assert.equal(rows.length, 2, 'the cancelled row plus a fresh grant');
    assert.ok(rows.some((r) => r.status === 'pending'));
});

test('history lists and searches by partner or offer', { skip: !live }, async () => {
    const partner = await makePartner();
    const addon = await makeAddon({ requiredOrders: 1 });
    await makeDeliveredOrders(partner, 1);
    await checkEarningAddonCompletions(partner.id);

    // The partner name is unique to this test, so it scopes the search.
    const byPartner = await getEarningAddonHistory({ search: partner.name });
    assert.ok(byPartner.pagination.total >= 1);
    assert.ok(byPartner.history.every((h) => h.deliveryman === partner.name));
    assert.match(byPartner.history[0].deliveryId, /^DP-/);

    // The search reaches through both relations in one query now.
    const byOffer = await getEarningAddonHistory({ search: addon.title });
    assert.ok(byOffer.history.some((h) => h.offerTitle === addon.title));

    assert.equal((await getEarningAddonHistory({ search: `nothing${stamp()}` })).pagination.total, 0);
});
