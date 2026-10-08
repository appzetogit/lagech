import test from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';

import { prisma } from '../../../../config/prisma.js';
import { uniquePhone, uniqueTag } from '../../../../utils/testIds.js';
import { listOrdersAdmin } from '../../orders/services/order.service.js';
import {
    ORDER_EXPORT_COLUMNS,
    adminOrderBatches,
    formatOrderDate,
    orderExportRow,
    streamAdminOrdersExport,
} from '../../orders/services/adminOrderExport.service.js';
import { approveAllPendingRestaurants, setRestaurantFeatured } from './adminListTools.service.js';
import { getDeliveryPartnerById, getBulkDeliveryPartnerStats } from './adminDeliveryPartner.service.js';
import { buildTemplate } from './adminBulkCatalog.service.js';
import { CATEGORY_COLUMNS, RESTAURANT_COLUMNS } from './bulkRows.js';
import { listApprovedRestaurants } from '../../restaurant/services/restaurant.service.js';
import { parseCsv } from '../../shared/sheet.util.js';

/**
 * The admin list tools: the order lists' server export (with the offline
 * payment sub-tabs), the restaurant Featured toggle and Verify all, the rider
 * list's availability, and the bulk "template with existing data".
 */

const made = { restaurants: [], users: [], partners: [], orders: [], categories: [] };

test.after(async () => {
    await prisma.foodOrder.deleteMany({ where: { id: { in: made.orders } } });
    await prisma.foodUser.deleteMany({ where: { id: { in: made.users } } });
    await prisma.foodDeliveryPartner.deleteMany({ where: { id: { in: made.partners } } });
    await prisma.foodRestaurantOutletTimings.deleteMany({ where: { restaurantId: { in: made.restaurants } } });
    await prisma.foodRestaurant.deleteMany({ where: { id: { in: made.restaurants } } });
    await prisma.foodCategory.deleteMany({ where: { id: { in: made.categories } } });
    await prisma.$disconnect();
});

const restaurant = async (extra = {}) => {
    const r = await prisma.foodRestaurant.create({
        data: { restaurantName: uniqueTag('Rest '), ownerName: 'Owner', ownerPhone: uniquePhone('9'), status: 'approved', ...extra },
    });
    made.restaurants.push(r.id);
    return r;
};

const user = async () => {
    const u = await prisma.foodUser.create({ data: { phone: uniquePhone('5'), name: 'Test Customer' } });
    made.users.push(u.id);
    return u;
};

const order = async (rest, customer, extra = {}, items = []) => {
    const o = await prisma.foodOrder.create({
        data: {
            userId: customer.id,
            restaurantId: rest.id,
            orderId: uniqueTag('ORD').slice(0, 20),
            customerName: 'Asha, "A" Rao',
            customerPhone: customer.phone,
            addrStreet: '1 Test Street',
            addrCity: 'Indore',
            addrState: 'MP',
            subtotal: 100,
            total: 123.456,
            paymentMethod: 'cash',
            orderStatus: 'delivered',
            ...extra,
            ...(items.length
                ? { items: { create: items.map((q, i) => ({ itemId: `item${i}`, name: `Dish ${i}`, price: 10, quantity: q })) } }
                : {}),
        },
    });
    made.orders.push(o.id);
    return o;
};

/** A writable that keeps what an export streams, standing in for res. */
const fakeResponse = () => {
    const chunks = [];
    const headers = {};
    const res = new Writable({
        write(chunk, _enc, done) {
            chunks.push(Buffer.from(chunk));
            done();
        },
    });
    res.setHeader = (k, v) => {
        headers[k.toLowerCase()] = v;
    };
    const finished = new Promise((resolve) => res.on('finish', resolve));
    return { res, headers, finished, body: () => Buffer.concat(chunks) };
};

