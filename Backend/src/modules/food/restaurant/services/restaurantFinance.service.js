import { Prisma } from '@prisma/client';
import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { FEATURE_KEYS, isFeatureEnabled } from '../../admin/services/featureSettings.service.js';
import { getOutstandingSummary, OPEN_INVOICE_STATUSES } from './subscriptionBilling.service.js';
import {
    isRestaurantEarnedOrder,
    computeRestaurantOrderShare,
    orderMoney,
} from '../../shared/restaurantPayout.util.js';
import {
    EARNED_ORDER,
    RESTAURANT_SHARE,
    ORDERS_JOINED,
    shareOverCountByRestaurant,
} from '../../shared/restaurantPayout.sql.js';
import { resolveDiscountSplit } from '../../shared/discountSplit.util.js';

/**
 * What a restaurant is owed, and what it has already taken.
 *
 * Balance = lifetime payout on earned orders, minus withdrawals it has asked
 * for, minus subscription dues already deducted. Open subscription invoices are
 * *locked* rather than deducted: the balance still shows, but only the
 * unlocked part can be withdrawn.
 *
 * The totals are summed by the database. This used to read every order the
 * restaurant had ever taken into Node — twice, once for the lifetime figures
 * and again for the date-filtered view — which is bounded by the restaurant's
 * age rather than by anything the caller asked for.
 */

const num = (value) => Number(value) || 0;

function parseISODateParam(v) {
    if (!v) return null;
    const s = String(v).trim();
    if (!s) return null;
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return null;
    d.setHours(0, 0, 0, 0);
    return d;
}

function parseISODateParamEnd(v) {
    if (!v) return null;
    const s = String(v).trim();
    if (!s) return null;
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return null;
    d.setHours(23, 59, 59, 999);
    return d;
}

function parseOrdersPagination(query = {}) {
    const page = Math.max(1, parseInt(query.ordersPage, 10) || parseInt(query.page, 10) || 1);
    const limit = Math.min(
        Math.max(parseInt(query.ordersLimit, 10) || parseInt(query.limit, 10) || 10, 1),
        50,
    );
    return { page, limit };
}

/** Everything a finance row needs from an order, plus its items for the name list. */
const FINANCE_ORDER_SELECT = {
    id: true, orderId: true, order_id: true,
    orderStatus: true, deliveryPhase: true,
    paymentMethod: true, paymentStatus: true,
    subtotal: true, tax: true, packagingFee: true, restaurantCommission: true,
    discount: true, couponCode: true, total: true,
    createdAt: true,
    items: { select: { name: true, quantity: true, price: true } },
};

/** Only orders that were actually paid for, in the window the caller asked for. */
const earnedWindowSql = (restaurantIds, from, to) => Prisma.sql`
    WHERE o."restaurantId" IN (${Prisma.join(restaurantIds)})
      AND o."orderStatus" <> 'pending_payment'
      AND ${EARNED_ORDER}
      ${from ? Prisma.sql`AND o."createdAt" >= ${from}` : Prisma.empty}
      ${to ? Prisma.sql`AND o."createdAt" <= ${to}` : Prisma.empty}
`;

const ZERO_TOTALS = { orderCount: 0, payout: 0, gross: 0, tax: 0, net: 0 };

/**
 * The money totals for earned orders, per restaurant, summed in the database.
 *
 * Batched because the admin invoice table needs a page of restaurants at once;
 * asking per restaurant made that screen issue a full finance computation per
 * row. `overCount` corrects the one case SQL cannot settle — see
 * restaurantPayout.sql.js — and is normally zero.
 */
async function earnedTotalsByRestaurant(restaurantIds, { from = null, to = null, db = prisma } = {}) {
    const ids = [...new Set(restaurantIds.filter(Boolean))];
    if (!ids.length) return new Map();

    const [rows, overCount] = await Promise.all([
        db.$queryRaw`
            SELECT o."restaurantId"                                AS "restaurantId",
                   COUNT(*)::int                                   AS "orderCount",
                   COALESCE(SUM(${RESTAURANT_SHARE}), 0)           AS "payout",
                   COALESCE(SUM(COALESCE(t."total", o."total")), 0) AS "gross",
                   COALESCE(SUM(COALESCE(t."tax",   o."tax")),   0) AS "tax"
            ${ORDERS_JOINED}
            ${earnedWindowSql(ids, from, to)}
            GROUP BY o."restaurantId"
        `,
        shareOverCountByRestaurant(
            {
                restaurantId: { in: ids },
                orderStatus: { not: 'pending_payment' },
                ...(from || to
                    ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }
                    : {}),
            },
            new Map(),
        ),
    ]);

    return new Map(rows.map((row) => {
        const gross = num(row.gross);
        const tax = num(row.tax);
        return [row.restaurantId, {
            orderCount: row.orderCount || 0,
            payout: Math.max(0, num(row.payout) - num(overCount.get(row.restaurantId))),
            gross,
            tax,
            // What the restaurant invoices on: gross less the tax collected on it.
            net: Math.max(0, gross - tax),
        }];
    }));
}

