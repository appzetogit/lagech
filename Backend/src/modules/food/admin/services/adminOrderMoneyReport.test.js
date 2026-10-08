import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';

import { prisma } from '../../../../config/prisma.js';
import { uniquePhone, uniqueTag } from '../../../../utils/testIds.js';
import { testPatch } from '../../../../utils/testGeo.js';
import { createInitialTransaction } from '../../orders/services/foodTransaction.service.js';
import { calculateRiderEarning } from '../../orders/services/order-pricing.service.js';
import { getRestaurantEarningReport } from './adminMoneyReports.service.js';
import { getRestaurantBalances } from './adminBalanceSheet.service.js';
import {
    getOrderMoneyReport,
    iterateOrderMoneyRows,
    exportOrderMoneyReport,
    getRestaurantWiseReport,
    exportRestaurantWiseReport,
} from './adminOrderMoneyReport.service.js';

/**
 * Orders with known amounts — a split coupon, a free-delivery coupon, plain
 * orders, a cancelled + refunded one, one still cooking and an abandoned
 * checkout — go through the real ledger code (createInitialTransaction, the
 * delivery fee band rider pay), and every column of the reports is checked
 * against hand-worked numbers and against the Restaurant Earning report and
 * the balance sheet.
 */
const HERE = testPatch(37);
const PERIOD = { from: '2019-01-01', to: '2019-01-31' };
const IN_PERIOD = (day) => new Date(`2019-01-${String(day).padStart(2, '0')}T12:00:00Z`);

// One distance band: 0–10 km pays the rider a flat 30.
const FEES = { deliveryFeeRanges: [{ min: 0, max: 10, fee: 40, deliveryBoyBasePay: 30, deliveryBoyPerKm: 0 }] };
const RIDER = calculateRiderEarning(FEES, 3);

const created = { zones: [], restaurants: [], users: [], orders: [], offers: [] };
let tag;
let zoneId;
let A; // restaurant with most of the orders
let B; // a second restaurant in the same zone
let userId;
const orders = {};

async function makeOrder(name, over, { tx = true, txStatus = null } = {}) {
    const row = await prisma.foodOrder.create({
        data: {
            userId,
            restaurantId: A,
            orderId: `${tag}-${name}`,
            customerName: `${tag} Diner`,
            addrStreet: '1 Test Street',
            addrCity: 'Indore',
            addrState: 'MP',
            orderStatus: 'delivered',
            deliveryPhase: 'delivered',
            paymentMethod: 'cash',
            paymentStatus: 'paid',
            createdAt: IN_PERIOD(15),
            riderEarning: RIDER,
            ...over,
        },
    });
    created.orders.push(row.id);
    if (tx) {
        const t = await createInitialTransaction(row);
        // The ledger row is written "now"; the balance sheet reads its period
        // off the transaction, so it is moved to the order's own time.
        await prisma.foodTransaction.update({
            where: { id: t.id || t._id },
            data: { createdAt: row.createdAt, ...(txStatus ? { status: txStatus } : {}) },
        });
    }
    orders[name] = row;
    return row;
}

