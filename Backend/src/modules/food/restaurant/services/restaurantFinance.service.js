import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { FEATURE_KEYS, isFeatureEnabled } from '../../admin/services/featureSettings.service.js';
import { getOutstandingSummary } from './subscriptionBilling.service.js';
import {
    isRestaurantEarnedOrder,
    computeRestaurantOrderShare,
    orderMoney,
} from '../../shared/restaurantPayout.util.js';
import { resolveDiscountSplit } from '../../shared/discountSplit.util.js';

/**
 * What a restaurant is owed, and what it has already taken.
 *
 * Balance = lifetime payout on earned orders, minus withdrawals it has asked
 * for, minus subscription dues already deducted. Open subscription invoices are
 * *locked* rather than deducted: the balance still shows, but only the
 * unlocked part can be withdrawn.
 */

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

function paginateCompletedOrders(rawOrders, mapFinanceOrder, pagination) {
    const completedOrders = rawOrders.filter(isRestaurantEarnedOrder).map(mapFinanceOrder);
    const total = completedOrders.length;
    const totalPages = Math.max(1, Math.ceil(total / pagination.limit) || 1);
    const page = Math.min(pagination.page, totalPages);
    const skip = (page - 1) * pagination.limit;

    return {
        orders: completedOrders.slice(skip, skip + pagination.limit),
        totalOrders: total,
        pagination: {
            page,
            limit: pagination.limit,
            total,
            totalPages,
            pages: totalPages,
        },
    };
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

const loadFinanceOrders = (where) => prisma.foodOrder.findMany({
    where,
    select: FINANCE_ORDER_SELECT,
    orderBy: { createdAt: 'desc' },
});

export async function getRestaurantFinance(restaurantId, query = {}) {
    if (!isId(restaurantId)) return null;
    const rid = String(restaurantId);

    const isRestaurantSubscriptionEnabled = await isFeatureEnabled(
        FEATURE_KEYS.RESTAURANT_SUBSCRIPTION,
        true,
    );

    const [restaurant, allOrders, relevantOffers] = await Promise.all([
        prisma.foodRestaurant.findUnique({
            where: { id: rid },
            select: {
                id: true, restaurantName: true, addressLine1: true, addressLine2: true,
                area: true, city: true, state: true, pincode: true, formattedAddress: true,
            },
        }),
        loadFinanceOrders({ restaurantId: rid, orderStatus: { not: 'pending_payment' } }),
        prisma.foodOffer.findMany({
            where: {
                OR: [
                    { restaurantScope: { not: 'selected' } },
                    { restaurantId: rid },
                    { restaurantIds: { has: rid } },
                ],
            },
        }),
    ]);

    const address =
        restaurant?.formattedAddress ||
        [restaurant?.addressLine1, restaurant?.addressLine2, restaurant?.area]
            .filter(Boolean)
            .join(', ');

    // One lookup for every order on the page; the transaction is the
    // authoritative money snapshot where one exists.
    const transactions = allOrders.length
        ? await prisma.foodTransaction.findMany({
            where: { orderId: { in: allOrders.map((o) => o.id) } },
        })
        : [];
    const txByOrderId = new Map(transactions.map((tx) => [tx.orderId, tx]));

    const mapFinanceOrder = (order) => {
        const tx = txByOrderId.get(order.id) || null;
        const money = orderMoney(order, tx);
        const items = order.items || [];

        const discount = Number(money.discount) || 0;
        const split = resolveDiscountSplit({ money, offers: relevantOffers, restaurantId: rid });
        const payout = isRestaurantEarnedOrder(order)
            ? computeRestaurantOrderShare(money, relevantOffers, rid)
            : 0;

        const total = Number(money.total) || 0;
        const tax = Number(money.tax) || 0;

        return {
            orderId: order.orderId || order.order_id || `FOD-${order.id.slice(-6).toUpperCase()}`,
            createdAt: order.createdAt,
            items,
            foodNames: items.map((it) => it?.name).filter(Boolean).join(', '),
            orderTotal: Math.max(0, total - tax),
            totalAmount: total,
            payout: Math.max(0, payout),
            commission: Number(money.restaurantCommission) || 0,
            discount,
            adminDiscountShare: split.adminDiscountShare,
            restaurantDiscountShare: split.restaurantDiscountShare,
            discountAdminBearPercentage: split.adminBearPercentage,
            discountRestaurantBearPercentage: split.restaurantBearPercentage,
            paymentMethod: tx?.paymentMethod || order.paymentMethod || 'cash',
            orderStatus: order.orderStatus,
            status: tx?.status || (order.paymentStatus === 'paid' ? 'captured' : 'pending'),
        };
    };

    const ordersPagination = parseOrdersPagination(query);
    const completedOrdersPage = paginateCompletedOrders(allOrders, mapFinanceOrder, ordersPagination);
    const allCompletedOrders = allOrders.filter(isRestaurantEarnedOrder).map(mapFinanceOrder);

    const totalEarnings = allCompletedOrders.reduce((sum, o) => sum + (Number(o.payout) || 0), 0);

    // Lifetime withdrawals and subscription wallet-deductions reduce the visible balance.
    const [committedWithdrawals, walletDeductions, outstandingSummary] = await Promise.all([
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

    const totalCommittedWithdrawals = Number(committedWithdrawals._sum.amount) || 0;
    const totalWalletDeductions = Number(walletDeductions._sum.amount) || 0;

    // Locked balance = total outstanding subscription dues (calendar-month postpaid invoices).
    // The full balance stays visible; only withdrawal is limited to balance − locked.
    const lockedAmount = Math.max(0, Number(outstandingSummary.lockedAmount) || 0);
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
        totalOrders: allCompletedOrders.length,
        payoutDate: null,
        orders: completedOrdersPage.orders,
        pagination: completedOrdersPage.pagination,
    };

    const invoiceSummary = {
        count: allCompletedOrders.length,
        subtotal: allCompletedOrders.reduce((sum, o) => sum + (Number(o.orderTotal) || 0), 0),
        taxes: allCompletedOrders.reduce(
            (sum, o) => sum + Math.max(0, (Number(o.totalAmount) || 0) - (Number(o.orderTotal) || 0)),
            0,
        ),
        gross: allCompletedOrders.reduce((sum, o) => sum + (Number(o.totalAmount) || 0), 0),
    };

    const startDate = parseISODateParam(query.startDate);
    const endDate = parseISODateParamEnd(query.endDate);

    let pastCyclesResult = {
        orders: [],
        totalOrders: 0,
        pagination: { page: 1, limit: ordersPagination.limit, total: 0, totalPages: 1, pages: 1 },
    };
    if (startDate && endDate) {
        const pastOrders = await loadFinanceOrders({
            restaurantId: rid,
            orderStatus: { not: 'pending_payment' },
            createdAt: { gte: startDate, lte: endDate },
        });

        pastCyclesResult = paginateCompletedOrders(pastOrders, mapFinanceOrder, ordersPagination);
    }

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
