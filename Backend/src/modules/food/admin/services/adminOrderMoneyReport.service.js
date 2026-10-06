import { Prisma } from '@prisma/client';
import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { ValidationError } from '../../../../core/auth/errors.js';
import { parsePeriod } from './adminReports.service.js';
import { EARNED_ORDER, RESTAURANT_SHARE } from '../../shared/restaurantPayout.sql.js';
import { streamSheet } from './reportSheetStream.util.js';

/**
 * The per-order money report (the old panel's Transaction report and Order
 * report) and the restaurant-wise roll-up (Summary / Sales / Order tabs).
 *
 * Every money column comes from the same place the rest of the system reads
 * it, so this report cannot disagree with the ledger:
 *
 *   - the order's own pricing columns for what the customer was charged
 *     (subtotal, packaging, delivery fee + its GST, platform fee, GST on
 *     items, coupon discount, total);
 *   - the order's FoodTransaction for the split written at checkout by
 *     createInitialTransaction(): who bore the discount, the commission, the
 *     rider's pay, the platform's net profit and the restaurant's share.
 *
 * The restaurant's net is RESTAURANT_SHARE, the same expression the
 * Restaurant Earning report, the restaurant wallet and payouts use. The
 * platform's net is platformNetProfit, i.e.
 *
 *   deliveryFee + deliveryFeeGst + platformFee + restaurantCommission
 *     + riderTip − riderEarning − adminDiscountShare
 *
 * where riderEarning includes the customer's tip (riderTip), all of which is
 * the rider's -- so the tip passes through and is never the platform's. Per
 * order the four parts add back up to what the customer paid:
 *
 *   orderAmount = storeNet + adminNet + deliverymanEarning (incl. tip) + tax
 *
 * Only delivered orders earn anything (EARNED_ORDER). Cancelled and refunded
 * orders are listed and counted separately; their income columns are null —
 * "does not apply" — rather than 0.
 */

const num = (value) => Math.round((Number(value) || 0) * 100) / 100;

// ─── SQL building blocks (orders `o`, transactions `t`, restaurants `r`) ─────

const CANCELLED = Prisma.sql`o."orderStatus" IN ('cancelled_by_user', 'cancelled_by_restaurant', 'cancelled_by_admin')`;
const EARNED = Prisma.sql`(${EARNED_ORDER})`;
const ONGOING = Prisma.sql`(NOT (${CANCELLED}) AND NOT ${EARNED})`;
const REFUNDED = Prisma.sql`o."refundStatus" = 'processed'`;

/** Platform-funded part of the coupon. No transaction = no recorded split: the platform bore it (resolveDiscountSplit's own fallback). */
const ADMIN_DISCOUNT = Prisma.sql`CASE WHEN t.id IS NULL THEN o."discount" ELSE t."adminDiscountShare" END`;
/** Restaurant-funded part of the coupon. */
const STORE_DISCOUNT = Prisma.sql`COALESCE(t."restaurantDiscountShare", 0)`;
const COMMISSION = Prisma.sql`COALESCE(t."commissionAmount", o."restaurantCommission")`;
const RIDER = Prisma.sql`COALESCE(t."riderShare", o."riderEarning")`;
/** The customer's tip: part of RIDER, all of it the rider's. */
const TIP = Prisma.sql`o."riderTip"`;
/** platformNetProfit; reconstructed by the same formula for an order without a transaction. */
const ADMIN_NET = Prisma.sql`COALESCE(
    t."platformNetProfit",
    o."deliveryFee" + o."deliveryFeeGst" + o."platformFee" + o."restaurantCommission" + o."riderTip" - o."riderEarning" - o."discount"
)`;
const STORE_NET = RESTAURANT_SHARE;
/** The part of the order paid from the wallet: all of a wallet order, the wallet part of a partial payment. */
const WALLET_PAID = Prisma.sql`CASE WHEN o."paymentMethod" = 'wallet' THEN o."total" ELSE o."walletAmount" END`;
/** Wallet + another method (partial payment). */
const PARTIAL = Prisma.sql`(o."walletAmount" > 0 AND o."paymentMethod" <> 'wallet')`;