test('an order export row carries the old panel columns', () => {
    const row = orderExportRow(
        {
            id: 'abc', orderId: 'ORD-1', createdAt: new Date('2026-10-06T08:30:00Z'), customerName: 'Asha', customerPhone: '9000000000',
            restaurant: { restaurantName: 'Spice Hub' }, items: [{ quantity: 2 }, { quantity: 3 }], total: '250.5',
            paymentMethod: 'offline', paymentStatus: 'paid', orderStatus: 'picked_up', deliveryPartner: { name: 'Ravi' },
        },
        4,
    );
    assert.equal(row.length, ORDER_EXPORT_COLUMNS.length);
    assert.deepEqual(row, [5, 'ORD-1', '2026-10-06 14:00', 'Asha', '9000000000', 'Spice Hub', 5, 250.5, 'Offline payment', 'Paid', 'On the way', 'Ravi']);
    assert.equal(formatOrderDate(null), '');
});

test('offline payment sub-tabs split orders by verification state', async () => {
    const rest = await restaurant();
    const customer = await user();
    const pending = await order(rest, customer, { paymentMethod: 'offline', paymentStatus: 'created', orderStatus: 'pending_payment' });
    const verified = await order(rest, customer, { paymentMethod: 'offline', paymentStatus: 'paid', orderStatus: 'confirmed' });
    const denied = await order(rest, customer, { paymentMethod: 'offline', paymentStatus: 'failed', orderStatus: 'cancelled_by_admin' });
    await order(rest, customer); // cash: never on the offline tab

    const ids = async (offlineStatus) => {
        const res = await listOrdersAdmin({ status: 'offline-payments', restaurantId: rest.id, ...(offlineStatus ? { offlineStatus } : {}) });
        return res.orders.map((o) => String(o.id || o._id)).sort();
    };
    assert.deepEqual(await ids(), [pending.id, verified.id, denied.id].sort());
    assert.deepEqual(await ids('pending'), [pending.id]);
    assert.deepEqual(await ids('verified'), [verified.id]);
    assert.deepEqual(await ids('denied'), [denied.id]);
});

test('the order export streams every matching order as CSV, not one page', async () => {
    const rest = await restaurant();
    const customer = await user();
    const first = await order(rest, customer, {}, [2, 1]);
    for (let i = 0; i < 4; i += 1) await order(rest, customer);
    await order(rest, customer, { orderStatus: 'cancelled_by_user' });

    // Batches walk past the first one with a cursor and lose nothing.
    let seen = 0;
    for await (const batch of adminOrderBatches({ status: 'delivered', restaurantId: rest.id }, { batchSize: 2 })) seen += batch.length;
    assert.equal(seen, 5);

    const out = fakeResponse();
    await streamAdminOrdersExport({ status: 'delivered', restaurantId: rest.id, format: 'csv' }, out.res);
    await out.finished;
    assert.match(out.headers['content-type'], /text\/csv/);
    assert.match(out.headers['content-disposition'], /orders-delivered-.*\.csv/);
    const text = out.body().toString('utf8');
    assert.ok(text.startsWith('﻿'), 'BOM for Excel');
    const rows = parseCsv(text).filter((r) => r.some(Boolean));
    assert.deepEqual(rows[0], ORDER_EXPORT_COLUMNS);
    assert.equal(rows.length, 6, 'header + the five delivered orders');
    assert.deepEqual(rows.slice(1).map((r) => r[0]), ['1', '2', '3', '4', '5']);
    const firstRow = rows.find((r) => r[1] === first.orderId);
    assert.equal(firstRow[3], 'Asha, "A" Rao', 'quoted cell survives');
    assert.equal(firstRow[6], '3', 'item quantity summed');
    assert.equal(firstRow[7], '123.46');
});

test('the order export writes a real xlsx', async () => {
    const rest = await restaurant();
    const customer = await user();
    await order(rest, customer);
    await order(rest, customer);

    const out = fakeResponse();
    await streamAdminOrdersExport({ restaurantId: rest.id, format: 'xlsx' }, out.res);
    await out.finished;
    const { default: ExcelJS } = await import('exceljs');
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(out.body());
    const sheet = book.worksheets[0];
    assert.equal(sheet.getRow(1).getCell(2).value, 'Order Id');
    assert.equal(sheet.actualRowCount, 3);
});

