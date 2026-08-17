import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../../config/prisma.js';
import { uniquePhone, uniqueTag } from '../../../../utils/testIds.js';
import {
    computeMonthlyGmv,
    getMonthWindow,
    billingMonthLabel,
    previousBillingMonth,
    generateInvoiceForRestaurant,
    getOutstandingSummary,
    applyWalletDeduction,
    applyManualPayment,
    applyWaiver,
    applyAdjustment,
} from './subscriptionBilling.service.js';
import { getRestaurantFinance } from './restaurantFinance.service.js';

/**
 * Postpaid subscription billing — the money path.
 *
 * What matters here is that a restaurant is billed once per month, that the
 * outstanding balance can only move through a recorded transaction, and that
 * two admins settling the same invoice cannot both succeed.
 */
const live = Boolean(process.env.DATABASE_URL);

const created = { restaurants: [], users: [], orders: [], invoices: [] };
let restaurantId = null;
let userId = null;

// A month safely in the past, so no other test's orders can fall in it.
const MONTH = '2031-05';
const { start: MONTH_START, end: MONTH_END } = getMonthWindow(MONTH);

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
            packagingFee: 0,
            restaurantCommission: 0,
            total: 1000,
            createdAt: new Date(MONTH_START.getTime() + 86400000),
            ...over,
        },
    });
    created.orders.push(order.id);
    return order;
};

const makeInvoice = async (over = {}) => {
    const invoice = await prisma.foodSubscriptionInvoice.create({
        data: {
            restaurantId,
            billingMonth: over.billingMonth || uniqueTag('2031-'),
            planName: 'starter',
            planAmount: 1000,
            gstAmount: 180,
            totalAmount: 1180,
            outstandingAmount: 1180,
            ...over,
        },
    });
    created.invoices.push(invoice.id);
    return invoice;
};

const admin = { id: 'a'.repeat(24), name: 'Test Admin' };

