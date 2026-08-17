import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { CANCELLED_ORDER_STATUSES } from '../../orders/services/order.helpers.js';
import { isRestaurantEarnedOrder, orderMoney } from '../../shared/restaurantPayout.util.js';
import { resolveDiscountSplit } from '../../shared/discountSplit.util.js';
import {
    formatBillingMonth,
    getMonthWindow,
    billingMonthLabel,
    computeMonthlyGmv,
} from '../../restaurant/services/subscriptionBilling.service.js';

/**
 * One restaurant's full picture for the admin panel: order counts, money, and
 * where its subscription billing stands.
 *
 * Money comes from the transaction ledger where there is one — that is what
 * settlement pays against — and falls back to the order's own columns, so a
 * delivered order is never dropped just because its transaction row is missing.
 */

const IN_PROGRESS_STATUSES = [
    'created', 'confirmed', 'preparing', 'ready_for_pickup',
    'reached_pickup', 'picked_up', 'reached_drop',
];

const num = (value) => Number(value) || 0;
const sum = (rows, pick) => rows.reduce((total, row) => total + num(pick(row)), 0);

function formatSubscriptionPlanLabel(plan) {
    const key = String(plan || '').trim().toLowerCase();
    if (!key) return 'Not assigned';
    return key.charAt(0).toUpperCase() + key.slice(1);
}

/**
 * Invoice-based subscription summary for the admin POS analytics view
 * (calendar-month postpaid billing).
 */
async function buildRestaurantSubscriptionSummary(restaurantId) {
    const currentMonth = formatBillingMonth(new Date());
    const { start: monthStart } = getMonthWindow(currentMonth);

    const [totals, latestInvoice, lastPaymentTx, currentGmv, invoices, walletDeductions] =
        await Promise.all([
            prisma.foodSubscriptionInvoice.aggregate({
                where: { restaurantId },
                _sum: {
                    totalAmount: true, paidAmount: true,
                    waivedAmount: true, outstandingAmount: true,
                },
                _count: { _all: true },
            }),
            // 'legacy' is a carry-forward balance, not a month, so it must not
            // be mistaken for the most recent billing month.
            prisma.foodSubscriptionInvoice.findFirst({
                where: { restaurantId, billingMonth: { not: 'legacy' } },
                orderBy: { billingMonth: 'desc' },
            }),
            prisma.foodSubscriptionTransaction.findFirst({
                where: { restaurantId, type: { in: ['wallet_deduction', 'manual_payment'] } },
                orderBy: { createdAt: 'desc' },
            }),
            computeMonthlyGmv(restaurantId, monthStart, new Date()),
            prisma.foodSubscriptionInvoice.findMany({
                where: { restaurantId },
                orderBy: { billingMonth: 'desc' },
                take: 12,
            }),
            prisma.foodSubscriptionTransaction.aggregate({
                where: { restaurantId, type: 'wallet_deduction' },
                _sum: { amount: true },
            }),
        ]);

    const dueAmount = Math.max(0, num(totals._sum.outstandingAmount));
    const planKey = String(latestInvoice?.planName || '').trim().toLowerCase();
    const paidAmount = Math.max(0, num(totals._sum.paidAmount));

    return {
        billingModel: 'calendar_month_postpaid',
        currentBillingMonth: currentMonth,
        currentMonthGmv: num(currentGmv?.gmv),
        plan: planKey,
        planLabel: latestInvoice ? formatSubscriptionPlanLabel(planKey) : 'Not billed yet',
        cycleFee: Math.max(0, num(latestInvoice?.totalAmount)),
        lastBilledMonth: latestInvoice?.billingMonth || null,
        status: dueAmount > 0 ? 'due' : 'paid',
        statusLabel: dueAmount > 0 ? 'Outstanding dues pending' : 'No outstanding dues',
        dueAmount,
        paidAmount,
        totalBilled: Math.max(0, num(totals._sum.totalAmount)),
        totalWaived: Math.max(0, num(totals._sum.waivedAmount)),
        totalCollected: paidAmount,
        walletDeductionsTotal: Math.max(0, num(walletDeductions._sum.amount)),
        invoiceCount: totals._count._all,
        invoices: invoices.map((inv) => ({
            billingMonth: inv.billingMonth,
            billingMonthLabel: billingMonthLabel(inv.billingMonth),
            gmv: num(inv.gmv),
            planName: inv.planName,
            totalAmount: num(inv.totalAmount),
            paidAmount: num(inv.paidAmount),
            waivedAmount: num(inv.waivedAmount),
            outstandingAmount: num(inv.outstandingAmount),
            status: inv.status,
        })),
        lastPayment: lastPaymentTx
            ? {
                amount: Math.max(0, num(lastPaymentTx.amount)),
                eventType: lastPaymentTx.type,
                paymentType: lastPaymentTx.type === 'wallet_deduction' ? 'wallet' : 'manual',
                date: lastPaymentTx.createdAt || null,
                note: String(lastPaymentTx.remarks || '').trim(),
            }
            : null,
    };
}

