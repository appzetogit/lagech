import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../../config/prisma.js';
import { uniquePhone, uniqueTag } from '../../../../utils/testIds.js';
import { getRestaurantAnalytics } from './adminRestaurantAnalytics.service.js';

/**
 * One restaurant's analytics page.
 *
 * The rule worth pinning: money comes from the transaction ledger where there
 * is one, but a delivered order without a transaction row must still count —
 * dropping it would understate what the restaurant is owed.
 */
const created = { restaurants: [], users: [], orders: [], commissions: [], invoices: [] };
let restaurantId = null;
let userId = null;
let otherUserId = null;

const makeOrder = async (over = {}) => {
    const order = await prisma.foodOrder.create({
        data: {
            userId,
            restaurantId,
            orderId: uniqueTag('ORD'),
            orderStatus: 'delivered',
            paymentMethod: 'cash',
            addrStreet: '1 Test Street',
            addrCity: 'Indore',
            addrState: 'MP',
            subtotal: 1000,
            packagingFee: 50,
            deliveryFee: 40,
            platformFee: 30,
            tax: 180,
            discount: 0,
            restaurantCommission: 100,
            total: 1300,
            riderEarning: 45,
            platformProfit: 65,
            ...over,
        },
    });
    created.orders.push(order.id);
    return order;
};

test.before(async () => {
    const r = await prisma.foodRestaurant.create({
        data: {
            restaurantName: `Analytics ${uniqueTag('R')}`,
            ownerName: 'Owner',
            ownerPhone: uniquePhone('9'),
            status: 'approved',
            rating: 4.2,
            totalRatings: 30,
        },
    });
    created.restaurants.push(r.id);
    restaurantId = r.id;

    for (const key of ['a', 'b']) {
        const u = await prisma.foodUser.create({ data: { phone: uniquePhone('5') } });
        created.users.push(u.id);
        if (key === 'a') userId = u.id;
        else otherUserId = u.id;
    }
});

test.after(async () => {
    await prisma.foodSubscriptionInvoice.deleteMany({ where: { restaurantId: { in: created.restaurants } } });
    await prisma.foodRestaurantCommission.deleteMany({ where: { restaurantId: { in: created.restaurants } } });
    await prisma.foodTransaction.deleteMany({ where: { orderId: { in: created.orders } } });
    await prisma.foodOrder.deleteMany({ where: { id: { in: created.orders } } });
    await prisma.foodUser.deleteMany({ where: { id: { in: created.users } } });
    await prisma.foodRestaurant.deleteMany({ where: { id: { in: created.restaurants } } });
    await prisma.$disconnect();
});

test('order counts come from one grouped query', async () => {
    await makeOrder();
    await makeOrder();
    await makeOrder({ orderStatus: 'preparing' });
    await makeOrder({ orderStatus: 'cancelled_by_user' });
    await makeOrder({ orderStatus: 'cancelled_by_restaurant' });

    const { analytics } = await getRestaurantAnalytics(restaurantId);

    assert.equal(analytics.totalOrders, 5);
    assert.equal(analytics.completedOrders, 2);
    assert.equal(analytics.inProgressOrders, 1);
    assert.equal(analytics.explicitlyCancelledOrders, 2);
    assert.equal(analytics.cancelledByUser, 1);
    assert.equal(analytics.cancelledByRestaurant, 1);
    assert.equal(analytics.cancelledByAdmin, 0);
    assert.equal(analytics.notDeliveredOrders, 3);

    assert.equal(analytics.completionRate, 40);
    assert.equal(analytics.cancellationRate, 40);
    assert.equal(analytics.inProgressRate, 20);
    assert.equal(analytics.averageRating, 4.2);
    assert.equal(analytics.totalRatings, 30);
    assert.equal(analytics.status, 'active');
});

test('a delivered order with no transaction still counts', async () => {
    const { analytics, paymentSummary } = await getRestaurantAnalytics(restaurantId);

    // Two delivered orders, neither with a ledger row: the money comes from
    // their own columns rather than being dropped.
    assert.equal(analytics.totalRevenue, 2600);
    assert.equal(analytics.averageOrderValue, 1300);
    // subtotal + packaging − commission.
    assert.equal(analytics.restaurantEarning, 1900);
    assert.equal(analytics.restaurantProfit, 1900);
    assert.equal(analytics.totalCommission, 200);

    assert.equal(paymentSummary.subtotal, 2000);
    assert.equal(paymentSummary.tax, 360);
    assert.equal(paymentSummary.deliveryFee, 80);
    assert.equal(paymentSummary.platformFee, 60);
    assert.equal(paymentSummary.riderShare, 90, 'from the order when there is no ledger row');
    assert.equal(paymentSummary.platformNetProfit, 130);
    assert.equal(paymentSummary.currency, 'INR');
});