test.before(async () => {
    tag = uniqueTag('Rep');
    assert.equal(RIDER, 30, 'rider pay comes from the fee band');

    const zone = await prisma.foodZone.create({ data: { name: `Rep Zone ${tag}`, coordinates: HERE.ring } });
    created.zones.push(zone.id);
    zoneId = zone.id;

    const restaurant = async (name) => {
        const r = await prisma.foodRestaurant.create({
            data: { restaurantName: `${tag} ${name}`, ownerName: 'Owner', ownerPhone: uniquePhone('9'), status: 'approved', zoneId },
        });
        created.restaurants.push(r.id);
        return r.id;
    };
    A = await restaurant('Alpha');
    B = await restaurant('Beta');

    const u = await prisma.foodUser.create({ data: { name: `${tag} User`, phone: uniquePhone('5') } });
    created.users.push(u.id);
    userId = u.id;

    // A coupon the platform and the restaurant fund 60 / 40.
    const split = await prisma.foodOffer.create({
        data: {
            couponCode: `${tag}SPLIT`.toUpperCase(), discountType: 'flat_price', discountValue: 100,
            adminBearPercentage: 60, restaurantBearPercentage: 40,
        },
    });
    const freeDelivery = await prisma.foodOffer.create({
        data: { couponCode: `${tag}FREE`.toUpperCase(), couponType: 'free_delivery', discountType: 'flat_price', discountValue: 0 },
    });
    created.offers.push(split.id, freeDelivery.id);

    // O1: split coupon, cash. total = 1000 + 20 + 40 + 7.20 + 10 + 50 − 100
    await makeOrder('O1', {
        subtotal: 1000, packagingFee: 20, deliveryFee: 40, deliveryFeeGst: 7.2, platformFee: 10, tax: 50,
        discount: 100, couponCode: split.couponCode, couponId: split.id, restaurantCommission: 100, total: 1027.2,
        createdAt: IN_PERIOD(10),
    });
    // O2: free-delivery coupon, paid online: fee columns are 0, the waiver is kept.
    await makeOrder('O2', {
        subtotal: 500, deliveryFee: 0, deliveryFeeGst: 0, couponDeliveryWaiver: 47.2, platformFee: 10, tax: 25,
        couponCode: freeDelivery.couponCode, couponId: freeDelivery.id, restaurantCommission: 50, total: 535,
        paymentMethod: 'razorpay', createdAt: IN_PERIOD(11),
    });
    // O3: no coupon, wallet, the other restaurant.
    await makeOrder('O3', {
        restaurantId: B, subtotal: 300, deliveryFee: 30, deliveryFeeGst: 5.4, platformFee: 5, tax: 15,
        restaurantCommission: 30, total: 355.4, paymentMethod: 'wallet', riderEarning: 25, createdAt: IN_PERIOD(12),
    });
    // O4: cancelled by admin, refunded in full.
    await makeOrder('O4', {
        subtotal: 200, deliveryFee: 10, platformFee: 5, tax: 5, restaurantCommission: 20, total: 220,
        orderStatus: 'cancelled_by_admin', deliveryPhase: 'en_route_to_pickup', paymentMethod: 'razorpay',
        paymentStatus: 'refunded', refundStatus: 'processed', refundAmount: 220, createdAt: IN_PERIOD(13),
    }, { txStatus: 'refunded' });
    // O5: still being prepared, cash not yet collected.
    await makeOrder('O5', {
        subtotal: 400, deliveryFee: 40, platformFee: 10, tax: 20, restaurantCommission: 40, total: 470,
        orderStatus: 'preparing', deliveryPhase: 'en_route_to_pickup', paymentStatus: 'cod_pending', createdAt: IN_PERIOD(14),
    });
    // O6: abandoned checkout — appears nowhere.
    await makeOrder('O6', {
        subtotal: 999, total: 999, orderStatus: 'pending_payment', deliveryPhase: 'en_route_to_pickup',
        paymentMethod: 'razorpay', paymentStatus: 'created', createdAt: IN_PERIOD(14),
    }, { tx: false });
    // O7: delivered, but outside the period.
    await makeOrder('O7', {
        subtotal: 700, platformFee: 10, tax: 35, restaurantCommission: 70, total: 745, createdAt: new Date('2019-02-20T12:00:00Z'),
    });
});

test.after(async () => {
    await prisma.foodTransaction.deleteMany({ where: { orderId: { in: created.orders } } });
    await prisma.foodOrder.deleteMany({ where: { id: { in: created.orders } } });
    await prisma.foodOffer.deleteMany({ where: { id: { in: created.offers } } });
    await prisma.foodUser.deleteMany({ where: { id: { in: created.users } } });
    await prisma.foodRestaurant.deleteMany({ where: { id: { in: created.restaurants } } });
    await prisma.foodZone.deleteMany({ where: { id: { in: created.zones } } });
    await prisma.$disconnect();
});

const Q = (over = {}) => ({ ...PERIOD, zoneId, limit: 100, ...over });
const byOrder = (rows) => new Map(rows.map((r) => [r.orderId, r]));
const close = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 0.005, `${message}: ${actual} ≠ ${expected}`);