/**
 * Every money column, as [key, SQL, incomeOnly]. incomeOnly columns are
 * null on an order that did not earn (cancelled / not yet delivered), and are
 * totalled over earned orders only.
 */
const MONEY = [
    ['totalItemAmount', Prisma.sql`o."subtotal"`, false],
    ['couponDiscount', Prisma.sql`o."discount"`, false],
    ['freeDeliveryDiscount', Prisma.sql`o."couponDeliveryWaiver"`, false],
    ['discountedAmount', Prisma.sql`(o."discount" + o."couponDeliveryWaiver")`, false],
    ['vatTax', Prisma.sql`o."tax"`, false],
    ['deliveryCharge', Prisma.sql`o."deliveryFee"`, false],
    ['deliveryChargeGst', Prisma.sql`o."deliveryFeeGst"`, false],
    ['additionalCharge', Prisma.sql`o."platformFee"`, false],
    ['extraPackagingAmount', Prisma.sql`o."packagingFee"`, false],
    ['orderAmount', Prisma.sql`o."total"`, false],
    ['refundAmount', Prisma.sql`CASE WHEN ${REFUNDED} THEN o."refundAmount" ELSE 0 END`, false],
    // How orderAmount was paid: walletPaidAmount + otherPaidAmount = orderAmount.
    ['walletPaidAmount', WALLET_PAID, false],
    ['otherPaidAmount', Prisma.sql`(o."total" - ${WALLET_PAID})`, false],
    ['adminDiscount', ADMIN_DISCOUNT, true],
    ['storeDiscount', STORE_DISCOUNT, true],
    ['adminCommission', COMMISSION, true],
    // Trip pay only: the tip is not paid out of the delivery fee.
    ['commissionOnDeliveryCharge', Prisma.sql`(o."deliveryFee" - (${RIDER} - ${TIP}))`, true],
    ['riderTip', TIP, true],
    ['deliverymanEarning', RIDER, true],
    ['adminNetIncome', ADMIN_NET, true],
    ['storeNetIncome', STORE_NET, true],
];

const MONEY_SELECT = Prisma.join(
    MONEY.map(([key, sql]) => Prisma.sql`${sql} AS ${Prisma.raw(`"${key}"`)}`),
    ', ',
);

/** SUM of every money column; income-only ones over earned orders only. */
const MONEY_SUMS = Prisma.join(
    MONEY.map(([key, sql, incomeOnly]) => (incomeOnly
        ? Prisma.sql`COALESCE(SUM(${sql}) FILTER (WHERE ${EARNED}), 0) AS ${Prisma.raw(`"${key}"`)}`
        : Prisma.sql`COALESCE(SUM(${sql}), 0) AS ${Prisma.raw(`"${key}"`)}`)),
    ', ',
);

const JOINS = Prisma.sql`
    FROM food_orders o
    JOIN food_restaurants r ON r.id = o."restaurantId"
    LEFT JOIN food_users u ON u.id = o."userId"
    LEFT JOIN food_transactions t ON t."orderId" = o.id`;

export const ORDER_STATUS_FILTERS = ['delivered', 'cancelled', 'refunded', 'ongoing', 'all'];

const STATUS_SQL = {
    delivered: EARNED,
    cancelled: Prisma.sql`(${CANCELLED})`,
    refunded: Prisma.sql`(${REFUNDED})`,
    ongoing: ONGOING,
    all: Prisma.sql`TRUE`,
};

/** 'partial' = wallet + another method; the others match the order's method (a partial payment's rest). */
const PAYMENT_METHODS = ['cash', 'razorpay', 'razorpay_qr', 'wallet', 'offline', 'partial'];

const PAYMENT_LABEL = {
    cash: 'Cash on delivery',
    razorpay: 'Online (Razorpay)',
    razorpay_qr: 'Online (QR)',
    wallet: 'Wallet',
    offline: 'Offline payment',
};

