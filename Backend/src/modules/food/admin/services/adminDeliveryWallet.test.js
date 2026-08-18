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
import { uniquePhone } from '../../../../utils/testIds.js';

/**
 * Rider wallets, cash settlements, and the two writes that change who can log
 * in as a rider.
 */
const created = { partners: [], restaurants: [], users: [], orders: [], deposits: [], limits: [] };
const stamp = () => `${Date.now()}${Math.floor(performance.now() * 1000) % 1000}`;

const makePartner = async (over = {}) => {
    const partner = await prisma.foodDeliveryPartner.create({
        data: {
            name: `Wallet Rider ${stamp()}`,
            phone: uniquePhone('7'),
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
            ownerPhone: uniquePhone('9'),
            status: 'approved',
        },
    });
    created.restaurants.push(restaurant.id);

    const user = await prisma.foodUser.create({ data: { phone: uniquePhone('5') } });
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
    await prisma.foodDeliveryCashDeposit.deleteMany({ where: { id: { in: created.deposits } } });
    await prisma.foodOrder.deleteMany({ where: { id: { in: created.orders } } });
    // Ledger entries reference the wallet by (entityType, entityId), so the
    // wallet cannot go first.
    await prisma.transaction.deleteMany({ where: { entityId: { in: created.partners } } });
    await prisma.wallet.deleteMany({ where: { entityId: { in: created.partners } } });
    await prisma.foodDeliveryPartner.deleteMany({ where: { id: { in: created.partners } } });
    await prisma.foodUser.deleteMany({ where: { id: { in: created.users } } });
    await prisma.foodRestaurant.deleteMany({ where: { id: { in: created.restaurants } } });
    await prisma.foodDeliveryCashLimit.deleteMany({ where: { id: { in: created.limits } } });
    await prisma.$disconnect();
});

test('remaining cash limit is the cap less what the rider holds', async () => {
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

test('a rider over the cap has no remaining limit, never a negative one', async () => {
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

test('a manual wallet adjustment creates the row if there is none', async () => {
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

test('an adjustment is posted to the ledger, not written over the balance', async () => {
    const partner = await makePartner();

    await updateDeliveryBoyWallet(
        { deliveryId: partner.id, pocketBalance: 500, reason: 'Missed bonus for 12 Aug' },
        'admin-id-here',
    );
    // Down as well as up: the correction that takes money back has to be
    // explainable too.
    await updateDeliveryBoyWallet({ deliveryId: partner.id, pocketBalance: 320 });

    const entries = await prisma.transaction.findMany({
        where: { entityId: partner.id, category: 'adjustment' },
        orderBy: { createdAt: 'asc' },
    });

    assert.equal(entries.length, 2, 'every movement leaves a row behind it');
    assert.equal(entries[0].type, 'credit');
    assert.equal(Number(entries[0].amount), 500);
    assert.equal(entries[0].description, 'Missed bonus for 12 Aug');
    assert.equal(entries[0].metadata.adjustedBy, 'admin-id-here');

    assert.equal(entries[1].type, 'debit');
    assert.equal(Number(entries[1].amount), 180, '500 down to 320 is a debit of the difference');

    // The whole point: the balance is what the ledger adds up to, so the two
    // agree rather than drifting apart.
    assert.equal(Number(entries[1].balanceAfter), 320);
    const wallet = await prisma.wallet.findFirst({ where: { entityId: partner.id } });
    assert.equal(Number(wallet.balance), 320);
});

test('re-submitting the same balance posts nothing', async () => {
    const partner = await makePartner();

    await updateDeliveryBoyWallet({ deliveryId: partner.id, pocketBalance: 100 });
    await updateDeliveryBoyWallet({ deliveryId: partner.id, pocketBalance: 100, cashInHand: 40 });

    // Saving the form twice is not two adjustments, and a zero-amount entry is
    // rejected by the ledger anyway.
    const count = await prisma.transaction.count({ where: { entityId: partner.id } });
    assert.equal(count, 1);

    const wallet = await prisma.wallet.findFirst({ where: { entityId: partner.id } });
    assert.equal(Number(wallet.cashInHand), 40, 'cash in hand still saves');
});

test('a wallet adjustment for an unknown rider is refused', async () => {
    await assert.rejects(
        () => updateDeliveryBoyWallet({ deliveryId: 'a'.repeat(24), pocketBalance: 10 }),
        /not found/,
    );
    await assert.rejects(
        () => updateDeliveryBoyWallet({ pocketBalance: 10 }),
        /ID required/,
    );
});

test('settlements search by gateway reference or by rider', async () => {
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

test('changing a rider phone ends their sessions', async () => {
    const partner = await makePartner();
    const before = partner.tokenVersion;

    const updated = await updateDeliveryPartnerProfile(partner.id, { phone: uniquePhone('6') });
    assert.notEqual(updated.phone, partner.phone);
    // The number is the login, so the old handset must stop being accepted.
    assert.equal(updated.tokenVersion, before + 1);

    // A name-only edit is not a login change.
    const renamed = await updateDeliveryPartnerProfile(partner.id, { name: 'New Name' });
    assert.equal(renamed.name, 'New Name');
    assert.equal(renamed.tokenVersion, updated.tokenVersion);
});

test('a rider phone must be ten digits and unused', async () => {
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

test('a deactivated rider keeps their number but loses their session', async () => {
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

test('deactivating an unknown rider is an error, not a silent pass', async () => {
    await assert.rejects(() => deleteDeliveryPartner('a'.repeat(24)), /not found/);
    await assert.rejects(() => deleteDeliveryPartner('not-an-id'), /not found/);
});