const EXPECTED = {
    O1: {
        totalItemAmount: 1000, couponDiscount: 100, freeDeliveryDiscount: 0, discountedAmount: 100, vatTax: 50,
        deliveryCharge: 40, deliveryChargeGst: 7.2, additionalCharge: 10, extraPackagingAmount: 20, orderAmount: 1027.2,
        refundAmount: 0, adminDiscount: 60, storeDiscount: 40, adminCommission: 100, commissionOnDeliveryCharge: 10,
        deliverymanEarning: 30, adminNetIncome: 67.2, storeNetIncome: 880,
    },
    O2: {
        totalItemAmount: 500, couponDiscount: 0, freeDeliveryDiscount: 47.2, discountedAmount: 47.2, vatTax: 25,
        deliveryCharge: 0, deliveryChargeGst: 0, additionalCharge: 10, extraPackagingAmount: 0, orderAmount: 535,
        refundAmount: 0, adminDiscount: 0, storeDiscount: 0, adminCommission: 50, commissionOnDeliveryCharge: -30,
        deliverymanEarning: 30, adminNetIncome: 30, storeNetIncome: 450,
    },
    O3: {
        totalItemAmount: 300, couponDiscount: 0, freeDeliveryDiscount: 0, discountedAmount: 0, vatTax: 15,
        deliveryCharge: 30, deliveryChargeGst: 5.4, additionalCharge: 5, extraPackagingAmount: 0, orderAmount: 355.4,
        refundAmount: 0, adminDiscount: 0, storeDiscount: 0, adminCommission: 30, commissionOnDeliveryCharge: 5,
        deliverymanEarning: 25, adminNetIncome: 45.4, storeNetIncome: 270,
    },
};

test('every column of a delivered order, worked by hand', async () => {
    const report = await getOrderMoneyReport(Q());
    assert.equal(report.status, 'delivered');
    const rows = byOrder(report.orders);
    assert.deepEqual([...rows.keys()].sort(), [`${tag}-O1`, `${tag}-O2`, `${tag}-O3`]);

    for (const [name, expected] of Object.entries(EXPECTED)) {
        const row = rows.get(`${tag}-${name}`);
        for (const [key, value] of Object.entries(expected)) close(row[key], value, `${name}.${key}`);
        // What the customer paid is exactly the restaurant's net, the
        // platform's net, the rider's pay and the GST on the food.
        close(row.orderAmount, row.storeNetIncome + row.adminNetIncome + row.deliverymanEarning + row.vatTax, `${name} reconciles`);
        // Admin net income = commission + commission on delivery + platform fee + delivery GST − admin discount.
        close(row.adminNetIncome,
            row.adminCommission + row.commissionOnDeliveryCharge + row.additionalCharge + row.deliveryChargeGst - row.adminDiscount,
            `${name} admin net decomposes`);
        assert.equal(row.earned, true);
    }
    const o1 = rows.get(`${tag}-O1`);
    assert.equal(o1.restaurant, `${tag} Alpha`);
    assert.equal(o1.customerName, `${tag} Diner`);
    assert.equal(o1.amountReceivedBy, 'Deliveryman');
    assert.equal(o1.paymentMethodLabel, 'Cash on delivery');
    assert.equal(rows.get(`${tag}-O2`).amountReceivedBy, 'Admin');
});

test('the report agrees with the ledger row by row', async () => {
    const report = await getOrderMoneyReport(Q());
    for (const row of report.orders) {
        const tx = await prisma.foodTransaction.findUnique({ where: { orderId: row.id } });
        close(row.adminNetIncome, Number(tx.platformNetProfit), `${row.orderId} platformNetProfit`);
        close(row.storeNetIncome, Number(tx.restaurantShare), `${row.orderId} restaurantShare`);
        close(row.adminCommission, Number(tx.commissionAmount), `${row.orderId} commission`);
        close(row.deliverymanEarning, Number(tx.riderShare), `${row.orderId} riderShare`);
        close(row.adminDiscount, Number(tx.adminDiscountShare), `${row.orderId} admin discount`);
        close(row.storeDiscount, Number(tx.restaurantDiscountShare), `${row.orderId} restaurant discount`);
    }
});