/** Sum one Decimal column per restaurant, as a Map. */
async function sumByRestaurant(delegate, where, column) {
    const rows = await delegate.groupBy({
        by: ['restaurantId'],
        where,
        _sum: { [column]: true },
    });
    return new Map(rows.map((row) => [row.restaurantId, num(row._sum[column])]));
}

/**
 * The wallet figures for a page of restaurants: what they have earned, what
 * they have taken, and how much of the rest is locked against unpaid dues.
 *
 * Five grouped queries for the whole page, whatever its size. `db` exists so a
 * test can pass a counting client and prove that — see
 * adminSubscriptionBilling.test.js. The admin invoice
 * table used to call getRestaurantFinance() once per row — each of which read
 * that restaurant's order history and, latterly, a page of orders it had no use
 * for. This is the same arithmetic as getRestaurantFinance below, which now
 * shares it, so the two cannot disagree about what a restaurant is owed.
 */
export async function getWalletSummaries(restaurantIds = [], { db = prisma } = {}) {
    const ids = [...new Set((restaurantIds || []).map((id) => String(id || '').trim()).filter(Boolean))];
    if (!ids.length) return new Map();

    const subscriptionEnabled = await isFeatureEnabled(FEATURE_KEYS.RESTAURANT_SUBSCRIPTION, true);
    const scoped = { restaurantId: { in: ids } };

    const [earned, withdrawn, deducted, locked] = await Promise.all([
        earnedTotalsByRestaurant(ids, { db }),
        // A pending request is money already spoken for, so it is subtracted
        // before it is approved — otherwise it could be withdrawn twice.
        sumByRestaurant(
            db.foodRestaurantWithdrawal,
            { ...scoped, status: { in: ['pending', 'approved'] } },
            'amount',
        ),
        sumByRestaurant(
            db.foodSubscriptionTransaction,
            { ...scoped, type: 'wallet_deduction' },
            'amount',
        ),
        subscriptionEnabled
            ? sumByRestaurant(
                db.foodSubscriptionInvoice,
                { ...scoped, status: { in: OPEN_INVOICE_STATUSES }, outstandingAmount: { gt: 0 } },
                'outstandingAmount',
            )
            : new Map(),
    ]);

    return new Map(ids.map((id) => {
        const totals = earned.get(id) || ZERO_TOTALS;
        const totalWithdrawn = num(withdrawn.get(id));
        const lockedAmount = Math.max(0, num(locked.get(id)));

        // The full balance stays visible; only withdrawal is limited by the lock.
        const walletBalance = Math.max(0, totals.payout - totalWithdrawn - num(deducted.get(id)));

        return [id, {
            totals,
            totalEarnings: totals.payout,
            totalWithdrawn,
            walletBalance,
            netAvailable: Math.max(0, walletBalance - lockedAmount),
            lockedAmount,
        }];
    }));
}

/** One page of earned orders, mapped for the finance table. */
async function earnedOrdersPage(restaurantId, { from = null, to = null }, pagination, relevantOffers) {
    const where = {
        restaurantId,
        orderStatus: { not: 'pending_payment' },
        // The SQL twin of isRestaurantEarnedOrder, expressed for Prisma so the
        // page and the totals cover exactly the same rows.
        NOT: { orderStatus: { in: ['cancelled_by_user', 'cancelled_by_restaurant', 'cancelled_by_admin'] } },
        OR: [{ orderStatus: 'delivered' }, { deliveryPhase: { in: ['delivered', 'completed'] } }],
    };
    if (from || to) {
        where.createdAt = { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };
    }

    const [orders, total] = await Promise.all([
        prisma.foodOrder.findMany({
            where,
            select: FINANCE_ORDER_SELECT,
            orderBy: { createdAt: 'desc' },
            skip: (pagination.page - 1) * pagination.limit,
            take: pagination.limit,
        }),
        prisma.foodOrder.count({ where }),
    ]);

    // One lookup for the page, not for the history.
    const transactions = orders.length
        ? await prisma.foodTransaction.findMany({ where: { orderId: { in: orders.map((o) => o.id) } } })
        : [];
    const txByOrderId = new Map(transactions.map((tx) => [tx.orderId, tx]));

    const rows = orders.map((order) => {
        const tx = txByOrderId.get(order.id) || null;
        const money = orderMoney(order, tx);
        const items = order.items || [];

        const split = resolveDiscountSplit({ money, offers: relevantOffers, restaurantId });
        const payout = isRestaurantEarnedOrder(order)
            ? computeRestaurantOrderShare(money, relevantOffers, restaurantId)
            : 0;

        const total = num(money.total);
        const tax = num(money.tax);

        return {
            orderId: order.orderId || order.order_id || `FOD-${order.id.slice(-6).toUpperCase()}`,
            createdAt: order.createdAt,
            items,
            foodNames: items.map((it) => it?.name).filter(Boolean).join(', '),
            orderTotal: Math.max(0, total - tax),
            totalAmount: total,
            payout: Math.max(0, payout),
            commission: num(money.restaurantCommission),
            discount: num(money.discount),
            adminDiscountShare: split.adminDiscountShare,
            restaurantDiscountShare: split.restaurantDiscountShare,
            discountAdminBearPercentage: split.adminBearPercentage,
            discountRestaurantBearPercentage: split.restaurantBearPercentage,
            paymentMethod: tx?.paymentMethod || order.paymentMethod || 'cash',
            orderStatus: order.orderStatus,
            status: tx?.status || (order.paymentStatus === 'paid' ? 'captured' : 'pending'),
        };
    });

    const totalPages = Math.max(1, Math.ceil(total / pagination.limit) || 1);
    return {
        orders: rows,
        totalOrders: total,
        pagination: {
            page: Math.min(pagination.page, totalPages),
            limit: pagination.limit,
            total,
            totalPages,
            pages: totalPages,
        },
    };
}

