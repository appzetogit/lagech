import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../../config/prisma.js';
import {
    getDeliveryWallets,
    updateDeliveryBoyWallet,
    getCashLimitSettlements,
} from './adminDeliveryWallet.service.js';
import {
    updateDeliveryPartnerProfile,
    deleteDeliveryPartner,
} from './adminDeliveryPartner.service.js';

/**
 * Rider wallets, cash settlements, and the two writes that change who can log
 * in as a rider.
 */
const live = Boolean(process.env.DATABASE_URL);

const created = { partners: [], restaurants: [], users: [], orders: [], deposits: [], limits: [] };
const stamp = () => `${Date.now()}${Math.floor(performance.now() * 1000) % 1000}`;

const phone10 = () => String(6000000000 + (Number(String(Date.now()).slice(-8)) % 999999999)).slice(0, 10);

const makePartner = async (over = {}) => {
    const partner = await prisma.foodDeliveryPartner.create({
        data: {
            name: `Wallet Rider ${stamp()}`,
            phone: `7${String(Date.now()).slice(-8)}${created.partners.length}`,
            status: 'approved',
            ...over,
        },
    });
    created.partners.push(partner.id);
    return partner;
};

const makeCodOrders = async (partner, totals) => {
    const restaurant = await prisma.foodRestaurant.create({
        data: {
            restaurantName: `W Rest ${stamp()}`,
            ownerName: 'Owner',
            ownerPhone: `9${String(Date.now()).slice(-9)}`,
            status: 'approved',
        },
    });
    created.restaurants.push(restaurant.id);

    const user = await prisma.foodUser.create({ data: { phone: `5${String(Date.now()).slice(-9)}` } });
    created.users.push(user.id);

    for (const total of totals) {
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
                subtotal: total,
                total,
                riderEarning: 20,
            },
        });
        created.orders.push(order.id);
    }
};

test.after(async () => {
    if (!live) return;
    await prisma.foodDeliveryCashDeposit.deleteMany({ where: { id: { in: created.deposits } } });
    await prisma.foodOrder.deleteMany({ where: { id: { in: created.orders } } });
    await prisma.wallet.deleteMany({ where: { entityId: { in: created.partners } } });
    await prisma.foodDeliveryPartner.deleteMany({ where: { id: { in: created.partners } } });
    await prisma.foodUser.deleteMany({ where: { id: { in: created.users } } });
    await prisma.foodRestaurant.deleteMany({ where: { id: { in: created.restaurants } } });
    await prisma.foodDeliveryCashLimit.deleteMany({ where: { id: { in: created.limits } } });
    await prisma.$disconnect();
});

test('remaining cash limit is the cap less what the rider holds', { skip: !live }, async () => {
    await prisma.foodDeliveryCashLimit.updateMany({ where: {}, data: { isActive: false } });
    const limit = await prisma.foodDeliveryCashLimit.create({
        data: { deliveryCashLimit: 3000, isActive: true },
    });
    created.limits.push(limit.id);

    const partner = await makePartner();
    await makeCodOrders(partner, [800, 400]);

    const deposit = await prisma.foodDeliveryCashDeposit.create({
        data: { deliveryPartnerId: partner.id, amount: 200, status: 'Completed' },
    });
    created.deposits.push(deposit.id);

    const { wallets } = await getDeliveryWallets({ search: partner.name, limit: 500 });
    const row = wallets.find((w) => w.deliveryId === partner.id);

    assert.equal(row.cashCollected, 1000, '1200 collected less 200 handed in');
    assert.equal(row.availableCashLimit, 3000);
    // How much more COD this rider may take before settling up.
    assert.equal(row.remainingCashLimit, 2000);
    assert.equal(row.totalOrders, 2);
});

test('a rider over the cap has no remaining limit, never a negative one', { skip: !live }, async () => {
    await prisma.foodDeliveryCashLimit.updateMany({ where: {}, data: { isActive: false } });
    const limit = await prisma.foodDeliveryCashLimit.create({
        data: { deliveryCashLimit: 500, isActive: true },
    });
    created.limits.push(limit.id);

    const partner = await makePartner();
    await makeCodOrders(partner, [900]);

    const { wallets } = await getDeliveryWallets({ search: partner.name, limit: 500 });
    const row = wallets.find((w) => w.deliveryId === partner.id);

    assert.equal(row.cashCollected, 900);
    assert.equal(row.remainingCashLimit, 0, 'clamped, so the UI never shows a negative allowance');
});

