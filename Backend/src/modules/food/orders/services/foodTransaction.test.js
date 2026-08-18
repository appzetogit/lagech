import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../../config/prisma.js';
import { uniquePhone, uniqueTag } from '../../../../utils/testIds.js';
import { createInitialTransaction } from './foodTransaction.service.js';
import { toOrder } from '../order.mapper.js';

/**
 * The ledger row written for every order — what settlement pays against, and
 * what every finance report reads first.
 *
 * Each case runs twice: once with the toOrder()-mapped object that both callers
 * in order.service.js actually pass, and once with a raw Prisma row. The writer
 * used to read only the mapped shape (`order.pricing.total`), so it depended on
 * every caller remembering to map first — and silently wrote a row of zeros if
 * one did not. Reading the columns satisfies both, and these hold it there.
 *
 * A transaction is unique per order, so each shape gets its own order.
 */
const created = { restaurants: [], users: [], orders: [], partners: [] };
let restaurantId = null;
let userId = null;
let partnerId = null;
let tag = null;

test.before(async () => {
    tag = uniqueTag('Txn');

    const r = await prisma.foodRestaurant.create({
        data: {
            restaurantName: `${tag} Kitchen`,
            ownerName: 'Owner',
            ownerPhone: uniquePhone('9'),
            status: 'approved',
        },
    });
    created.restaurants.push(r.id);
    restaurantId = r.id;

    const u = await prisma.foodUser.create({ data: { phone: uniquePhone('5') } });
    created.users.push(u.id);
    userId = u.id;

    const p = await prisma.foodDeliveryPartner.create({
        data: { name: `${tag} Rider`, phone: uniquePhone('6'), status: 'approved' },
    });
    created.partners.push(p.id);
    partnerId = p.id;
});

test.after(async () => {
    await prisma.foodTransaction.deleteMany({ where: { orderId: { in: created.orders } } });
    await prisma.foodOrder.deleteMany({ where: { id: { in: created.orders } } });
    await prisma.foodDeliveryPartner.deleteMany({ where: { id: { in: created.partners } } });
    await prisma.foodUser.deleteMany({ where: { id: { in: created.users } } });
    await prisma.foodRestaurant.deleteMany({ where: { id: { in: created.restaurants } } });
    await prisma.$disconnect();
});

/** A paid order, with the columns createOrder writes. */
const makeOrder = async (over = {}) => {
    const order = await prisma.foodOrder.create({
        data: {
            userId,
            restaurantId,
            dispatchDeliveryPartnerId: partnerId,
            orderId: `${tag}-${uniqueTag('O')}`,
            orderStatus: 'confirmed',
            paymentMethod: 'razorpay',
            paymentStatus: 'paid',
            addrStreet: '1 Test Street', addrCity: 'Indore', addrState: 'MP',
            subtotal: 1000,
            packagingFee: 30,
            deliveryFee: 40,
            deliveryFeeGst: 7,
            platformFee: 20,
            tax: 50,
            discount: 100,
            couponCode: 'SAVE100',
            restaurantCommission: 150,
            total: 1047,
            riderEarning: 35,
            ...over,
        },
    });
    created.orders.push(order.id);
    return order;
};

/**
 * Writes the ledger for a fresh order in the given shape.
 * 'mapped' is what production passes; 'raw' is what a future caller might.
 */
const ledgerFor = async (shape, over = {}) => {
    const order = await makeOrder(over);
    return createInitialTransaction(shape === 'mapped' ? toOrder(order) : order);
};

for (const shape of ['mapped', 'raw']) {
    test(`[${shape}] the ledger records what the customer actually paid`, async () => {
        const tx = await ledgerFor(shape);
        assert.ok(tx, 'a transaction is written');

        // Settlement, every finance report and the restaurant's own wallet all
        // read this row. A zero here is money nobody gets paid.
        assert.equal(Number(tx.totalCustomerPaid), 1047);
        assert.equal(Number(tx.subtotal), 1000);
        assert.equal(Number(tx.tax), 50);
        assert.equal(Number(tx.packagingFee), 30);
        assert.equal(Number(tx.deliveryFee), 40);
        assert.equal(Number(tx.platformFee), 20);
        assert.equal(Number(tx.discount), 100);
        assert.equal(tx.couponCode, 'SAVE100');
    });

    test(`[${shape}] the split credits the restaurant and the rider`, async () => {
        const tx = await ledgerFor(shape);

        // subtotal + packaging − commission, less whatever the restaurant bore
        // of the discount.
        assert.ok(
            Number(tx.restaurantShare) > 0,
            `restaurantShare was ${tx.restaurantShare} — the restaurant would be paid nothing`,
        );
        assert.equal(Number(tx.restaurantCommission), 150);
        assert.equal(Number(tx.riderShare), 35);
    });

    test(`[${shape}] the payment method and rider carry across`, async () => {
        const tx = await ledgerFor(shape);

        // Defaulting to 'cash' on an online order misreports how money arrived.
        assert.equal(tx.paymentMethod, 'razorpay');
        assert.equal(tx.status, 'captured', 'a paid order is captured, not pending');
        assert.equal(tx.deliveryPartnerId, partnerId);
    });

    test(`[${shape}] a cash order is pending, not captured`, async () => {
        const tx = await ledgerFor(shape, { paymentMethod: 'cash', paymentStatus: 'cod_pending' });

        assert.equal(tx.paymentMethod, 'cash');
        assert.equal(tx.status, 'pending');
        assert.equal(Number(tx.totalCustomerPaid), 1047, 'cash is still money owed');
    });

    test(`[${shape}] the owner ids are real ids, not the string "undefined"`, async () => {
        const tx = await ledgerFor(shape);

        // The old code read `order.userId?.id ?? order.userId`, which a
        // populated Mongoose document needed. On either shape here the scalar
        // is the id, and String(undefined) would have poisoned the row.
        assert.equal(tx.userId, userId);
        assert.equal(tx.restaurantId, restaurantId);
    });
}