/** The method paying the rest of a partial payment, as in "Wallet + Razorpay". */
const PARTIAL_REST_LABEL = {
    cash: 'Cash on delivery',
    razorpay: 'Razorpay',
    razorpay_qr: 'Razorpay QR',
    offline: 'Offline payment',
};

const paymentLabel = (method, partial) => (partial
    ? `Wallet + ${PARTIAL_REST_LABEL[method] || method}`
    : PAYMENT_LABEL[method] || method);

/**
 * Who holds the customer's money: the rider collects cash, everything else
 * reaches the platform. A partial payment's wallet part is the platform's.
 */
const receivedBy = (method, partial = false) => {
    if (method !== 'cash') return 'Admin';
    return partial ? 'Admin + Deliveryman' : 'Deliveryman';
};

/** Shared filters: period, zone, restaurant, payment method, search. Status is applied by the caller. */
function readFilters(query = {}) {
    const { start, end } = parsePeriod({
        from: query.from || query.fromDate,
        to: query.to || query.toDate,
    });
    const status = String(query.status || 'delivered').toLowerCase();
    if (!ORDER_STATUS_FILTERS.includes(status)) throw new ValidationError(`Unknown status "${query.status}"`);

    const zoneId = String(query.zoneId || query.zone || '').trim();
    const restaurantId = String(query.restaurantId || query.restaurant || '').trim();
    const paymentMethod = String(query.paymentMethod || '').trim();
    const search = String(query.search || '').trim();

    const parts = [
        Prisma.sql`o."orderStatus" <> 'pending_payment'`,
        Prisma.sql`o."createdAt" BETWEEN ${start} AND ${end}`,
    ];
    // An id that is not an id names nothing, so it matches nothing rather than everything.
    if (zoneId) parts.push(isId(zoneId) ? Prisma.sql`COALESCE(o."zoneId", r."zoneId") = ${zoneId}` : Prisma.sql`FALSE`);
    if (restaurantId) parts.push(isId(restaurantId) ? Prisma.sql`o."restaurantId" = ${restaurantId}` : Prisma.sql`FALSE`);
    if (paymentMethod) {
        parts.push(!PAYMENT_METHODS.includes(paymentMethod)
            ? Prisma.sql`FALSE`
            : paymentMethod === 'partial'
                ? PARTIAL
                : Prisma.sql`o."paymentMethod"::text = ${paymentMethod}`);
    }
    if (search) {
        const like = `%${search}%`;
        parts.push(Prisma.sql`(COALESCE(o."order_id", o."orderId", o.id) ILIKE ${like}
            OR o."customerName" ILIKE ${like} OR u.name ILIKE ${like} OR r."restaurantName" ILIKE ${like})`);
    }
    return { start, end, status, base: Prisma.join(parts, ' AND ') };
}

const ROW_SELECT = Prisma.sql`
    SELECT o.id,
           COALESCE(o."order_id", o."orderId", o.id) AS "orderId",
           o."createdAt" AS "createdAt",
           o."orderStatus"::text AS "orderStatus",
           o."paymentMethod"::text AS "paymentMethod",
           o."paymentStatus"::text AS "paymentStatus",
           ${PARTIAL} AS "partialPayment",
           o."refundStatus"::text AS "refundStatus",
           o."couponCode" AS "couponCode",
           o."restaurantId" AS "restaurantId",
           r."restaurantName" AS restaurant,
           COALESCE(NULLIF(o."customerName", ''), u.name, '') AS "customerName",
           ${EARNED} AS earned,
           ${MONEY_SELECT}`;

function mapRow(row, index) {
    const out = {
        sl: index,
        id: row.id,
        orderId: row.orderId,
        date: row.createdAt,
        restaurantId: row.restaurantId,
        restaurant: row.restaurant || '',
        customerName: row.customerName || 'Guest',
        orderStatus: row.orderStatus,
        paymentMethod: row.paymentMethod,
        paymentMethodLabel: paymentLabel(row.paymentMethod, Boolean(row.partialPayment)),
        partialPayment: Boolean(row.partialPayment),
        paymentStatus: row.paymentStatus,
        amountReceivedBy: receivedBy(row.paymentMethod, Boolean(row.partialPayment)),
        refundStatus: row.refundStatus,
        couponCode: row.couponCode || '',
        earned: Boolean(row.earned),
    };
    for (const [key, , incomeOnly] of MONEY) {
        out[key] = incomeOnly && !out.earned ? null : num(row[key]);
    }
    return out;
}