test('a manual wallet adjustment creates the row if there is none', { skip: !live }, async () => {
    const partner = await makePartner();

    const created1 = await updateDeliveryBoyWallet({
        deliveryId: partner.id,
        pocketBalance: 250,
        cashInHand: 100,
    });
    assert.equal(Number(created1.balance), 250);
    assert.equal(Number(created1.cashInHand), 100);
    assert.equal(created1.entityType, 'deliveryBoy');

    // A second call edits the same row rather than adding another.
    const updated = await updateDeliveryBoyWallet({ deliveryId: partner.id, pocketBalance: 400 });
    assert.equal(Number(updated.balance), 400);
    assert.equal(Number(updated.cashInHand), 100, 'an unmentioned field is left alone');

    const count = await prisma.wallet.count({ where: { entityId: partner.id } });
    assert.equal(count, 1);
});

test('a wallet adjustment for an unknown rider is refused', { skip: !live }, async () => {
    await assert.rejects(
        () => updateDeliveryBoyWallet({ deliveryId: 'a'.repeat(24), pocketBalance: 10 }),
        /not found/,
    );
    await assert.rejects(
        () => updateDeliveryBoyWallet({ pocketBalance: 10 }),
        /ID required/,
    );
});

test('settlements search by gateway reference or by rider', { skip: !live }, async () => {
    const partner = await makePartner();
    const reference = `pay_${stamp()}`;

    const deposit = await prisma.foodDeliveryCashDeposit.create({
        data: {
            deliveryPartnerId: partner.id,
            amount: 750,
            status: 'Completed',
            razorpayPaymentId: reference,
        },
    });
    created.deposits.push(deposit.id);

    const byReference = await getCashLimitSettlements({ search: reference });
    assert.equal(byReference.pagination.total, 1);
    assert.equal(byReference.transactions[0].amount, 750);
    assert.equal(byReference.transactions[0].deliveryName, partner.name);

    // Searching by rider is new — the Mongo version could only match a gateway
    // reference, because the name lives on another collection.
    const byRider = await getCashLimitSettlements({ search: partner.name });
    assert.equal(byRider.pagination.total, 1);
    assert.equal(byRider.transactions[0].id, deposit.id);
});

test('changing a rider phone ends their sessions', { skip: !live }, async () => {
    const partner = await makePartner();
    const before = partner.tokenVersion;

    const updated = await updateDeliveryPartnerProfile(partner.id, { phone: phone10() });
    assert.notEqual(updated.phone, partner.phone);
    // The number is the login, so the old handset must stop being accepted.
    assert.equal(updated.tokenVersion, before + 1);

    // A name-only edit is not a login change.
    const renamed = await updateDeliveryPartnerProfile(partner.id, { name: 'New Name' });
    assert.equal(renamed.name, 'New Name');
    assert.equal(renamed.tokenVersion, updated.tokenVersion);
});

test('a rider phone must be ten digits and unused', { skip: !live }, async () => {
    const partner = await makePartner();
    const other = await makePartner({ name: 'Existing Rider' });

    await assert.rejects(
        () => updateDeliveryPartnerProfile(partner.id, { phone: '12345' }),
        /10 digit number/,
    );

    await assert.rejects(
        () => updateDeliveryPartnerProfile(partner.id, { phone: other.phone }),
        /already belongs to Existing Rider/,
    );

    await assert.rejects(
        () => updateDeliveryPartnerProfile(partner.id, { name: '  ' }),
        /Name cannot be empty/,
    );
});

test('a deactivated rider keeps their number but loses their session', { skip: !live }, async () => {
    const partner = await makePartner({ availabilityStatus: 'online' });

    const deactivated = await deleteDeliveryPartner(partner.id);
    assert.equal(deactivated.status, 'deactivated');
    // Offline, so dispatch stops offering them orders.
    assert.equal(deactivated.availabilityStatus, 'offline');
    assert.equal(deactivated.tokenVersion, partner.tokenVersion + 1);
    // The row survives: their orders and payout history reference it.
    assert.equal(deactivated.phone, partner.phone);

    // And the number they still hold blocks reuse, with a message saying why.
    const another = await makePartner();
    await assert.rejects(
        () => updateDeliveryPartnerProfile(another.id, { phone: deactivated.phone }),
        /a deactivated account/,
    );
});

test('deactivating an unknown rider is an error, not a silent pass', { skip: !live }, async () => {
    await assert.rejects(() => deleteDeliveryPartner('a'.repeat(24)), /not found/);
    await assert.rejects(() => deleteDeliveryPartner('not-an-id'), /not found/);
});
