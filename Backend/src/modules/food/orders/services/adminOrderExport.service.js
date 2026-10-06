import { prisma } from '../../../../config/prisma.js';
import { toCsv } from '../../shared/sheet.util.js';
import { buildAdminOrdersWhere } from './order.service.js';

/**
 * The admin order lists' "Export -> Excel / .Csv", done on the server.
 *
 * Takes exactly the list's query (status tab, search, payment status, amount,
 * dates, restaurant, zone, offline sub-tab) through buildAdminOrdersWhere, so
 * the file holds every order the list would page through, and streams it in
 * batches: an all-orders export can run to tens of thousands of rows, which
 * neither the browser nor one findMany should hold at once.
 */

export const ORDER_EXPORT_MAX_ROWS = 100000;
const BATCH = 1000;

export const ORDER_EXPORT_COLUMNS = [
    'Sl', 'Order Id', 'Order Date', 'Customer Name', 'Customer Phone', 'Restaurant',
    'Item Quantity', 'Total Amount', 'Payment Method', 'Payment Status', 'Order Status', 'Delivery Man',
];

const ORDER_STATUS_LABELS = {
    created: 'Pending',
    confirmed: 'Accepted',
    preparing: 'Processing',
    ready_for_pickup: 'Ready for pickup',
    reached_pickup: 'Rider at restaurant',
    picked_up: 'On the way',
    reached_drop: 'Rider at customer',
    delivered: 'Delivered',
    cancelled_by_user: 'Canceled by customer',
    cancelled_by_restaurant: 'Canceled by restaurant',
    cancelled_by_admin: 'Canceled by admin',
    pending_payment: 'Awaiting payment',
};

const PAYMENT_METHOD_LABELS = {
    cash: 'Cash on delivery', razorpay: 'Online', razorpay_qr: 'QR at delivery', wallet: 'Wallet', offline: 'Offline payment',
};

const words = (value) =>
    String(value || '')
        .replace(/_/g, ' ')
        .replace(/^\w/, (c) => c.toUpperCase());

const two = (n) => String(n).padStart(2, '0');

/** Local wall-clock time in India, as the admin reads it: 2026-10-06 14:05. */
export function formatOrderDate(value) {
    if (!value) return '';
    const d = new Date(new Date(value).getTime() + 330 * 60 * 1000);
    if (Number.isNaN(d.getTime())) return '';
    return `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`;
}

/** One order row -> the export's cells. */
export function orderExportRow(order, index) {
    const quantity = (order.items || []).reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
    const total = Number(order.total);
    return [
        index + 1,
        order.orderId || order.order_id || order.id,
        formatOrderDate(order.createdAt),
        order.customerName || order.user?.name || '',
        order.customerPhone || order.user?.phone || '',
        order.restaurant?.restaurantName || '',
        quantity,
        Number.isFinite(total) ? Math.round(total * 100) / 100 : '',
        PAYMENT_METHOD_LABELS[order.paymentMethod] || words(order.paymentMethod),
        words(order.paymentStatus),
        ORDER_STATUS_LABELS[order.orderStatus] || words(order.orderStatus),
        order.deliveryPartner?.name || '',
    ];
}

const SELECT = {
    id: true,
    orderId: true,
    order_id: true,
    createdAt: true,
    customerName: true,
    customerPhone: true,
    total: true,
    paymentMethod: true,
    paymentStatus: true,
    orderStatus: true,
    user: { select: { name: true, phone: true } },
    restaurant: { select: { restaurantName: true } },
    deliveryPartner: { select: { name: true } },
    items: { select: { quantity: true } },
};

/** Every matching order, in the list's order, one batch at a time. */
export async function* adminOrderBatches(query = {}, { batchSize = BATCH, maxRows = ORDER_EXPORT_MAX_ROWS } = {}) {
    const { where, orderBy } = buildAdminOrdersWhere(query);
    // The id breaks ties so the cursor walk is stable.
    const order = [...(Array.isArray(orderBy) ? orderBy : [orderBy]), { id: 'desc' }];
    let cursor = null;
    let sent = 0;
    while (sent < maxRows) {
        const rows = await prisma.foodOrder.findMany({
            where,
            orderBy: order,
            select: SELECT,
            take: Math.min(batchSize, maxRows - sent),
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        });
        if (!rows.length) return;
        yield rows;
        sent += rows.length;
        if (rows.length < batchSize) return;
        cursor = rows[rows.length - 1].id;
    }
}

const fileStem = (query) => {
    const status = String(query.status || 'all').replace(/[^\w-]+/g, '') || 'all';
    const sub = query.offlineStatus ? `-${String(query.offlineStatus).replace(/[^\w-]+/g, '')}` : '';
    return `orders-${status}${sub}-${new Date().toISOString().slice(0, 10)}`;
};

/** Stream the export to an Express response as .csv or .xlsx. */
export async function streamAdminOrdersExport(query, res) {
    const format = String(query.format || '').toLowerCase() === 'csv' ? 'csv' : 'xlsx';
    const name = fileStem(query);
    let index = 0;

    if (format === 'csv') {
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${name}.csv"`);
        // toCsv writes the BOM and header with the first chunk only.
        res.write(toCsv(ORDER_EXPORT_COLUMNS, []));
        for await (const batch of adminOrderBatches(query)) {
            const rows = batch.map((order) => orderExportRow(order, index++));
            res.write(toCsv([], rows).replace(/^﻿\r\n/, ''));
        }
        res.end();
        return;
    }

    const { default: ExcelJS } = await import('exceljs');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${name}.xlsx"`);
    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: res, useStyles: true, useSharedStrings: false });
    const sheet = workbook.addWorksheet('Orders', { views: [{ state: 'frozen', ySplit: 1 }] });
    sheet.columns = ORDER_EXPORT_COLUMNS.map((header) => ({ header, width: Math.max(12, header.length + 6) }));
    sheet.getRow(1).font = { bold: true };
    sheet.getRow(1).commit();
    for await (const batch of adminOrderBatches(query)) {
        for (const order of batch) sheet.addRow(orderExportRow(order, index++)).commit();
    }
    sheet.commit();
    await workbook.commit();
}
