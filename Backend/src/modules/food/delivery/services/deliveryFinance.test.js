import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../../config/prisma.js';
import { requestDeliveryWithdrawal } from './deliveryFinance.service.js';
import { uniquePhone } from '../../../../utils/testIds.js';

/**
 * Requesting a withdrawal used to write a computed "should-be" balance
 * straight onto wallet.balance, with no transaction row behind it — a rider
 * could watch their stored balance jump with nothing in their history
 * explaining why. The one test here is that the sync now goes through
 * recordTransaction: a real ledger row, not a silent overwrite.
 */
const created = { partners: [], restaurants: [], orders: [] };
const stamp = () => `${Date.now()}${Math.floor(performance.now() * 1000) % 1000}`;

test.after(async () => {
    await prisma.foodDeliveryWithdrawal.deleteMany({ where: { deliveryPartnerId: { in: created.partners } } });
    await prisma.transaction.deleteMany({ where: { entityType: 'deliveryBoy', entityId: { in: created.partners } } });
    await prisma.wallet.deleteMany({ where: { entityId: { in: created.partners } } });
    await prisma.foodOrder.deleteMany({ where: { id: { in: created.orders } } });
    await prisma.foodRestaurant.deleteMany({ where: { id: { in: created.restaurants } } });
    await prisma.foodDeliveryPartner.deleteMany({ where: { id: { in: created.partners } } });
    await prisma.$disconnect();
});

test('requesting a withdrawal syncs the ledger through a real transaction, not a raw write', async () => {
    const partner = await prisma.foodDeliveryPartner.create({
        data: { name: `Payout Rider ${stamp()}`, phone: uniquePhone('7'), status: 'approved' },
    });
    created.partners.push(partner.id);

    const restaurant = await prisma.foodRestaurant.create({
        data: {
            restaurantName: `Sync Rest ${stamp()}`,
            ownerName: 'Owner',
            ownerPhone: uniquePhone('9'),
            status: 'approved',
        },
    });
    created.restaurants.push(restaurant.id);

    const user = await prisma.foodUser.create({ data: { phone: uniquePhone('5') } });

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
            subtotal: 500,
            total: 500,
            riderEarning: 500,
        },
    });
    created.orders.push(order.id);

    const withdrawal = await requestDeliveryWithdrawal(partner.id, { amount: 200 });
    assert.equal(withdrawal.status, 'pending');

    const wallet = await prisma.wallet.findUnique({
        where: { entityType_entityId: { entityType: 'deliveryBoy', entityId: partner.id } },
    });
    assert.ok(wallet, 'the sync must create the wallet row');
    assert.equal(Number(wallet.balance), 500, 'balance is synced to the computed pocket balance');
    assert.equal(Number(wallet.lockedAmount), 200, 'the requested amount is reserved');

    const ledgerRow = await prisma.transaction.findUnique({
        where: { idempotencyKey: `earnings_sync:${withdrawal.id}` },
    });
    assert.ok(ledgerRow, 'the balance move must have a transaction row behind it');
    assert.equal(ledgerRow.type, 'credit');
    assert.equal(Number(ledgerRow.amount), 500, 'the ledger entry covers the whole gap it just closed');
});