test('totals and summary cards over the whole filtered set', async () => {
    const { totals, summary, pagination } = await getOrderMoneyReport(Q({ limit: 1 }));
    assert.equal(pagination.total, 3);
    assert.equal(pagination.pages, 3);
    assert.equal(totals.orders, 3);
    for (const key of Object.keys(EXPECTED.O1)) {
        const sum = Object.values(EXPECTED).reduce((s, e) => s + e[key], 0);
        close(totals[key], sum, `total ${key}`);
    }

    assert.equal(summary.allOrders, 5, 'the abandoned checkout and the out-of-period order are not counted');
    assert.equal(summary.deliveredOrders, 3);
    assert.equal(summary.ongoingOrders, 1);
    assert.equal(summary.cancelledOrders, 1);
    close(summary.cancelledAmount, 220, 'cancelled amount');
    assert.equal(summary.refundedOrders, 1);
    close(summary.refundedAmount, 220, 'refunded amount');
    close(summary.completedAmount, 1027.2 + 535 + 355.4, 'completed');
    close(summary.adminNetIncome, 67.2 + 30 + 45.4, 'admin net');
    close(summary.storeNetIncome, 880 + 450 + 270, 'store net');
    close(summary.deliverymanEarning, 85, 'rider');
    close(summary.adminCommission, 180, 'commission');
    close(summary.taxCollected, 50 + 25 + 15 + 7.2 + 5.4, 'tax incl. delivery GST');
    close(summary.discountGiven, 147.2, 'discounts incl. free delivery');
});

test('cancelled, refunded, ongoing and all: listed, but never income', async () => {
    const cancelled = await getOrderMoneyReport(Q({ status: 'cancelled' }));
    assert.deepEqual(cancelled.orders.map((r) => r.orderId), [`${tag}-O4`]);
    const o4 = cancelled.orders[0];
    assert.equal(o4.earned, false);
    assert.equal(o4.adminNetIncome, null);
    assert.equal(o4.storeNetIncome, null);
    assert.equal(o4.adminCommission, null);
    close(o4.orderAmount, 220, 'cancelled order amount');
    close(o4.refundAmount, 220, 'refund');
    assert.equal(cancelled.totals.adminNetIncome, 0);
    assert.equal(cancelled.totals.storeNetIncome, 0);
    close(cancelled.totals.refundAmount, 220, 'refund total');

    const refunded = await getOrderMoneyReport(Q({ status: 'refunded' }));
    assert.deepEqual(refunded.orders.map((r) => r.orderId), [`${tag}-O4`]);

    const ongoing = await getOrderMoneyReport(Q({ status: 'ongoing' }));
    assert.deepEqual(ongoing.orders.map((r) => r.orderId), [`${tag}-O5`]);
    assert.equal(ongoing.orders[0].storeNetIncome, null);

    const all = await getOrderMoneyReport(Q({ status: 'all' }));
    assert.equal(all.orders.length, 5);
    assert.ok(!all.orders.some((r) => r.orderId === `${tag}-O6`), 'abandoned checkout');
    // Newest first.
    assert.deepEqual(all.orders.map((r) => r.orderId), ['O5', 'O4', 'O3', 'O2', 'O1'].map((n) => `${tag}-${n}`));
    close(all.totals.storeNetIncome, 1600, 'income totals over earned orders only');
});

test('filters: restaurant, payment method, search, and ones that name nothing', async () => {
    const onlyB = await getOrderMoneyReport(Q({ restaurantId: B }));
    assert.deepEqual(onlyB.orders.map((r) => r.orderId), [`${tag}-O3`]);

    const cash = await getOrderMoneyReport(Q({ paymentMethod: 'cash' }));
    assert.deepEqual(cash.orders.map((r) => r.orderId), [`${tag}-O1`]);

    const search = await getOrderMoneyReport({ ...PERIOD, search: `${tag}-O2` });
    assert.deepEqual(search.orders.map((r) => r.orderId), [`${tag}-O2`]);

    const outOfPeriod = await getOrderMoneyReport(Q({ from: '2019-02-01', to: '2019-02-28' }));
    assert.deepEqual(outOfPeriod.orders.map((r) => r.orderId), [`${tag}-O7`]);

    for (const bad of [{ zoneId: 'nowhere' }, { restaurantId: 'f'.repeat(24) }, { paymentMethod: 'barter' }]) {
        const res = await getOrderMoneyReport(Q(bad));
        assert.equal(res.orders.length, 0, JSON.stringify(bad));
        assert.equal(res.summary.allOrders, 0, JSON.stringify(bad));
    }
    await assert.rejects(() => getOrderMoneyReport(Q({ status: 'lost' })), /Unknown status/);
});

