import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../../config/prisma.js';
import {
    getBulkDeliveryPartnerStats,
    getDeliveryPartners,
    getDeliveryPartnerById,
    getDeliveryJoinRequests,
    approveDeliveryPartner,
    rejectDeliveryPartner,
    updateDeliveryPartnerProfile,
} from './adminDeliveryPartner.service.js';
import { uniquePhone } from '../../../../utils/testIds.js';

/**
 * The admin rider list and its money summary.
 *
 * The summary is the part worth pinning: pocketBalance and cashInHand are
 * derived from five separate tables, and getting one of them wrong shows an
 * admin the wrong figure for what a rider is owed or holds.
 */
const live = Boolean(process.env.DATABASE_URL);

const created = { partners: [], restaurants: [], users: [], orders: [] };
const stamp = () => `${Date.now()}${Math.floor(performance.now() * 1000) % 1000}`;

const makePartner = async (over = {}) => {
    const partner = await prisma.foodDeliveryPartner.create({
        data: {
            name: `Rider ${stamp()}`,
            phone: uniquePhone('6'),
            status: 'approved',
            ...over,
        },
    });
    created.partners.push(partner.id);
    return partner;
};

const makeOrders = async (partner, rows) => {
    const restaurant = await prisma.foodRestaurant.create({
        data: {
            restaurantName: `DP Rest ${stamp()}`,
            ownerName: 'Owner',
            ownerPhone: uniquePhone('9'),
            status: 'approved',
        },
    });
    created.restaurants.push(restaurant.id);

    const user = await prisma.foodUser.create({ data: { phone: uniquePhone('5') } });
    created.users.push(user.id);

    for (const row of rows) {
        const order = await prisma.foodOrder.create({
            data: {
                userId: user.id,
                restaurantId: restaurant.id,
                dispatchDeliveryPartnerId: partner.id,
                orderStatus: row.orderStatus || 'delivered',
                paymentMethod: row.paymentMethod || 'cash',
                addrStreet: '1 Test Street',
                addrCity: 'Indore',
                addrState: 'MP',
                subtotal: row.total,
                total: row.total,
                riderEarning: row.riderEarning || 0,
            },
        });
        created.orders.push(order.id);
    }
};

test.after(async () => {
    if (!live) return;
    await prisma.foodDeliveryWithdrawal.deleteMany({
        where: { deliveryPartnerId: { in: created.partners } },
    });
    await prisma.deliveryBonusTransaction.deleteMany({
        where: { deliveryPartnerId: { in: created.partners } },
    });
    await prisma.foodDeliveryCashDeposit.deleteMany({
        where: { deliveryPartnerId: { in: created.partners } },
    });
    await prisma.foodOrder.deleteMany({ where: { id: { in: created.orders } } });
    await prisma.foodUser.deleteMany({ where: { id: { in: created.users } } });
    await prisma.foodDeliveryPartner.deleteMany({ where: { id: { in: created.partners } } });
    await prisma.foodRestaurant.deleteMany({ where: { id: { in: created.restaurants } } });
    await prisma.$disconnect();
});

test('pocket balance is earnings plus bonus, less paid and claimed', { skip: !live }, async () => {
    const partner = await makePartner();

    await makeOrders(partner, [
        { total: 300, riderEarning: 60, paymentMethod: 'cash' },
        { total: 200, riderEarning: 40, paymentMethod: 'cash' },
        // Not delivered, so it counts for nothing.
        { total: 900, riderEarning: 90, orderStatus: 'cancelled_by_user' },
    ]);

    await prisma.deliveryBonusTransaction.create({
        data: {
            deliveryPartnerId: partner.id,
            transactionId: `BON-${stamp()}`,
            amount: 50,
        },
    });
    await prisma.foodDeliveryWithdrawal.create({
        data: { deliveryPartnerId: partner.id, amount: 30, status: 'approved' },
    });
    await prisma.foodDeliveryWithdrawal.create({
        data: { deliveryPartnerId: partner.id, amount: 20, status: 'pending' },
    });

    const stats = (await getBulkDeliveryPartnerStats([partner.id])).get(partner.id);

    assert.equal(stats.totalEarning, 100, 'delivered orders only');
    assert.equal(stats.totalOrders, 2);
    assert.equal(stats.bonus, 50);
    assert.equal(stats.totalWithdrawn, 30);
    assert.equal(stats.pendingWithdrawal, 20);
    // 100 + 50 - 30 - 20. A pending claim is already spoken for.
    assert.equal(stats.pocketBalance, 100);
});

test('cash in hand is what was collected less what was handed in', { skip: !live }, async () => {
    const partner = await makePartner();

    await makeOrders(partner, [
        { total: 500, riderEarning: 50, paymentMethod: 'cash' },
        // Prepaid: the rider never touched this money.
        { total: 400, riderEarning: 40, paymentMethod: 'razorpay' },
    ]);

    await prisma.foodDeliveryCashDeposit.create({
        data: { deliveryPartnerId: partner.id, amount: 200, status: 'Completed' },
    });
    // A pending deposit has not actually been handed over yet.
    await prisma.foodDeliveryCashDeposit.create({
        data: { deliveryPartnerId: partner.id, amount: 100, status: 'Pending' },
    });

    const stats = (await getBulkDeliveryPartnerStats([partner.id])).get(partner.id);

    assert.equal(stats.cashCollected, 500, 'only the COD order');
    assert.equal(stats.totalDeposited, 200, 'only completed deposits');
    assert.equal(stats.cashInHand, 300);
});