test('the ledger wins over the order columns', async () => {
    const order = await makeOrder();
    await prisma.foodTransaction.create({
        data: {
            orderId: order.id,
            userId,
            restaurantId,
            paymentMethod: 'cash',
            subtotal: 1000,
            total: 1300,
            totalCustomerPaid: 1234,
            // What the split actually credited — not derivable from the order.
            restaurantShare: 888,
            commissionAmount: 100,
            restaurantCommission: 111,
            riderShare: 22,
            platformNetProfit: 33,
        },
    });

    const { analytics, paymentSummary } = await getRestaurantAnalytics(restaurantId);

    assert.equal(analytics.totalRevenue, 2600 + 1234);
    assert.equal(analytics.restaurantEarning, 1900 + 888);
    assert.equal(analytics.totalCommission, 200 + 111);
    assert.equal(paymentSummary.riderShare, 90 + 22);
    assert.equal(paymentSummary.platformNetProfit, 130 + 33);
});

test('customers are counted once, repeats separately', async () => {
    await makeOrder({ userId: otherUserId });

    const { analytics } = await getRestaurantAnalytics(restaurantId);
    assert.equal(analytics.totalCustomers, 2);
    // The first customer has several orders; the second has one.
    assert.equal(analytics.repeatCustomers, 1);
});

test('a flat commission is expressed as a percentage of what was sold', async () => {
    const flat = await prisma.foodRestaurantCommission.create({
        data: { restaurantId, commissionType: 'amount', commissionValue: 50, status: true },
    });
    created.commissions.push(flat.id);

    const asFlat = await getRestaurantAnalytics(restaurantId);
    const { totalCommission } = asFlat.analytics;
    const subtotal = asFlat.paymentSummary.subtotal;
    assert.equal(asFlat.analytics.commissionPercentage, (totalCommission / subtotal) * 100);

    // A percentage rule is simply the rate itself.
    await prisma.foodRestaurantCommission.update({
        where: { id: flat.id },
        data: { commissionType: 'percentage', commissionValue: 12.5 },
    });
    const asPercent = await getRestaurantAnalytics(restaurantId);
    assert.equal(asPercent.analytics.commissionPercentage, 12.5);

    // A disabled rule is not a rule.
    await prisma.foodRestaurantCommission.update({ where: { id: flat.id }, data: { status: false } });
    const disabled = await getRestaurantAnalytics(restaurantId);
    assert.equal(
        disabled.analytics.commissionPercentage,
        (totalCommission / subtotal) * 100,
        'falls back to what was actually charged',
    );
});

test('the subscription summary reads the invoices', async () => {
    const empty = await getRestaurantAnalytics(restaurantId);
    assert.equal(empty.subscriptionSummary.planLabel, 'Not billed yet');
    assert.equal(empty.subscriptionSummary.status, 'paid', 'nothing billed is nothing owed');
    assert.equal(empty.subscriptionSummary.invoiceCount, 0);

    const invoice = await prisma.foodSubscriptionInvoice.create({
        data: {
            restaurantId,
            billingMonth: '2033-02',
            planName: 'growth',
            planAmount: 1999,
            gstAmount: 360,
            totalAmount: 2359,
            paidAmount: 359,
            outstandingAmount: 2000,
            status: 'partially_settled',
        },
    });
    created.invoices.push(invoice.id);
    // A carry-forward balance is not a month and must not read as the latest one.
    const legacy = await prisma.foodSubscriptionInvoice.create({
        data: {
            restaurantId,
            billingMonth: 'legacy',
            planName: 'legacy',
            planAmount: 0,
            totalAmount: 500,
            outstandingAmount: 500,
            isLegacyCarryForward: true,
        },
    });
    created.invoices.push(legacy.id);

    const { subscriptionSummary } = await getRestaurantAnalytics(restaurantId);
    assert.equal(subscriptionSummary.plan, 'growth');
    assert.equal(subscriptionSummary.planLabel, 'Growth');
    assert.equal(subscriptionSummary.lastBilledMonth, '2033-02');
    assert.equal(subscriptionSummary.cycleFee, 2359);
    assert.equal(subscriptionSummary.dueAmount, 2500, 'both invoices are outstanding');
    assert.equal(subscriptionSummary.totalBilled, 2859);
    assert.equal(subscriptionSummary.status, 'due');
    assert.equal(subscriptionSummary.invoiceCount, 2);
    assert.equal(subscriptionSummary.invoices[0].billingMonthLabel, 'Pre-migration balance');
});

test('an unknown restaurant reads back as nothing', async () => {
    assert.equal(await getRestaurantAnalytics('not-an-id'), null);
    assert.equal(await getRestaurantAnalytics('a'.repeat(24)), null);
});