test('store net income matches the Restaurant Earning report and the balance sheet', async () => {
    const report = await getOrderMoneyReport(Q());
    const netBy = new Map();
    const commissionBy = new Map();
    for (const r of report.orders) {
        netBy.set(r.restaurantId, (netBy.get(r.restaurantId) || 0) + r.storeNetIncome);
        commissionBy.set(r.restaurantId, (commissionBy.get(r.restaurantId) || 0) + r.adminCommission);
    }
    close(netBy.get(A), 1330, 'Alpha');
    close(netBy.get(B), 270, 'Beta');

    for (const id of [A, B]) {
        const earning = await getRestaurantEarningReport({ ...PERIOD, restaurantId: id });
        assert.equal(earning.restaurants.length, 1);
        close(earning.restaurants[0].net, netBy.get(id), 'earning report net');
        close(earning.restaurants[0].commission, commissionBy.get(id), 'earning report commission');
        assert.equal(earning.restaurants[0].orders, id === A ? 2 : 1);
    }

    // The balance sheet counts captured, unsettled ledger rows: the delivered
    // ones here; the refunded and the pending one are not owed.
    const balances = await getRestaurantBalances({ from: '2019-01-01T00:00:00Z', to: '2019-01-31T23:59:59Z' });
    const payable = new Map(balances.rows.map((r) => [r.entityId, r.payable]));
    close(payable.get(A), netBy.get(A), 'balance sheet Alpha');
    close(payable.get(B), netBy.get(B), 'balance sheet Beta');

    // Restaurant-wise Sales tab says the same.
    const sales = await getRestaurantWiseReport({ ...PERIOD, zoneId, tab: 'sales' });
    const salesBy = new Map(sales.restaurants.map((r) => [r.restaurantId, r]));
    close(salesBy.get(A).storeNetIncome, netBy.get(A), 'sales tab Alpha');
    close(salesBy.get(B).storeNetIncome, netBy.get(B), 'sales tab Beta');
    close(sales.totals.storeNetIncome, report.totals.storeNetIncome, 'sales tab total = transaction report total');
    close(sales.totals.adminCommission, report.totals.adminCommission, 'commission total');
    close(sales.totals.orderAmount, report.totals.orderAmount, 'order amount total');
    close(sales.totals.adminDiscount, 60, 'admin-funded discount');
    close(sales.totals.storeDiscount, 40, 'restaurant-funded discount');
    close(salesBy.get(A).totalItemAmount, 1500, 'Alpha item amount');
    assert.equal(sales.totals.deliveredOrders, 3);
});

test('restaurant-wise summary: counts and rates', async () => {
    const { restaurants, totals } = await getRestaurantWiseReport({ ...PERIOD, zoneId, tab: 'summary' });
    assert.equal(restaurants.length, 2);
    const a = restaurants.find((r) => r.restaurantId === A);
    const b = restaurants.find((r) => r.restaurantId === B);
    assert.equal(restaurants[0].restaurantId, A, 'most orders first');

    assert.equal(a.totalOrders, 4);
    assert.equal(a.deliveredOrders, 2);
    assert.equal(a.ongoingOrders, 1);
    assert.equal(a.cancelledOrders, 1);
    assert.equal(a.refundRequests, 1);
    close(a.totalAmount, 1027.2 + 535, 'Alpha delivered amount');
    assert.equal(a.completionRate, 50);
    assert.equal(a.ongoingRate, 25);
    assert.equal(a.cancellationRate, 25);

    assert.equal(b.totalOrders, 1);
    assert.equal(b.completionRate, 100);
    assert.equal(b.cancellationRate, 0);

    assert.equal(totals.restaurants, 2);
    assert.equal(totals.restaurantsWithSales, 2);
    assert.equal(totals.totalOrders, 5);
    assert.equal(totals.deliveredOrders, 3);
    assert.equal(totals.completionRate, 60);
    assert.equal(totals.ongoingRate, 20);
    assert.equal(totals.cancellationRate, 20);
});

