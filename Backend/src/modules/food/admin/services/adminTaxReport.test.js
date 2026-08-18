import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../../config/prisma.js';
import { uniquePhone, uniqueTag } from '../../../../utils/testIds.js';
import { getTaxReport, getTaxReportDetail } from './adminTaxReport.service.js';

/**
 * Tax owed per restaurant.
 *
 * The rate override is the interesting part: an accountant can re-run the
 * report at a rate other than the one charged, and the answer has to come from
 * the taxable base rather than the stored figure.
 */
const created = { restaurants: [], users: [], orders: [], offers: [] };
let restaurantId = null;
let otherRestaurantId = null;
let userId = null;
let tag = null;

const makeOrder = async (over = {}) => {
    const order = await prisma.foodOrder.create({
        data: {
            userId,
            restaurantId,
            orderId: `${tag}-${uniqueTag('O')}`,
            orderStatus: 'delivered',
            paymentMethod: 'cash',
            addrStreet: '1 Test Street',
            addrCity: 'Indore',
            addrState: 'MP',
            subtotal: 1000,
            packagingFee: 0,
            restaurantCommission: 100,
            discount: 0,
            tax: 50,
            total: 1150,
            ...over,
        },
    });
    created.orders.push(order.id);
    return order;
};

test.before(async () => {
    tag = uniqueTag('Tax');

    const make = async () => {
        const r = await prisma.foodRestaurant.create({
            data: {
                restaurantName: `${tag} Kitchen`,
                ownerName: 'Owner',
                ownerPhone: uniquePhone('9'),
                status: 'approved',
            },
        });
        created.restaurants.push(r.id);
        return r.id;
    };
    restaurantId = await make();
    otherRestaurantId = await make();

    const u = await prisma.foodUser.create({ data: { phone: uniquePhone('5') } });
    created.users.push(u.id);
    userId = u.id;
});

test.after(async () => {
    await prisma.foodOffer.deleteMany({ where: { id: { in: created.offers } } });
    await prisma.foodTransaction.deleteMany({ where: { orderId: { in: created.orders } } });
    await prisma.foodOrder.deleteMany({ where: { id: { in: created.orders } } });
    await prisma.foodUser.deleteMany({ where: { id: { in: created.users } } });
    await prisma.foodRestaurant.deleteMany({ where: { id: { in: created.restaurants } } });
    await prisma.$disconnect();
});

test('only earned orders are taxed, grouped per restaurant', async () => {
    await makeOrder();
    await makeOrder({ restaurantId: otherRestaurantId, tax: 25 });
    // Not delivered, so nothing was earned and nothing is owed.
    await makeOrder({ orderStatus: 'preparing' });
    // Never paid for.
    await makeOrder({ orderStatus: 'pending_payment' });

    const { reports, stats } = await getTaxReport({ search: tag });

    assert.equal(reports.length, 2);
    // Biggest tax bill first.
    assert.equal(reports[0].id, restaurantId);
    assert.equal(reports[0].incomeSource, `${tag} Kitchen`);
    assert.equal(reports[0].orderCount, 1);
    assert.equal(reports[0].totalTax, '₹50.00');
    // subtotal + packaging − commission.
    assert.equal(reports[0].totalIncome, '₹900.00');
    assert.equal(reports[0].sl, 1);
    assert.equal(reports[1].sl, 2);

    assert.equal(stats.totalTax, '₹75.00');
    assert.equal(stats.totalIncome, '₹1800.00');
});

test('the rate override recomputes from the taxable base', async () => {
    const order = await makeOrder({ subtotal: 2000, discount: 500, tax: 7, restaurantCommission: 0 });

    const asCharged = await getTaxReportDetail(restaurantId, {});
    const charged = asCharged.orders.find((o) => o.orderId === order.orderId);
    assert.equal(charged.taxAmount, '₹7.00', 'what was actually charged');

    // 5% of (2000 − 500).
    const recomputed = await getTaxReportDetail(restaurantId, { taxRate: 5, calculateTax: 'percentage' });
    const atFive = recomputed.orders.find((o) => o.orderId === order.orderId);
    assert.equal(atFive.taxAmount, '₹75.00');

    // A fixed-amount mode ignores the rate and reports what was charged.
    const fixed = await getTaxReportDetail(restaurantId, { taxRate: 5, calculateTax: 'fixed amount' });
    assert.equal(fixed.orders.find((o) => o.orderId === order.orderId).taxAmount, '₹7.00');

    // A rate of zero or nonsense is not an override either.
    const zero = await getTaxReportDetail(restaurantId, { taxRate: 0, calculateTax: 'percentage' });
    assert.equal(zero.orders.find((o) => o.orderId === order.orderId).taxAmount, '₹7.00');
});

test('a discount reduces the taxable base, never below zero', async () => {
    const order = await makeOrder({ subtotal: 100, discount: 500, tax: 0, restaurantCommission: 0 });

    const { orders } = await getTaxReportDetail(restaurantId, {
        taxRate: 10,
        calculateTax: 'percentage',
    });
    // A discount larger than the subtotal must not produce negative tax.
    assert.equal(orders.find((o) => o.orderId === order.orderId).taxAmount, '₹0.00');
});

test('the date range covers the whole closing day', async () => {
    const late = await makeOrder({ createdAt: new Date('2032-04-10T22:45:00') });

    const sameDay = await getTaxReportDetail(restaurantId, {
        fromDate: '2032-04-10',
        toDate: '2032-04-10',
    });
    // A `toDate` taken at midnight would drop every order placed that evening.
    assert.ok(sameDay.orders.some((o) => o.orderId === late.orderId));

    const dayBefore = await getTaxReportDetail(restaurantId, {
        fromDate: '2032-04-09',
        toDate: '2032-04-09',
    });
    assert.ok(!dayBefore.orders.some((o) => o.orderId === late.orderId));
});

test('the transaction snapshot wins for the restaurant share', async () => {
    const order = await makeOrder({ createdAt: new Date('2032-06-01') });
    await prisma.foodTransaction.create({
        data: {
            orderId: order.id,
            userId,
            restaurantId,
            paymentMethod: 'cash',
            subtotal: 1000,
            tax: 50,
            total: 1150,
            totalCustomerPaid: 1150,
            // What the split actually credited.
            restaurantShare: 777,
            commissionAmount: 100,
            riderShare: 0,
            platformNetProfit: 0,
        },
    });

    const { orders } = await getTaxReportDetail(restaurantId, {
        fromDate: '2032-06-01',
        toDate: '2032-06-01',
    });
    assert.equal(orders[0].totalAmount, '₹777.00', 'not the 900 the columns would imply');
});

test('the detail view needs a real restaurant', async () => {
    await assert.rejects(() => getTaxReportDetail('not-an-id'), /Invalid restaurant ID/);

    const missing = await getTaxReportDetail('a'.repeat(24));
    assert.equal(missing.restaurantName, 'Unknown Restaurant');
    assert.deepEqual(missing.orders, []);
});