test('a rider with no activity reports zeroes', { skip: !live }, async () => {
    const partner = await makePartner();
    const stats = (await getBulkDeliveryPartnerStats([partner.id])).get(partner.id);

    assert.equal(stats.totalEarning, 0);
    assert.equal(stats.pocketBalance, 0);
    assert.equal(stats.cashInHand, 0);
    assert.equal(stats.totalOrders, 0);

    assert.equal((await getBulkDeliveryPartnerStats([])).size, 0);
});

test('the list flags riders dispatch cannot actually reach', { skip: !live }, async () => {
    const reachable = await makePartner({ availabilityStatus: 'online', fcmTokenMobile: ['tok-1'] });
    const stranded = await makePartner({ availabilityStatus: 'online' });

    const { deliveryPartners } = await getDeliveryPartners({ limit: 1000 });

    const a = deliveryPartners.find((p) => p._id === reachable.id);
    const b = deliveryPartners.find((p) => p._id === stranded.id);

    assert.equal(a.isOnline, true);
    assert.equal(a.hasPushToken, true);
    // Online but unreachable: the list used to show this rider as simply green.
    assert.equal(b.isOnline, true);
    assert.equal(b.hasPushToken, false);
});

test('a rider location is exposed in both shapes', { skip: !live }, async () => {
    const partner = await makePartner({
        lastLat: 22.7196,
        lastLng: 75.8577,
        lastLocationAt: new Date(),
    });

    const row = await getDeliveryPartnerById(partner.id);
    assert.equal(row.lastLat, 22.7196);
    assert.equal(row.lastLocation.latitude, 22.7196);
    assert.equal(row.lastLocation.lng, 75.8577);
    assert.ok(Number.isFinite(row.lastLocation.timestamp));
    assert.match(row.deliveryId, /^DP-/);

    const noGeo = await getDeliveryPartnerById((await makePartner()).id);
    assert.equal(noGeo.lastLocation, null, 'no coordinates means no location object');

    assert.equal(await getDeliveryPartnerById('a'.repeat(24)), null);
    assert.equal(await getDeliveryPartnerById('not-an-id'), null);
});

test('the partner list searches and excludes unapproved riders', { skip: !live }, async () => {
    const unique = `Findable${stamp()}`;
    const approved = await makePartner({ name: `${unique} Approved` });
    const pending = await makePartner({ name: `${unique} Pending`, status: 'pending' });

    const { deliveryPartners, pagination } = await getDeliveryPartners({ search: unique });
    assert.equal(pagination.total, 1, 'the approved list is approved riders only');
    assert.equal(deliveryPartners[0]._id, approved.id);

    // The pending one shows up as a join request instead.
    const { requests } = await getDeliveryJoinRequests({ search: unique });
    assert.equal(requests.length, 1);
    assert.equal(requests[0]._id, pending.id);
});

test('join requests report a rejection as denied', { skip: !live }, async () => {
    const partner = await makePartner({ status: 'pending' });

    const rejected = await rejectDeliveryPartner(partner.id, 'Documents unreadable');
    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.rejectionReason, 'Documents unreadable');

    // The column says rejected; the screen says denied.
    const { requests } = await getDeliveryJoinRequests({ status: 'denied' });
    const row = requests.find((r) => r._id === partner.id);
    assert.equal(row.status, 'denied');
    assert.equal(row.rejectionReason, 'Documents unreadable');
});

test('a rejected applicant can still be approved later', { skip: !live }, async () => {
    const partner = await makePartner({ status: 'pending' });

    await rejectDeliveryPartner(partner.id, 'Blurry licence');
    const approved = await approveDeliveryPartner(partner.id);

    // Reconsidering an application is a real workflow, not an accident.
    assert.equal(approved.status, 'approved');
    assert.ok(approved.approvedAt);
    // undefined would mean "leave alone" to Prisma, so the stale rejection
    // would have survived the approval.
    assert.equal(approved.rejectedAt, null);
    assert.equal(approved.rejectionReason, '');
});

test('deciding an unknown application returns null', { skip: !live }, async () => {
    assert.equal(await approveDeliveryPartner('a'.repeat(24)), null);
    assert.equal(await rejectDeliveryPartner('a'.repeat(24), 'x'), null);
    assert.equal(await approveDeliveryPartner('not-an-id'), null);
});

test('a rider profile edit trims the name and rejects a blank one', { skip: !live }, async () => {
    const partner = await makePartner();

    const renamed = await updateDeliveryPartnerProfile(partner.id, { name: '  Renamed  ' });
    assert.equal(renamed.name, 'Renamed');

    await assert.rejects(
        () => updateDeliveryPartnerProfile(partner.id, { name: '   ' }),
        /Name cannot be empty/,
    );

    // An edit that changes nothing returns the partner untouched.
    const unchanged = await updateDeliveryPartnerProfile(partner.id, {});
    assert.equal(unchanged.name, 'Renamed');

    // The phone rules — ten digits, unused, and the session invalidation that
    // comes with a number change — are covered in adminDeliveryWallet.test.js,
    // which owns that behaviour.
});