test('restaurant-wise order tab: status and payment breakdown', async () => {
    const { restaurants, totals } = await getRestaurantWiseReport({ ...PERIOD, zoneId, tab: 'order' });
    const a = restaurants.find((r) => r.restaurantId === A);
    assert.equal(a.totalOrders, 4);
    assert.equal(a.pendingOrders, 0);
    assert.equal(a.processingOrders, 1);
    assert.equal(a.onTheWayOrders, 0);
    assert.equal(a.deliveredOrders, 2);
    assert.equal(a.cancelledOrders, 1);
    assert.equal(a.refundedOrders, 1);
    assert.equal(a.cashOrders, 2);
    assert.equal(a.onlineOrders, 2);
    assert.equal(a.walletOrders, 0);
    close(a.totalAmount, 1027.2 + 535 + 220 + 470, 'all orders amount');
    close(a.deliveredAmount, 1027.2 + 535, 'delivered amount');
    assert.equal(totals.walletOrders, 1);
    assert.equal(totals.totalOrders, 5);
    await assert.rejects(() => getRestaurantWiseReport({ ...PERIOD, tab: 'nope' }), /Unknown tab/);
});

test('keyset iteration returns every row once, in order', async () => {
    const seen = [];
    for await (const batch of iterateOrderMoneyRows(Q({ status: 'all' }), 2)) {
        assert.ok(batch.length <= 2);
        seen.push(...batch.map((r) => r.orderId));
    }
    assert.deepEqual(seen, ['O5', 'O4', 'O3', 'O2', 'O1'].map((n) => `${tag}-${n}`));
});

/** A stand-in for the Express response that collects what was written. */
function fakeResponse() {
    const res = new PassThrough();
    const chunks = [];
    res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    res.headers = {};
    res.headersSent = false;
    res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
    res.status = (code) => { res.statusCode = code; return res; };
    const done = new Promise((resolve) => res.on('end', resolve));
    res.body = async () => { await done; return Buffer.concat(chunks); };
    return res;
}

test('CSV export streams the full filtered set, not a page', async () => {
    const res = fakeResponse();
    await exportOrderMoneyReport(Q({ format: 'csv', limit: 1 }), res);
    const text = (await res.body()).toString('utf8').replace(/^﻿/, '');
    const lines = text.trim().split('\r\n');
    assert.match(res.headers['content-type'], /text\/csv/);
    assert.match(res.headers['content-disposition'], /transaction-report-delivered-2019-01-01-to-2019-01-31\.csv/);
    assert.equal(lines.length, 4, 'header + 3 delivered orders');
    const header = lines[0].split(',');
    const o1 = lines.find((l) => l.includes(`${tag}-O1`)).split(',');
    assert.equal(o1[header.indexOf('Admin net income')], '67.2');
    assert.equal(o1[header.indexOf('Restaurant net income')], '880');
    assert.equal(o1[header.indexOf('Amount received by')], 'Deliveryman');
});

test('Excel export opens and carries the same numbers', async () => {
    const res = fakeResponse();
    await exportOrderMoneyReport(Q({ format: 'xlsx', status: 'all' }), res);
    const buffer = await res.body();
    const { default: ExcelJS } = await import('exceljs');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const sheet = workbook.worksheets[0];
    assert.equal(sheet.rowCount, 6, 'header + 5 orders');
    const header = sheet.getRow(1).values;
    const col = (label) => header.indexOf(label);
    const cancelledRow = [2, 3, 4, 5, 6].map((n) => sheet.getRow(n)).find((r) => r.getCell(col('Order id')).value === `${tag}-O4`);
    assert.equal(cancelledRow.getCell(col('Order amount')).value, 220);
    assert.equal(cancelledRow.getCell(col('Admin net income')).value, null, 'no income on a cancelled order');

    const res2 = fakeResponse();
    await exportRestaurantWiseReport({ ...PERIOD, zoneId, tab: 'summary', format: 'csv' }, res2);
    const lines = (await res2.body()).toString('utf8').replace(/^﻿/, '').trim().split('\r\n');
    assert.equal(lines.length, 3);
    assert.match(lines[0], /Completion rate/);
    assert.ok(lines[1].includes(`${tag} Alpha`) && lines[1].includes(',50,25,25,1'), lines[1]);
});
