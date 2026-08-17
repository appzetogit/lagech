import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { sendResponse, sendError } from '../../../../utils/response.js';
import {
    computeMonthlyGmv,
    getMonthWindow,
    formatBillingMonth,
    billingMonthLabel,
    getOutstandingSummary,
} from '../services/subscriptionBilling.service.js';
import { getRestaurantFinance } from '../services/restaurantFinance.service.js';
import { getRestaurantSubscriptionSettings } from '../../admin/services/adminSettings.service.js';
import { FEATURE_KEYS, isFeatureEnabled } from '../../admin/services/featureSettings.service.js';
import { buildPlanCatalog, resolveEligiblePlanByGmv, GST_RATE } from '../services/subscriptionPlan.service.js';

const INVOICE_STATUSES = ['pending', 'partially_settled', 'settled', 'waived'];

/** Decimal columns reach the client as strings otherwise. */
const serializeInvoice = (inv) => ({
    ...inv,
    _id: inv.id,
    gmv: Number(inv.gmv),
    planAmount: Number(inv.planAmount),
    gstAmount: Number(inv.gstAmount),
    totalAmount: Number(inv.totalAmount),
    paidAmount: Number(inv.paidAmount),
    waivedAmount: Number(inv.waivedAmount),
    adjustmentAmount: Number(inv.adjustmentAmount),
    outstandingAmount: Number(inv.outstandingAmount),
    billingMonthLabel: billingMonthLabel(inv.billingMonth),
});

const serializeTransaction = (tx) => ({
    ...tx,
    _id: tx.id,
    amount: Number(tx.amount),
    outstandingAfter: Number(tx.outstandingAfter),
    billingMonthLabel: billingMonthLabel(tx.billingMonth),
});

/**
 * GET /subscription/overview — current-month live GMV, estimated plan/fee,
 * outstanding dues, locked amount, wallet balance and withdrawable amount.
 */
export const getSubscriptionOverviewController = async (req, res, next) => {
    try {
        const restaurantId = req.user?.userId;
        if (!isId(restaurantId)) return sendError(res, 401, 'Restaurant authentication required');

        const featureEnabled = await isFeatureEnabled(FEATURE_KEYS.RESTAURANT_SUBSCRIPTION, true);

        const currentMonth = formatBillingMonth(new Date());
        const { start, end } = getMonthWindow(currentMonth);
        const [gmvResult, settings, outstanding, finance] = await Promise.all([
            computeMonthlyGmv(restaurantId, start, new Date()),
            getRestaurantSubscriptionSettings(),
            getOutstandingSummary(restaurantId),
            getRestaurantFinance(restaurantId),
        ]);

        const catalog = buildPlanCatalog(settings || {});
        const estimatedPlan = resolveEligiblePlanByGmv(gmvResult.gmv, catalog);
        const planEntry = catalog.plans.find((plan) => plan.id === estimatedPlan) || catalog.plans[0];
        const estimatedPlanAmount = gmvResult.gmv > 0 ? Math.max(0, Number(planEntry?.basePrice) || 0) : 0;
        const estimatedGst = Math.round(estimatedPlanAmount * GST_RATE);

        return sendResponse(res, 200, 'Subscription overview fetched', {
            featureEnabled,
            currentMonth: {
                billingMonth: currentMonth,
                label: billingMonthLabel(currentMonth),
                periodStart: start,
                periodEnd: end,
                gmv: gmvResult.gmv,
                orderCount: gmvResult.orderCount,
                estimatedPlan: gmvResult.gmv > 0 ? estimatedPlan : null,
                estimatedPlanLabel: gmvResult.gmv > 0 ? planEntry?.label || estimatedPlan : null,
                estimatedPlanAmount,
                estimatedGst,
                estimatedTotal: estimatedPlanAmount + estimatedGst,
                planCatalog: catalog.plans,
            },
            outstanding: {
                totalDue: outstanding.lockedAmount,
                lockedAmount: featureEnabled ? outstanding.lockedAmount : 0,
                lockedMonths: outstanding.monthsLabel,
                openInvoices: outstanding.openInvoices,
            },
            wallet: {
                totalBalance: Number(finance?.wallet?.withdrawableBalance ?? finance?.currentCycle?.withdrawableBalance ?? 0),
                netAvailable: Number(finance?.wallet?.netAvailable ?? finance?.currentCycle?.netAvailable ?? 0),
            },
        });
    } catch (error) {
        next(error);
    }
};

/**
 * GET /subscription/invoices — the restaurant's monthly invoice history.
 */
export const listSubscriptionInvoicesController = async (req, res, next) => {
    try {
        const restaurantId = req.user?.userId;
        if (!isId(restaurantId)) return sendError(res, 401, 'Restaurant authentication required');

        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);

        const where = { restaurantId };
        if (INVOICE_STATUSES.includes(String(req.query.status || '').trim())) {
            where.status = String(req.query.status).trim();
        }

        const [invoices, total] = await Promise.all([
            prisma.foodSubscriptionInvoice.findMany({
                where,
                orderBy: { billingMonth: 'desc' },
                skip: (page - 1) * limit,
                take: limit,
            }),
            prisma.foodSubscriptionInvoice.count({ where }),
        ]);

        return sendResponse(res, 200, 'Subscription invoices fetched', {
            invoices: invoices.map(serializeInvoice),
            pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
        });
    } catch (error) {
        next(error);
    }
};

/**
 * GET /subscription/invoices/:invoiceId — one invoice + its transaction timeline.
 */
export const getSubscriptionInvoiceController = async (req, res, next) => {
    try {
        const restaurantId = req.user?.userId;
        if (!isId(restaurantId)) return sendError(res, 401, 'Restaurant authentication required');
        const { invoiceId } = req.params;
        if (!isId(invoiceId)) return sendError(res, 400, 'Invalid invoice id');

        // Scoped to the caller: an invoice id alone must not expose another
        // restaurant's billing.
        const invoice = await prisma.foodSubscriptionInvoice.findFirst({
            where: { id: String(invoiceId), restaurantId },
        });
        if (!invoice) return sendError(res, 404, 'Invoice not found');

        const transactions = await prisma.foodSubscriptionTransaction.findMany({
            where: { invoiceId: invoice.id },
            orderBy: { createdAt: 'asc' },
        });

        return sendResponse(res, 200, 'Subscription invoice fetched', {
            invoice: serializeInvoice(invoice),
            transactions: transactions.map(serializeTransaction),
        });
    } catch (error) {
        next(error);
    }
};

/**
 * GET /subscription/transactions — complete billing timeline for the restaurant.
 */
export const listSubscriptionTransactionsController = async (req, res, next) => {
    try {
        const restaurantId = req.user?.userId;
        if (!isId(restaurantId)) return sendError(res, 401, 'Restaurant authentication required');

        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);

        const where = { restaurantId };
        if (req.query.billingMonth) where.billingMonth = String(req.query.billingMonth);

        const [transactions, total] = await Promise.all([
            prisma.foodSubscriptionTransaction.findMany({
                where,
                orderBy: { createdAt: 'desc' },
                skip: (page - 1) * limit,
                take: limit,
            }),
            prisma.foodSubscriptionTransaction.count({ where }),
        ]);

        return sendResponse(res, 200, 'Subscription transactions fetched', {
            transactions: transactions.map(serializeTransaction),
            pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
        });
    } catch (error) {
        next(error);
    }
};