test('featured toggle saves and reaches the public card and filter', async () => {
    const rest = await restaurant();
    assert.deepEqual(await setRestaurantFeatured(rest.id, true), { id: rest.id, isFeatured: true });
    const featured = await listApprovedRestaurants({ featured: 'true', search: rest.restaurantName, limit: 50 });
    const list = featured.restaurants || featured.data || featured.docs || [];
    const card = list.find((r) => r.id === rest.id);
    assert.ok(card, 'listed under featured=true');
    assert.equal(card.isFeatured, true);

    await setRestaurantFeatured(rest.id, 'false');
    assert.equal((await prisma.foodRestaurant.findUnique({ where: { id: rest.id } })).isFeatured, false);
    await assert.rejects(() => setRestaurantFeatured(rest.id, 'maybe'), /true or false/);
    await assert.rejects(() => setRestaurantFeatured('0123456789abcdef01234567', true), /not found/i);
});

test('verify all approves pending restaurants only', async () => {
    const pending = await restaurant({ status: 'pending' });
    const rejected = await restaurant({ status: 'rejected', rejectionReason: 'Bad documents' });
    const result = await approveAllPendingRestaurants();
    assert.ok(result.approved >= 1);
    assert.deepEqual(result.failed, []);
    const [p, r] = await Promise.all([
        prisma.foodRestaurant.findUnique({ where: { id: pending.id } }),
        prisma.foodRestaurant.findUnique({ where: { id: rejected.id } }),
    ]);
    assert.equal(p.status, 'approved');
    assert.ok(p.approvedAt);
    assert.equal(r.status, 'rejected', 'a rejected restaurant is left for a person');
});

test('rider list: completed orders and availability, with on a delivery first', async () => {
    const rest = await restaurant();
    const customer = await user();
    const partner = await prisma.foodDeliveryPartner.create({
        data: { name: 'Rider', phone: uniquePhone('6'), status: 'approved', availabilityStatus: 'online' },
    });
    made.partners.push(partner.id);

    assert.equal((await getDeliveryPartnerById(partner.id)).availability, 'online');

    await order(rest, customer, { dispatchDeliveryPartnerId: partner.id });
    await order(rest, customer, { dispatchDeliveryPartnerId: partner.id, orderStatus: 'picked_up', dispatchStatus: 'accepted' });
    // Assigned but not accepted: not yet on a delivery.
    await order(rest, customer, { dispatchDeliveryPartnerId: partner.id, orderStatus: 'preparing', dispatchStatus: 'assigned' });

    const stats = (await getBulkDeliveryPartnerStats([partner.id])).get(partner.id);
    assert.equal(stats.totalOrders, 1, 'delivered only');
    assert.equal(stats.activeOrders, 1);
    const row = await getDeliveryPartnerById(partner.id);
    assert.equal(row.availability, 'on_delivery');
    assert.equal(row.totalOrders, 1);
});

test('template with existing data uses the import columns', async () => {
    const name = uniqueTag('Cat ');
    const cat = await prisma.foodCategory.create({ data: { name, sortOrder: 4 } });
    made.categories.push(cat.id);

    const empty = await buildTemplate('categories', 'csv');
    assert.equal(parseCsv(empty.buffer.toString('utf8')).filter((r) => r.some(Boolean)).length, 1);

    const filled = await buildTemplate('categories', 'csv', { withData: true });
    assert.match(filled.filename, /With_Data\.csv$/);
    const rows = parseCsv(filled.buffer.toString('utf8')).filter((r) => r.some(Boolean));
    assert.deepEqual(rows[0], CATEGORY_COLUMNS);
    const mine = rows.find((r) => r[0] === cat.id);
    assert.ok(mine, 'existing category listed with its Id');
    assert.equal(mine[1], name);
    assert.equal(mine.length, CATEGORY_COLUMNS.length);

    const rest = await restaurant();
    const restaurants = await buildTemplate('restaurants', 'csv', { withData: true });
    const rrows = parseCsv(restaurants.buffer.toString('utf8')).filter((r) => r.some(Boolean));
    assert.deepEqual(rrows[0], RESTAURANT_COLUMNS);
    const line = rrows.find((r) => r[0] === rest.restaurantName);
    assert.ok(line, 'restaurant row starts with its name, not the id');
    assert.equal(line.length, RESTAURANT_COLUMNS.length);
});