export async function getRestaurantAnalytics(restaurantId) {
    if (!isId(restaurantId)) return null;
    const rid = String(restaurantId);

    const [restaurant, commission, orders, transactions, statusCounts, relevantOffers] =
        await Promise.all([
            prisma.foodRestaurant.findUnique({ where: { id: rid } }),
            prisma.foodRestaurantCommission.findFirst({ where: { restaurantId: rid, status: true } }),
            prisma.foodOrder.findMany({ where: { restaurantId: rid } }),
            prisma.foodTransaction.findMany({
                where: { restaurantId: rid },
                orderBy: { createdAt: 'desc' },
            }),
            // Replaces a $group with nine conditional counters: the counts are
            // per status, so one grouped query gives all of them.
            prisma.foodOrder.groupBy({
                by: ['orderStatus'],
                where: { restaurantId: rid },
                _count: { _all: true },
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
        ]);

    if (!restaurant) return null;

    const countFor = (statuses) => statusCounts
        .filter((row) => statuses.includes(row.orderStatus))
        .reduce((total, row) => total + row._count._all, 0);

    const totalOrders = statusCounts.reduce((total, row) => total + row._count._all, 0);
    const completedOrdersCount = countFor(['delivered']);
    const explicitlyCancelledOrders = countFor(CANCELLED_ORDER_STATUSES);
    const inProgressOrders = countFor(IN_PROGRESS_STATUSES);

    const txByOrderId = new Map(transactions.map((tx) => [tx.orderId, tx]));

    // One money view per completed order, preferring the ledger.
    const completedOrders = orders.filter(isRestaurantEarnedOrder);
    const completed = completedOrders.map((order) => ({
        createdAt: order.createdAt,
        money: orderMoney(order, txByOrderId.get(order.id)),
        order,
    }));

    const restaurantShareOf = ({ money }) => {
        const stored = Number(money.restaurantShare);
        if (Number.isFinite(stored)) return stored;
        // Reconstructed for orders written before the split was recorded.
        return Math.max(
            0,
            num(money.subtotal) + num(money.packagingFee) - num(money.restaurantCommission),
        );
    };

    const splitOf = ({ money }) => resolveDiscountSplit({
        money, offers: relevantOffers, restaurantId: rid,
    });

    const totalRevenue = sum(completed, ({ money }) => num(money.totalCustomerPaid) || num(money.total));
    const restaurantEarning = sum(completed, restaurantShareOf);
    const totalCommission = sum(completed, ({ money }) => money.restaurantCommission);

    const now = new Date();
    const inThisYear = (d) => new Date(d).getFullYear() === now.getFullYear();
    const inThisMonth = (d) => inThisYear(d) && new Date(d).getMonth() === now.getMonth();

    const monthlyProfit = sum(completed.filter((r) => inThisMonth(r.createdAt)), restaurantShareOf);
    const yearlyProfit = sum(completed.filter((r) => inThisYear(r.createdAt)), restaurantShareOf);

    const customerOrderCounts = new Map();
    for (const order of orders) {
        customerOrderCounts.set(order.userId, (customerOrderCounts.get(order.userId) || 0) + 1);
    }

    // A percentage rule is the rate itself; a flat fee has to be expressed as
    // one, which only means anything against what was actually sold.
    const completedSubtotal = sum(completed, ({ money }) => money.subtotal);
    const commissionPercentage = commission?.commissionType === 'percentage'
        ? num(commission.commissionValue)
        : (completedSubtotal > 0 ? (totalCommission / completedSubtotal) * 100 : 0);

    const rate = (part) => (totalOrders > 0 ? (part / totalOrders) * 100 : 0);

    const analytics = {
        totalOrders,
        cancelledOrders: explicitlyCancelledOrders,
        explicitlyCancelledOrders,
        inProgressOrders,
        notDeliveredOrders: totalOrders - completedOrdersCount,
        completedOrders: completedOrdersCount,
        cancelledByRestaurant: countFor(['cancelled_by_restaurant']),
        cancelledByAdmin: countFor(['cancelled_by_admin']),
        cancelledByUser: countFor(['cancelled_by_user']),
        averageRating: num(restaurant.rating),
        totalRatings: num(restaurant.totalRatings),
        commissionPercentage,
        monthlyProfit,
        yearlyProfit,
        averageOrderValue: completed.length > 0 ? totalRevenue / completed.length : 0,
        totalRevenue,
        totalCommission,
        restaurantEarning, // restaurant share
        restaurantProfit: restaurantEarning,
        monthlyOrders: orders.filter((o) => inThisMonth(o.createdAt)).length,
        yearlyOrders: orders.filter((o) => inThisYear(o.createdAt)).length,
        averageMonthlyProfit: monthlyProfit, // Placeholder: can be improved if historical data exists
        averageYearlyProfit: yearlyProfit,   // Placeholder: can be improved if historical data exists
        status: restaurant.status === 'approved' ? 'active' : 'inactive',
        joinDate: restaurant.createdAt,
        totalCustomers: customerOrderCounts.size,
        repeatCustomers: [...customerOrderCounts.values()].filter((count) => count > 1).length,
        cancellationRate: rate(explicitlyCancelledOrders),
        completionRate: rate(completedOrdersCount),
        inProgressRate: rate(inProgressOrders),
    };

    const paymentSummary = {
        // Pricing (what customer paid components)
        subtotal: sum(completed, ({ money }) => money.subtotal),
        tax: sum(completed, ({ money }) => money.tax ?? money.taxAmount),
        packagingFee: sum(completed, ({ money }) => money.packagingFee),
        deliveryFee: sum(completed, ({ money }) => money.deliveryFee),
        platformFee: sum(completed, ({ money }) => money.platformFee),
        discount: sum(completed, ({ money }) => money.discount),
        adminDiscountShare: sum(completed, (row) => splitOf(row).adminDiscountShare),
        restaurantDiscountShare: sum(completed, (row) => splitOf(row).restaurantDiscountShare),
        total: totalRevenue,
        currency: 'INR',

        // Split (who got what)
        restaurantShare: restaurantEarning,
        restaurantCommission: totalCommission,
        riderShare: sum(completed, ({ money, order }) => money.riderShare ?? order.riderEarning),
        platformNetProfit: sum(completed, ({ money, order }) => money.platformNetProfit ?? order.platformProfit),
    };

    return {
        restaurant,
        analytics,
        paymentSummary,
        subscriptionSummary: await buildRestaurantSubscriptionSummary(rid),
    };
}