test.before(async () => {
    if (!live) return;
    const r = await prisma.foodRestaurant.create({
        data: {
            restaurantName: `Billing ${uniqueTag('R')}`,
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
});

test.after(async () => {
    if (!live) return;
    await prisma.foodSubscriptionTransaction.deleteMany({ where: { restaurantId: { in: created.restaurants } } });
    await prisma.foodSubscriptionInvoice.deleteMany({ where: { restaurantId: { in: created.restaurants } } });
    await prisma.foodNotification.deleteMany({ where: { ownerId: { in: created.restaurants } } });
    await prisma.foodRestaurantWithdrawal.deleteMany({ where: { restaurantId: { in: created.restaurants } } });
    await prisma.foodTransaction.deleteMany({ where: { orderId: { in: created.orders } } });
    await prisma.foodOrder.deleteMany({ where: { id: { in: created.orders } } });
    await prisma.foodUser.deleteMany({ where: { id: { in: created.users } } });
    await prisma.foodRestaurant.deleteMany({ where: { id: { in: created.restaurants } } });
    await prisma.$disconnect();
});

test('a billing month labels and bounds itself', { skip: !live }, async () => {
    assert.equal(billingMonthLabel('2031-05'), 'May 2031');
    assert.equal(billingMonthLabel('legacy'), 'Pre-migration balance');

    const { start, end } = getMonthWindow('2031-02');
    assert.equal(start.getDate(), 1);
    assert.equal(end.getDate(), 28, 'a non-leap February ends on the 28th');
    assert.equal(end.getHours(), 23);

    // Lexicographic ordering is what the catch-up loop relies on.
    assert.ok('2031-02' < '2031-10');
    assert.match(previousBillingMonth(new Date('2031-01-15')), /^2030-12$/);
});

test('GMV counts only delivered orders, at the restaurant\'s share', { skip: !live }, async () => {
    await makeOrder({ subtotal: 1000, packagingFee: 50, restaurantCommission: 200 });
    // Not delivered: not earned.
    await makeOrder({ orderStatus: 'preparing' });
    // Outside the window.
    await makeOrder({ createdAt: new Date('2030-01-15') });

    const { gmv, orderCount } = await computeMonthlyGmv(restaurantId, MONTH_START, MONTH_END);
    assert.equal(orderCount, 1);
    // subtotal + packaging − commission, with no discount to split.
    assert.equal(gmv, 850);

    assert.deepEqual(
        await computeMonthlyGmv('not-an-id', MONTH_START, MONTH_END),
        { gmv: 0, orderCount: 0 },
    );
});

test('the transaction snapshot wins over the order\'s own columns', { skip: !live }, async () => {
    const order = await makeOrder({ subtotal: 500, restaurantCommission: 0 });
    await prisma.foodTransaction.create({
        data: {
            orderId: order.id,
            userId,
            restaurantId,
            paymentMethod: 'cash',
            subtotal: 500,
            total: 500,
            totalCustomerPaid: 500,
            // What the split actually credited — not derivable from the order.
            restaurantShare: 111,
            commissionAmount: 0,
            riderShare: 0,
            platformNetProfit: 0,
        },
    });

    const { gmv } = await computeMonthlyGmv(restaurantId, MONTH_START, MONTH_END);
    // 850 from the earlier order, plus the recorded share rather than 500.
    assert.equal(gmv, 961);
});

test('an invoice is generated once, from the month\'s GMV', { skip: !live }, async () => {
    const restaurant = { id: restaurantId, restaurantName: 'Billing' };
    const settings = { starterPrice: 999, starterMaxGmv: 30000 };

    const first = await generateInvoiceForRestaurant(restaurant, MONTH, settings);
    assert.equal(first.status, 'invoiced');
    created.invoices.push(first.invoice.id);

    assert.equal(first.invoice.planName, 'starter');
    assert.equal(Number(first.invoice.planAmount), 999);
    assert.equal(Number(first.invoice.gstAmount), 180, '18% GST, rounded');
    assert.equal(Number(first.invoice.totalAmount), 1179);
    assert.equal(Number(first.invoice.outstandingAmount), 1179);

    // The opening ledger row lands in the same transaction as the invoice.
    const ledger = await prisma.foodSubscriptionTransaction.findFirst({
        where: { invoiceId: first.invoice.id, type: 'invoice_generated' },
    });
    assert.ok(ledger);
    assert.equal(Number(ledger.amount), 1179);
    assert.equal(ledger.processedByRole, 'SYSTEM');

    // Re-running the month must not bill anyone twice.
    const again = await generateInvoiceForRestaurant(restaurant, MONTH, settings);
    assert.deepEqual(again, { status: 'skipped', reason: 'already_invoiced' });

    // A month the restaurant earned nothing in is not billed at all.
    const quiet = await generateInvoiceForRestaurant(restaurant, '2030-07', settings);
    assert.deepEqual(quiet, { status: 'skipped', reason: 'zero_gmv' });

    assert.equal(
        (await generateInvoiceForRestaurant({}, MONTH, settings)).reason,
        'missing_restaurant',
    );
});

test('outstanding invoices are what locks the wallet', { skip: !live }, async () => {
    const open = await makeInvoice({ billingMonth: '2031-06', outstandingAmount: 500 });
    await makeInvoice({
        billingMonth: '2031-07',
        outstandingAmount: 0,
        paidAmount: 1180,
        status: 'settled',
    });

    const summary = await getOutstandingSummary(restaurantId);
    const ids = summary.openInvoices.map((i) => i.id);
    assert.ok(ids.includes(open.id));
    // A settled invoice locks nothing.
    assert.ok(!summary.openInvoices.some((i) => i.status === 'settled'));
    assert.ok(summary.lockedAmount >= 500);
    assert.match(summary.monthsLabel, /Jun 2031/);

    assert.deepEqual(
        await getOutstandingSummary('not-an-id'),
        { lockedAmount: 0, openInvoices: [], monthsLabel: '' },
    );
});

test('a part payment leaves the invoice partially settled', { skip: !live }, async () => {
    const invoice = await makeInvoice({ billingMonth: '2031-08' });

    const { invoice: after, transaction } = await applyManualPayment(invoice.id, 180, admin, 'Cash at office');
    assert.equal(after.paidAmount, 180);
    assert.equal(after.outstandingAmount, 1000);
    assert.equal(after.status, 'partially_settled');
    assert.equal(transaction.processedByRole, 'ADMIN');
    assert.equal(transaction.processedByName, 'Test Admin');
    assert.equal(Number(transaction.outstandingAfter), 1000);

    const settled = await applyManualPayment(invoice.id, 1000, admin, 'Rest of it');
    assert.equal(settled.invoice.outstandingAmount, 0);
    assert.equal(settled.invoice.status, 'settled');

    // Nothing is left to pay, and paying anyway is refused rather than credited.
    await assert.rejects(() => applyManualPayment(invoice.id, 1, admin, 'Again'), /exceeds outstanding/);
});

test('a settlement cannot exceed the due, or skip its reason', { skip: !live }, async () => {
    const invoice = await makeInvoice({ billingMonth: '2031-09' });

    await assert.rejects(() => applyManualPayment(invoice.id, 5000, admin, 'Too much'), /exceeds outstanding/);
    await assert.rejects(() => applyManualPayment(invoice.id, 0, admin, 'Nothing'), /greater than zero/);
    await assert.rejects(() => applyManualPayment(invoice.id, 100, admin, '  '), /Remarks are required/);
    await assert.rejects(() => applyWaiver(invoice.id, admin, ''), /Remarks are required/);
    await assert.rejects(() => applyAdjustment(invoice.id, 100, admin, ''), /Remarks are required/);
    await assert.rejects(() => applyAdjustment(invoice.id, 0, admin, 'Nothing'), /non-zero/);
    await assert.rejects(() => applyManualPayment('not-an-id', 10, admin, 'x'), /not found/);

    // A wallet deduction is additionally capped by what the restaurant has.
    await assert.rejects(
        () => applyWalletDeduction(invoice.id, 500, admin, 'From wallet', { maxDeductible: 100 }),
        /exceeds the restaurant's wallet balance/,
    );
});

test('waiving clears the due and releases the lock', { skip: !live }, async () => {
    const invoice = await makeInvoice({ billingMonth: '2031-10' });

    const { invoice: after } = await applyWaiver(invoice.id, admin, 'Goodwill');
    assert.equal(after.outstandingAmount, 0);
    assert.equal(after.waivedAmount, 1180);
    assert.equal(after.status, 'waived', 'waived, not settled — nothing was actually paid');

    await assert.rejects(() => applyWaiver(invoice.id, admin, 'Again'), /no outstanding amount/);
});

test('an adjustment is signed, and cannot drive the due negative', { skip: !live }, async () => {
    const invoice = await makeInvoice({ billingMonth: '2031-11' });

    const up = await applyAdjustment(invoice.id, 100, admin, 'Late fee');
    assert.equal(up.invoice.outstandingAmount, 1280);
    assert.equal(up.invoice.adjustmentAmount, 100);
    assert.equal(Number(up.transaction.amount), 100);

    // Asking for more than is owed reduces it to exactly zero, not below.
    const down = await applyAdjustment(invoice.id, -5000, admin, 'Written off');
    assert.equal(down.invoice.outstandingAmount, 0);
    assert.equal(down.invoice.adjustmentAmount, -1180);
    // The ledger has to say the due went down, not that 1180 was collected.
    assert.equal(Number(down.transaction.amount), -1280);
});

test('two admins settling the same invoice: only one wins', { skip: !live }, async () => {
    const invoice = await makeInvoice({ billingMonth: '2031-12', outstandingAmount: 1000, totalAmount: 1000 });

    const results = await Promise.allSettled([
        applyManualPayment(invoice.id, 1000, admin, 'First'),
        applyManualPayment(invoice.id, 1000, admin, 'Second'),
    ]);

    const settled = results.filter((r) => r.status === 'fulfilled');
    assert.equal(settled.length, 1, 'the outstanding check is in the where clause, not a prior read');

    const after = await prisma.foodSubscriptionInvoice.findUnique({ where: { id: invoice.id } });
    assert.equal(Number(after.outstandingAmount), 0);
    assert.equal(Number(after.paidAmount), 1000, 'not 2000');
});

test('the finance balance nets off withdrawals and deductions', { skip: !live }, async () => {
    const finance = await getRestaurantFinance(restaurantId);

    // Lifetime, not month-scoped: the three delivered orders are 850, the 111
    // recorded share, and 1000 from outside the billing window. The one still
    // preparing is not earned.
    assert.equal(finance.wallet.totalEarnings, 1961);
    assert.equal(finance.wallet.totalOrders, 3);
    assert.ok(finance.restaurant.restaurantId.startsWith('REST'));

    const withdrawal = await prisma.foodRestaurantWithdrawal.create({
        data: { restaurantId, amount: 100, status: 'pending' },
    });

    const after = await getRestaurantFinance(restaurantId);
    // A pending request is money already spoken for.
    assert.equal(after.wallet.totalWithdrawn, 100);
    assert.equal(after.wallet.withdrawableBalance, 1861);

    // The locked amount stays visible but is not withdrawable.
    assert.ok(after.subscription.lockedAmount > 0);
    assert.equal(
        after.wallet.netAvailable,
        Math.max(0, 1861 - after.subscription.lockedAmount),
    );
    assert.equal(after.restaurant.subscriptionStatus, 'due');

    await prisma.foodRestaurantWithdrawal.delete({ where: { id: withdrawal.id } });
    assert.equal(await getRestaurantFinance('not-an-id'), null);
});