export async function getRestaurantFinance(restaurantId, query = {}) {
    if (!isId(restaurantId)) return null;
    const rid = String(restaurantId);

    const isRestaurantSubscriptionEnabled = await isFeatureEnabled(
        FEATURE_KEYS.RESTAURANT_SUBSCRIPTION,
        true,
    );

    const ordersPagination = parseOrdersPagination(query);

    // The same helper the admin invoice table uses, so a restaurant and an
    // admin looking at the same account cannot be shown different balances.
    const [restaurant, relevantOffers, summaries] = await Promise.all([
        prisma.foodRestaurant.findUnique({
            where: { id: rid },
            select: {
                id: true, restaurantName: true, addressLine1: true, addressLine2: true,
                area: true, city: true, state: true, pincode: true, formattedAddress: true,
            },
        }),
        prisma.foodOffer.findMany({
            where: {
                OR: [
                    { restaurantScope: { not: 'selected' } },
                    { restaurantId: rid },
                    { restaurantIds: { has: rid } },
                ],
            },
        }),
        getWalletSummaries([rid]),
    ]);

    const summary = summaries.get(rid);
    const lifetime = summary.totals;

    const address =
        restaurant?.formattedAddress ||
        [restaurant?.addressLine1, restaurant?.addressLine2, restaurant?.area]
            .filter(Boolean)
            .join(', ');

    // The open invoices and their month labels are only needed for this one
    // restaurant; the summary above already has the amount they lock.
    const [currentPage, outstandingSummary] = await Promise.all([
        earnedOrdersPage(rid, {}, ordersPagination, relevantOffers),
        isRestaurantSubscriptionEnabled
            ? getOutstandingSummary(rid)
            : Promise.resolve({ lockedAmount: 0, openInvoices: [], monthsLabel: '' }),
    ]);

    const wallet = {
        totalEarnings: summary.totalEarnings,
        totalWithdrawn: summary.totalWithdrawn,
        estimatedPayout: summary.totalEarnings,
        withdrawableBalance: summary.walletBalance,
        netAvailable: summary.netAvailable, // what can ACTUALLY be withdrawn
        totalOrders: lifetime.orderCount,
        payoutDate: null,
        orders: currentPage.orders,
        pagination: currentPage.pagination,
    };

    const invoiceSummary = {
        count: lifetime.orderCount,
        subtotal: lifetime.net,
        taxes: lifetime.tax,
        gross: lifetime.gross,
    };

    const startDate = parseISODateParam(query.startDate);
    const endDate = parseISODateParamEnd(query.endDate);

    const pastCyclesResult = startDate && endDate
        ? await earnedOrdersPage(rid, { from: startDate, to: endDate }, ordersPagination, relevantOffers)
        : {
            orders: [],
            totalOrders: 0,
            pagination: { page: 1, limit: ordersPagination.limit, total: 0, totalPages: 1, pages: 1 },
        };

    return {
        restaurant: {
            name: restaurant?.restaurantName || '',
            restaurantId: restaurant?.id ? `REST${restaurant.id.slice(-6).padStart(6, '0')}` : 'N/A',
            address,
            // Kept for backwards compatibility with existing clients: due = locked amount.
            subscriptionDueAmount: summary.lockedAmount,
            subscriptionStatus: summary.lockedAmount > 0 ? 'due' : 'paid',
        },
        subscription: {
            lockedAmount: summary.lockedAmount,
            lockedMonths: outstandingSummary.monthsLabel,
            openInvoices: outstandingSummary.openInvoices,
        },
        features: {
            restaurantSubscriptionEnabled: isRestaurantSubscriptionEnabled,
        },
        wallet,
        // Backward compatibility for existing clients
        currentCycle: wallet,
        invoiceSummary,
        pastCycles: pastCyclesResult,
    };
}
