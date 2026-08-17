import { Prisma } from '@prisma/client';
import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { FEATURE_KEYS, isFeatureEnabled } from '../../admin/services/featureSettings.service.js';
import { getOutstandingSummary } from './subscriptionBilling.service.js';
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
const earnedWindowSql = (restaurantId, from, to) => Prisma.sql`
    WHERE o."restaurantId" = ${restaurantId}
      AND o."orderStatus" <> 'pending_payment'
      AND ${EARNED_ORDER}
      ${from ? Prisma.sql`AND o."createdAt" >= ${from}` : Prisma.empty}
      ${to ? Prisma.sql`AND o."createdAt" <= ${to}` : Prisma.empty}
`;

/**
 * The money totals for a restaurant's earned orders, summed in the database.
 *
 * `overCount` corrects the one case SQL cannot settle — see
 * restaurantPayout.sql.js — and is normally zero.
 */
async function earnedTotals(restaurantId, { from = null, to = null } = {}) {
    const scope = earnedWindowSql(restaurantId, from, to);

    const [[row], overCount] = await Promise.all([
        prisma.$queryRaw`
            SELECT COUNT(*)::int                                   AS "orderCount",
                   COALESCE(SUM(${RESTAURANT_SHARE}), 0)           AS "payout",
                   COALESCE(SUM(COALESCE(t."total", o."total")), 0) AS "gross",
                   COALESCE(SUM(COALESCE(t."tax",   o."tax")),   0) AS "tax"
            ${ORDERS_JOINED}
            ${scope}
        `,
        shareOverCountByRestaurant(
            {
                restaurantId,
                orderStatus: { not: 'pending_payment' },
                ...(from || to
                    ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }
                    : {}),
            },
            new Map(),
        ),
    ]);

    const gross = num(row?.gross);
    const tax = num(row?.tax);

    return {
        orderCount: row?.orderCount || 0,
        payout: Math.max(0, num(row?.payout) - num(overCount.get(restaurantId))),
        gross,
        tax,
        // What the restaurant invoices on: gross less the tax collected on it.
        net: Math.max(0, gross - tax),
    };
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

    const [restaurant, relevantOffers, lifetime] = await Promise.all([
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
        earnedTotals(rid),
    ]);

    const address =
        restaurant?.formattedAddress ||
        [restaurant?.addressLine1, restaurant?.addressLine2, restaurant?.area]
            .filter(Boolean)
            .join(', ');

    const [currentPage, committedWithdrawals, walletDeductions, outstandingSummary] =
        await Promise.all([
            earnedOrdersPage(rid, {}, ordersPagination, relevantOffers),
            // A pending request is money already spoken for, so it is subtracted
            // before it is approved — otherwise it could be withdrawn twice.
            prisma.foodRestaurantWithdrawal.aggregate({
                where: { restaurantId: rid, status: { in: ['pending', 'approved'] } },
                _sum: { amount: true },
            }),
            prisma.foodSubscriptionTransaction.aggregate({
                where: { restaurantId: rid, type: 'wallet_deduction' },
                _sum: { amount: true },
            }),
            isRestaurantSubscriptionEnabled
                ? getOutstandingSummary(rid)
                : Promise.resolve({ lockedAmount: 0, openInvoices: [], monthsLabel: '' }),
        ]);

    const totalEarnings = lifetime.payout;
    const totalCommittedWithdrawals = num(committedWithdrawals._sum.amount);
    const totalWalletDeductions = num(walletDeductions._sum.amount);

    // Locked balance = total outstanding subscription dues (calendar-month postpaid invoices).
    // The full balance stays visible; only withdrawal is limited to balance − locked.
    const lockedAmount = Math.max(0, num(outstandingSummary.lockedAmount));
    const availableBalance = Math.max(
        0,
        totalEarnings - totalCommittedWithdrawals - totalWalletDeductions,
    );

    const wallet = {
        totalEarnings,
        totalWithdrawn: totalCommittedWithdrawals,
        estimatedPayout: totalEarnings,
        withdrawableBalance: availableBalance,
        netAvailable: Math.max(0, availableBalance - lockedAmount), // what can ACTUALLY be withdrawn
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
            subscriptionDueAmount: lockedAmount,
            subscriptionStatus: lockedAmount > 0 ? 'due' : 'paid',
        },
        subscription: {
            lockedAmount,
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
