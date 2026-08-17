import { Prisma } from '@prisma/client';
import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { CANCELLED_ORDER_STATUSES } from '../../orders/services/order.helpers.js';
import {
    EARNED_ORDER,
    RESTAURANT_SHARE,
    ORDERS_JOINED,
    shareOverCountByRestaurant,
} from '../../shared/restaurantPayout.sql.js';
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
 *
 * All of it is summed by the database. This used to load the restaurant's
 * entire order history and its entire transaction history into Node and reduce
 * them there, so the cost of opening the page grew with the restaurant's age.
 */

const IN_PROGRESS_STATUSES = [
    'created', 'confirmed', 'preparing', 'ready_for_pickup',
    'reached_pickup', 'picked_up', 'reached_drop',
];

const num = (value) => Number(value) || 0;

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

/**
 * Every money figure the page shows, in one pass over the restaurant's earned
 * orders.
 *
 * Each column prefers the transaction's recorded value and falls back to the
 * order's own, which is what orderMoney() does row by row. The two windowed
 * profits ride along as FILTERed sums rather than costing another scan.
 */
async function earnedMoneyTotals(restaurantId) {
    const scope = Prisma.sql`WHERE o."restaurantId" = ${restaurantId} AND ${EARNED_ORDER}`;

    const [rows, overCount] = await Promise.all([
        prisma.$queryRaw`
            SELECT COUNT(*)::int                          AS "orderCount",
                   COALESCE(SUM(${RESTAURANT_SHARE}), 0)  AS "restaurantShare",
                   COALESCE(SUM(COALESCE(t."totalCustomerPaid", t."total", o."total")), 0)     AS "revenue",
                   COALESCE(SUM(COALESCE(t."restaurantCommission", o."restaurantCommission")), 0) AS "commission",
                   COALESCE(SUM(COALESCE(t."subtotal",     o."subtotal")),     0) AS "subtotal",
                   COALESCE(SUM(COALESCE(t."taxAmount",    t."tax", o."tax")), 0) AS "tax",
                   COALESCE(SUM(COALESCE(t."packagingFee", o."packagingFee")), 0) AS "packagingFee",
                   COALESCE(SUM(COALESCE(t."deliveryFee",  o."deliveryFee")),  0) AS "deliveryFee",
                   COALESCE(SUM(COALESCE(t."platformFee",  o."platformFee")),  0) AS "platformFee",
                   COALESCE(SUM(COALESCE(t."discount",     o."discount")),     0) AS "discount",
                   COALESCE(SUM(COALESCE(t."adminDiscountShare", 0)),      0) AS "adminDiscountShare",
                   COALESCE(SUM(COALESCE(t."restaurantDiscountShare", 0)), 0) AS "restaurantDiscountShare",
                   COALESCE(SUM(COALESCE(t."riderShare",        o."riderEarning")),   0) AS "riderShare",
                   COALESCE(SUM(COALESCE(t."platformNetProfit", o."platformProfit")), 0) AS "platformNetProfit",
                   COALESCE(SUM(${RESTAURANT_SHARE}) FILTER (
                       WHERE date_trunc('month', o."createdAt") = date_trunc('month', now())), 0) AS "monthlyProfit",
                   COALESCE(SUM(${RESTAURANT_SHARE}) FILTER (
                       WHERE date_trunc('year',  o."createdAt") = date_trunc('year',  now())), 0) AS "yearlyProfit"
            ${ORDERS_JOINED}
            ${scope}
        `,
        shareOverCountByRestaurant({ restaurantId }, new Map()),
    ]);

    const row = rows[0] || {};
    const totals = Object.fromEntries(Object.entries(row).map(([key, value]) => [key, num(value)]));

    // The correction applies to every share figure it contributed to.
    const correction = num(overCount.get(restaurantId));
    return {
        ...totals,
        orderCount: row.orderCount || 0,
        restaurantShare: Math.max(0, totals.restaurantShare - correction),
        monthlyProfit: Math.max(0, totals.monthlyProfit - correction),
        yearlyProfit: Math.max(0, totals.yearlyProfit - correction),
    };
}