const mapSums = (row = {}) => Object.fromEntries(MONEY.map(([key]) => [key, num(row[key])]));

/**
 * One page of orders with every money column, the column totals over the whole
 * filtered set, and the summary cards.
 */
export async function getOrderMoneyReport(query = {}) {
    const { start, end, status, base } = readFilters(query);
    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 25, 1), 500);
    const where = Prisma.sql`${base} AND ${STATUS_SQL[status]}`;

    const [rows, [totalsRow], [bucketRow]] = await Promise.all([
        prisma.$queryRaw`${ROW_SELECT} ${JOINS}
            WHERE ${where}
            ORDER BY o."createdAt" DESC, o.id DESC
            LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
        prisma.$queryRaw`SELECT COUNT(*)::int AS count, ${MONEY_SUMS} ${JOINS} WHERE ${where}`,
        prisma.$queryRaw`
            SELECT COUNT(*)::int AS "allOrders",
                   COUNT(*) FILTER (WHERE ${EARNED})::int AS "deliveredOrders",
                   COUNT(*) FILTER (WHERE ${CANCELLED})::int AS "cancelledOrders",
                   COALESCE(SUM(o."total") FILTER (WHERE ${CANCELLED}), 0) AS "cancelledAmount",
                   COUNT(*) FILTER (WHERE ${REFUNDED})::int AS "refundedOrders",
                   COALESCE(SUM(o."refundAmount") FILTER (WHERE ${REFUNDED}), 0) AS "refundedAmount",
                   COUNT(*) FILTER (WHERE ${ONGOING})::int AS "ongoingOrders",
                   COALESCE(SUM(o."total") FILTER (WHERE ${EARNED}), 0) AS "completedAmount",
                   COALESCE(SUM(${ADMIN_NET}) FILTER (WHERE ${EARNED}), 0) AS "adminNetIncome",
                   COALESCE(SUM(${STORE_NET}) FILTER (WHERE ${EARNED}), 0) AS "storeNetIncome",
                   COALESCE(SUM(${RIDER}) FILTER (WHERE ${EARNED}), 0) AS "deliverymanEarning",
                   COALESCE(SUM(${TIP}) FILTER (WHERE ${EARNED}), 0) AS "riderTip",
                   COALESCE(SUM(${COMMISSION}) FILTER (WHERE ${EARNED}), 0) AS "adminCommission",
                   COALESCE(SUM(o."tax" + o."deliveryFeeGst") FILTER (WHERE ${EARNED}), 0) AS "taxCollected",
                   COALESCE(SUM(o."discount" + o."couponDeliveryWaiver") FILTER (WHERE ${EARNED}), 0) AS "discountGiven"
              ${JOINS} WHERE ${base}`,
    ]);

    const total = Number(totalsRow?.count || 0);
    return {
        period: { from: start, to: end },
        status,
        orders: rows.map((row, i) => mapRow(row, (page - 1) * limit + i + 1)),
        totals: { orders: total, ...mapSums(totalsRow) },
        summary: {
            allOrders: Number(bucketRow?.allOrders || 0),
            deliveredOrders: Number(bucketRow?.deliveredOrders || 0),
            ongoingOrders: Number(bucketRow?.ongoingOrders || 0),
            cancelledOrders: Number(bucketRow?.cancelledOrders || 0),
            cancelledAmount: num(bucketRow?.cancelledAmount),
            refundedOrders: Number(bucketRow?.refundedOrders || 0),
            refundedAmount: num(bucketRow?.refundedAmount),
            completedAmount: num(bucketRow?.completedAmount),
            adminNetIncome: num(bucketRow?.adminNetIncome),
            storeNetIncome: num(bucketRow?.storeNetIncome),
            deliverymanEarning: num(bucketRow?.deliverymanEarning),
            riderTip: num(bucketRow?.riderTip),
            adminCommission: num(bucketRow?.adminCommission),
            taxCollected: num(bucketRow?.taxCollected),
            discountGiven: num(bucketRow?.discountGiven),
        },
        pagination: { total, page, limit, pages: Math.ceil(total / limit) || 1 },
    };
}

/** Every row of the filtered set, newest first, `size` at a time (keyset, so deep pages stay cheap). */
export async function* iterateOrderMoneyRows(query = {}, size = 1000) {
    const { status, base } = readFilters(query);
    const where = Prisma.sql`${base} AND ${STATUS_SQL[status]}`;
    let after = null;
    let index = 0;
    for (;;) {
        const keyset = after
            ? Prisma.sql`AND (o."createdAt", o.id) < (${after.createdAt}, ${after.id})`
            : Prisma.empty;
        // eslint-disable-next-line no-await-in-loop
        const rows = await prisma.$queryRaw`${ROW_SELECT} ${JOINS}
            WHERE ${where} ${keyset}
            ORDER BY o."createdAt" DESC, o.id DESC
            LIMIT ${size}`;
        if (!rows.length) return;
        yield rows.map((row) => {
            index += 1;
            return mapRow(row, index);
        });
        if (rows.length < size) return;
        const last = rows[rows.length - 1];
        after = { createdAt: last.createdAt, id: last.id };
    }
}

/** Export columns, in the old panel's order. */
export const ORDER_MONEY_COLUMNS = [
    { key: 'sl', label: 'Sl' },
    { key: 'orderId', label: 'Order id' },
    { key: 'date', label: 'Date' },
    { key: 'restaurant', label: 'Restaurant' },
    { key: 'customerName', label: 'Customer name' },
    { key: 'orderStatus', label: 'Order status' },
    { key: 'totalItemAmount', label: 'Total item amount' },
    { key: 'couponDiscount', label: 'Coupon discount' },
    { key: 'freeDeliveryDiscount', label: 'Free delivery (coupon)' },
    { key: 'discountedAmount', label: 'Discounted amount' },
    { key: 'vatTax', label: 'Vat/tax' },
    { key: 'deliveryCharge', label: 'Delivery charge' },
    { key: 'deliveryChargeGst', label: 'Delivery charge GST' },
    { key: 'additionalCharge', label: 'Additional charge (platform fee)' },
    { key: 'extraPackagingAmount', label: 'Extra packaging amount' },
    { key: 'orderAmount', label: 'Order amount' },
    { key: 'adminDiscount', label: 'Admin discount' },
    { key: 'storeDiscount', label: 'Restaurant discount' },
    { key: 'adminCommission', label: 'Admin commission' },
    { key: 'commissionOnDeliveryCharge', label: 'Commission on delivery charge' },
    { key: 'riderTip', label: 'Tip (to rider)' },
    { key: 'deliverymanEarning', label: 'Deliveryman earning (incl. tip)' },
    { key: 'adminNetIncome', label: 'Admin net income' },
    { key: 'storeNetIncome', label: 'Restaurant net income' },
    { key: 'refundAmount', label: 'Refunded amount' },
    { key: 'paymentMethodLabel', label: 'Payment method' },
    { key: 'walletPaidAmount', label: 'Paid by wallet' },
    { key: 'otherPaidAmount', label: 'Paid by other method' },
    { key: 'amountReceivedBy', label: 'Amount received by' },
];

const dayOf = (date) => new Date(date).toISOString().slice(0, 10);

export async function exportOrderMoneyReport(query, res) {
    const { start, end, status } = readFilters(query); // validates before any header is sent
    const kind = query.report === 'order' ? 'order-report' : 'transaction-report';
    async function* batches() {
        for await (const rows of iterateOrderMoneyRows(query)) {
            yield rows.map((row) => ({ ...row, date: new Date(row.date).toISOString() }));
        }
    }
    await streamSheet(res, {
        format: query.format,
        filename: `${kind}-${status}-${dayOf(start)}-to-${dayOf(end)}`,
        sheetName: kind === 'order-report' ? 'Order report' : 'Transaction report',
        columns: ORDER_MONEY_COLUMNS,
        batches: batches(),
    });
}

// ─── Restaurant-wise report ──────────────────────────────────────────────────

export const RESTAURANT_TABS = ['summary', 'sales', 'order'];

function readRestaurantFilters(query = {}) {
    const { start, end } = parsePeriod({ from: query.from || query.fromDate, to: query.to || query.toDate });
    const tab = String(query.tab || 'summary').toLowerCase();
    if (!RESTAURANT_TABS.includes(tab)) throw new ValidationError(`Unknown tab "${query.tab}"`);
    const zoneId = String(query.zoneId || query.zone || '').trim();
    const restaurantId = String(query.restaurantId || query.restaurant || '').trim();
    const search = String(query.search || '').trim();

    const parts = [Prisma.sql`TRUE`];
    if (zoneId) parts.push(isId(zoneId) ? Prisma.sql`r."zoneId" = ${zoneId}` : Prisma.sql`FALSE`);
    if (restaurantId) parts.push(isId(restaurantId) ? Prisma.sql`r.id = ${restaurantId}` : Prisma.sql`FALSE`);
    if (search) parts.push(Prisma.sql`r."restaurantName" ILIKE ${`%${search}%`}`);
    return { start, end, tab, restaurantWhere: Prisma.join(parts, ' AND ') };
}

const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 10000) / 100 : 0);

/** Orders in the period joined onto every matching restaurant (restaurants with none still listed). */
const restaurantOrdersJoin = (start, end) => Prisma.sql`
    FROM food_restaurants r
    LEFT JOIN food_orders o ON o."restaurantId" = r.id
         AND o."orderStatus" <> 'pending_payment'
         AND o."createdAt" BETWEEN ${start} AND ${end}
    LEFT JOIN food_transactions t ON t."orderId" = o.id`;

const PENDING = Prisma.sql`o."orderStatus" = 'created' AND NOT ${EARNED}`;
const PROCESSING = Prisma.sql`o."orderStatus" IN ('confirmed', 'preparing', 'ready_for_pickup') AND NOT ${EARNED}`;
const ON_THE_WAY = Prisma.sql`o."orderStatus" IN ('reached_pickup', 'picked_up', 'reached_drop') AND NOT ${EARNED}`;

const count = (cond) => Prisma.sql`COUNT(o.id) FILTER (WHERE ${cond})::int`;
const sumOf = (expr, cond = EARNED) => Prisma.sql`COALESCE(SUM(${expr}) FILTER (WHERE ${cond}), 0)`;

/** Per-restaurant aggregate columns for each tab, as [key, SQL]. */
const TAB_AGGREGATES = {
    summary: [
        ['totalOrders', Prisma.sql`COUNT(o.id)::int`],
        ['deliveredOrders', count(EARNED)],
        ['ongoingOrders', count(ONGOING)],
        ['cancelledOrders', count(CANCELLED)],
        ['refundRequests', count(Prisma.sql`o."refundStatus" <> 'none'`)],
        ['totalAmount', sumOf(Prisma.sql`o."total"`)],
    ],
    sales: [
        ['deliveredOrders', count(EARNED)],
        ['totalItemAmount', sumOf(Prisma.sql`o."subtotal"`)],
        ['extraPackagingAmount', sumOf(Prisma.sql`o."packagingFee"`)],
        ['couponDiscount', sumOf(Prisma.sql`o."discount"`)],
        ['adminDiscount', sumOf(ADMIN_DISCOUNT)],
        ['storeDiscount', sumOf(STORE_DISCOUNT)],
        ['vatTax', sumOf(Prisma.sql`o."tax"`)],
        ['orderAmount', sumOf(Prisma.sql`o."total"`)],
        ['adminCommission', sumOf(COMMISSION)],
        ['storeNetIncome', sumOf(STORE_NET)],
    ],
    order: [
        ['totalOrders', Prisma.sql`COUNT(o.id)::int`],
        ['pendingOrders', count(PENDING)],
        ['processingOrders', count(PROCESSING)],
        ['onTheWayOrders', count(ON_THE_WAY)],
        ['deliveredOrders', count(EARNED)],
        ['cancelledOrders', count(CANCELLED)],
        ['refundedOrders', count(REFUNDED)],
        ['cashOrders', count(Prisma.sql`o."paymentMethod" = 'cash'`)],
        ['onlineOrders', count(Prisma.sql`o."paymentMethod" IN ('razorpay', 'razorpay_qr')`)],
        ['walletOrders', count(Prisma.sql`o."paymentMethod" = 'wallet'`)],
        ['offlineOrders', count(Prisma.sql`o."paymentMethod" = 'offline'`)],
        ['totalAmount', Prisma.sql`COALESCE(SUM(o."total"), 0)`],
        ['deliveredAmount', sumOf(Prisma.sql`o."total"`)],
    ],
};

/** Sales lists only restaurants that delivered something; the others list every matching restaurant. */
const TAB_ORDER = {
    summary: Prisma.sql`"totalOrders" DESC, r."restaurantName" ASC`,
    sales: Prisma.sql`"storeNetIncome" DESC, r."restaurantName" ASC`,
    order: Prisma.sql`"totalOrders" DESC, r."restaurantName" ASC`,
};

const INT_KEYS = new Set(['totalOrders', 'deliveredOrders', 'ongoingOrders', 'cancelledOrders', 'refundRequests',
    'pendingOrders', 'processingOrders', 'onTheWayOrders', 'refundedOrders', 'cashOrders', 'onlineOrders',
    'walletOrders', 'offlineOrders']);

const readAggregate = (row, aggregates) => Object.fromEntries(aggregates.map(([key]) => [
    key, INT_KEYS.has(key) ? Number(row?.[key] || 0) : num(row?.[key]),
]));

/** Summary tab only: delivered + ongoing + cancelled partition the orders, so the three rates add up to 100 (to rounding). */
const withRates = (row) => (row.ongoingOrders === undefined ? row : {
    ...row,
    completionRate: pct(row.deliveredOrders, row.totalOrders),
    ongoingRate: pct(row.ongoingOrders, row.totalOrders),
    cancellationRate: pct(row.cancelledOrders, row.totalOrders),
});

async function queryRestaurantTab({ start, end, tab, restaurantWhere }, { limit, offset }) {
    const aggregates = TAB_AGGREGATES[tab];
    const select = Prisma.join(aggregates.map(([key, sql]) => Prisma.sql`${sql} AS ${Prisma.raw(`"${key}"`)}`), ', ');
    const having = tab === 'sales' ? Prisma.sql`HAVING COUNT(o.id) FILTER (WHERE ${EARNED}) > 0` : Prisma.empty;
    return prisma.$queryRaw`
        SELECT r.id AS "restaurantId", r."restaurantName" AS restaurant, r."profileImage" AS image,
               COUNT(*) OVER () AS "rowCount", ${select}
          ${restaurantOrdersJoin(start, end)}
         WHERE ${restaurantWhere}
         GROUP BY r.id, r."restaurantName", r."profileImage"
         ${having}
         ORDER BY ${TAB_ORDER[tab]}
         LIMIT ${limit} OFFSET ${offset}`;
}

export async function getRestaurantWiseReport(query = {}) {
    const filters = readRestaurantFilters(query);
    const { start, end, tab, restaurantWhere } = filters;
    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 25, 1), 500);
    const aggregates = TAB_AGGREGATES[tab];
    const totalsSelect = Prisma.join(aggregates.map(([key, sql]) => Prisma.sql`${sql} AS ${Prisma.raw(`"${key}"`)}`), ', ');

    const [rows, [totalsRow]] = await Promise.all([
        queryRestaurantTab(filters, { limit, offset: (page - 1) * limit }),
        prisma.$queryRaw`
            SELECT COUNT(DISTINCT r.id)::int AS restaurants,
                   COUNT(DISTINCT o."restaurantId") FILTER (WHERE ${EARNED})::int AS "restaurantsWithSales",
                   ${totalsSelect}
              ${restaurantOrdersJoin(start, end)}
             WHERE ${restaurantWhere}`,
    ]);

    const rowCount = Number(rows[0]?.rowCount || 0);
    return {
        period: { from: start, to: end },
        tab,
        restaurants: rows.map((row, i) => withRates({
            sl: (page - 1) * limit + i + 1,
            restaurantId: row.restaurantId,
            restaurant: row.restaurant || '',
            image: row.image || '',
            ...readAggregate(row, aggregates),
        })),
        totals: withRates({
            restaurants: Number(totalsRow?.restaurants || 0),
            restaurantsWithSales: Number(totalsRow?.restaurantsWithSales || 0),
            ...readAggregate(totalsRow, aggregates),
        }),
        pagination: { total: rowCount, page, limit, pages: Math.ceil(rowCount / limit) || 1 },
    };
}

export const RESTAURANT_TAB_COLUMNS = {
    summary: [
        { key: 'sl', label: 'Sl' },
        { key: 'restaurant', label: 'Restaurant' },
        { key: 'totalOrders', label: 'Total order' },
        { key: 'deliveredOrders', label: 'Total delivered order' },
        { key: 'totalAmount', label: 'Total amount' },
        { key: 'completionRate', label: 'Completion rate (%)' },
        { key: 'ongoingRate', label: 'Ongoing rate (%)' },
        { key: 'cancellationRate', label: 'Cancelation rate (%)' },
        { key: 'refundRequests', label: 'Refund request' },
    ],
    sales: [
        { key: 'sl', label: 'Sl' },
        { key: 'restaurant', label: 'Restaurant' },
        { key: 'deliveredOrders', label: 'Delivered orders' },
        { key: 'totalItemAmount', label: 'Total item amount' },
        { key: 'extraPackagingAmount', label: 'Packaging' },
        { key: 'couponDiscount', label: 'Coupon discount' },
        { key: 'adminDiscount', label: 'Admin discount' },
        { key: 'storeDiscount', label: 'Restaurant discount' },
        { key: 'vatTax', label: 'Vat/tax' },
        { key: 'orderAmount', label: 'Order amount' },
        { key: 'adminCommission', label: 'Admin commission' },
        { key: 'storeNetIncome', label: 'Restaurant net income' },
    ],
    order: [
        { key: 'sl', label: 'Sl' },
        { key: 'restaurant', label: 'Restaurant' },
        { key: 'totalOrders', label: 'Total orders' },
        { key: 'pendingOrders', label: 'Pending' },
        { key: 'processingOrders', label: 'Processing' },
        { key: 'onTheWayOrders', label: 'On the way' },
        { key: 'deliveredOrders', label: 'Delivered' },
        { key: 'cancelledOrders', label: 'Cancelled' },
        { key: 'refundedOrders', label: 'Refunded' },
        { key: 'cashOrders', label: 'Cash' },
        { key: 'onlineOrders', label: 'Online' },
        { key: 'walletOrders', label: 'Wallet' },
        { key: 'offlineOrders', label: 'Offline' },
        { key: 'totalAmount', label: 'Total amount (all orders)' },
        { key: 'deliveredAmount', label: 'Delivered amount' },
    ],
};

export async function exportRestaurantWiseReport(query, res) {
    const filters = readRestaurantFilters(query);
    const size = 500;
    async function* batches() {
        for (let offset = 0; ; offset += size) {
            // eslint-disable-next-line no-await-in-loop
            const rows = await queryRestaurantTab(filters, { limit: size, offset });
            if (!rows.length) return;
            yield rows.map((row, i) => withRates({
                sl: offset + i + 1,
                restaurant: row.restaurant || '',
                ...readAggregate(row, TAB_AGGREGATES[filters.tab]),
            }));
            if (rows.length < size) return;
        }
    }
    await streamSheet(res, {
        format: query.format,
        filename: `restaurant-wise-${filters.tab}-${dayOf(filters.start)}-to-${dayOf(filters.end)}`,
        sheetName: `${filters.tab} report`,
        columns: RESTAURANT_TAB_COLUMNS[filters.tab],
        batches: batches(),
    });
}