/** Order counts by window, and the distinct/repeat customer split. */
async function orderCountsAndCustomers(restaurantId) {
    const [row] = await prisma.$queryRaw`
        SELECT COUNT(*) FILTER (
                   WHERE date_trunc('month', "createdAt") = date_trunc('month', now()))::int AS "monthlyOrders",
               COUNT(*) FILTER (
                   WHERE date_trunc('year',  "createdAt") = date_trunc('year',  now()))::int AS "yearlyOrders",
               COUNT(DISTINCT "userId")::int AS "totalCustomers",
               -- A customer who ordered more than once, counted without
               -- tallying every order into a Map in Node.
               (SELECT COUNT(*)::int FROM (
                    SELECT 1 FROM "food_orders"
                    WHERE "restaurantId" = ${restaurantId}
                    GROUP BY "userId" HAVING COUNT(*) > 1
                ) repeats) AS "repeatCustomers"
        FROM "food_orders"
        WHERE "restaurantId" = ${restaurantId}
    `;

    return {
        monthlyOrders: row?.monthlyOrders || 0,
        yearlyOrders: row?.yearlyOrders || 0,
        totalCustomers: row?.totalCustomers || 0,
        repeatCustomers: row?.repeatCustomers || 0,
    };
}

export async function getRestaurantAnalytics(restaurantId) {
    if (!isId(restaurantId)) return null;
    const rid = String(restaurantId);

    const [restaurant, commission, statusCounts, money, counts] = await Promise.all([
        prisma.foodRestaurant.findUnique({ where: { id: rid } }),
        prisma.foodRestaurantCommission.findFirst({ where: { restaurantId: rid, status: true } }),
        // Replaces a $group with nine conditional counters: the counts are
        // per status, so one grouped query gives all of them.
        prisma.foodOrder.groupBy({
            by: ['orderStatus'],
            where: { restaurantId: rid },
            _count: { _all: true },
        }),
        earnedMoneyTotals(rid),
        orderCountsAndCustomers(rid),
    ]);

    if (!restaurant) return null;

    const countFor = (statuses) => statusCounts
        .filter((row) => statuses.includes(row.orderStatus))
        .reduce((total, row) => total + row._count._all, 0);

    const totalOrders = statusCounts.reduce((total, row) => total + row._count._all, 0);
    const completedOrdersCount = countFor(['delivered']);
    const explicitlyCancelledOrders = countFor(CANCELLED_ORDER_STATUSES);
    const inProgressOrders = countFor(IN_PROGRESS_STATUSES);

    // A percentage rule is the rate itself; a flat fee has to be expressed as
    // one, which only means anything against what was actually sold.
    const commissionPercentage = commission?.commissionType === 'percentage'
        ? num(commission.commissionValue)
        : (money.subtotal > 0 ? (money.commission / money.subtotal) * 100 : 0);

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
        monthlyProfit: money.monthlyProfit,
        yearlyProfit: money.yearlyProfit,
        averageOrderValue: money.orderCount > 0 ? money.revenue / money.orderCount : 0,
        totalRevenue: money.revenue,
        totalCommission: money.commission,
        restaurantEarning: money.restaurantShare, // restaurant share
        restaurantProfit: money.restaurantShare,
        monthlyOrders: counts.monthlyOrders,
        yearlyOrders: counts.yearlyOrders,
        averageMonthlyProfit: money.monthlyProfit, // Placeholder: can be improved if historical data exists
        averageYearlyProfit: money.yearlyProfit,   // Placeholder: can be improved if historical data exists
        status: restaurant.status === 'approved' ? 'active' : 'inactive',
        joinDate: restaurant.createdAt,
        totalCustomers: counts.totalCustomers,
        repeatCustomers: counts.repeatCustomers,
        cancellationRate: rate(explicitlyCancelledOrders),
        completionRate: rate(completedOrdersCount),
        inProgressRate: rate(inProgressOrders),
    };

    const paymentSummary = {
        // Pricing (what customer paid components)
        subtotal: money.subtotal,
        tax: money.tax,
        packagingFee: money.packagingFee,
        deliveryFee: money.deliveryFee,
        platformFee: money.platformFee,
        discount: money.discount,
        adminDiscountShare: money.adminDiscountShare,
        restaurantDiscountShare: money.restaurantDiscountShare,
        total: money.revenue,
        currency: 'INR',

        // Split (who got what)
        restaurantShare: money.restaurantShare,
        restaurantCommission: money.commission,
        riderShare: money.riderShare,
        platformNetProfit: money.platformNetProfit,
    };

    return {
        restaurant,
        analytics,
        paymentSummary,
        subscriptionSummary: await buildRestaurantSubscriptionSummary(rid),
    };
}
