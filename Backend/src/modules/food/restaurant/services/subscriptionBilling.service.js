import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { ValidationError, NotFoundError } from '../../../../core/auth/errors.js';
import { logger } from '../../../../utils/logger.js';
import { notifyOwnerSafely } from '../../../../core/notifications/firebase.service.js';
import {
    isRestaurantEarnedOrder,
    computeRestaurantOrderShare,
    orderMoney,
} from '../../shared/restaurantPayout.util.js';
import { getRestaurantSubscriptionSettings } from '../../admin/services/adminSettings.service.js';
import { FEATURE_KEYS, isFeatureEnabled } from '../../admin/services/featureSettings.service.js';
import { buildPlanCatalog, resolveEligiblePlanByGmv, GST_RATE } from './subscriptionPlan.service.js';

/**
 * Postpaid subscription billing.
 *
 * A restaurant is billed in arrears: once a calendar month closes, its GMV for
 * that month decides which plan it lands on, and the plan price becomes an
 * invoice. The outstanding total on its open invoices is the amount locked
 * against its wallet, so a restaurant cannot withdraw money it owes.
 *
 * Every amount here is a Decimal column, which reaches JavaScript as a string,
 * so it is converted at the point of reading rather than trusted in arithmetic.
 */

const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;

const MONTH_LABELS = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

// ---------- Billing month helpers ----------

export function formatBillingMonth(date) {
    const d = date instanceof Date ? date : new Date(date);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function parseBillingMonth(billingMonth) {
    const match = /^(\d{4})-(\d{2})$/.exec(String(billingMonth || '').trim());
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    if (month < 1 || month > 12) return null;
    return { year, month };
}

export function billingMonthLabel(billingMonth) {
    if (billingMonth === 'legacy') return 'Pre-migration balance';
    const parsed = parseBillingMonth(billingMonth);
    if (!parsed) return String(billingMonth || '');
    return `${MONTH_LABELS[parsed.month - 1]} ${parsed.year}`;
}

/** Calendar-month window: 1st 00:00:00.000 → last day 23:59:59.999, server-local time. */
export function getMonthWindow(billingMonth) {
    const parsed = parseBillingMonth(billingMonth);
    if (!parsed) throw new ValidationError(`Invalid billing month: ${billingMonth}`);
    const start = new Date(parsed.year, parsed.month - 1, 1, 0, 0, 0, 0);
    const end = new Date(parsed.year, parsed.month, 0, 23, 59, 59, 999);
    return { start, end };
}

export function previousBillingMonth(now = new Date()) {
    return formatBillingMonth(new Date(now.getFullYear(), now.getMonth() - 1, 1));
}

function nextBillingMonth(billingMonth) {
    const parsed = parseBillingMonth(billingMonth);
    // `month` is 1-based, so passing it as a 0-based index is already +1 month.
    return formatBillingMonth(new Date(parsed.year, parsed.month, 1));
}

/** billingMonth string comparison works lexicographically for 'YYYY-MM'. */
function isMonthBeforeOrEqual(a, b) {
    return String(a) <= String(b);
}

// ---------- GMV ----------

/** Offers this restaurant's orders could have used. */
const offersForRestaurant = (restaurantId) => prisma.foodOffer.findMany({
    where: {
        OR: [
            { restaurantScope: { not: 'selected' } },
            { restaurantId },
            { restaurantIds: { has: restaurantId } },
        ],
    },
});

/**
 * Monthly GMV = sum of restaurant net share (payout) for earned orders in the window.
 * Uses the same per-order formula as Hub Finance / wallet balance.
 */
export async function computeMonthlyGmv(restaurantId, start, end) {
    if (!isId(restaurantId)) return { gmv: 0, orderCount: 0 };
    const rid = String(restaurantId);

    const orders = await prisma.foodOrder.findMany({
        where: {
            restaurantId: rid,
            createdAt: { gte: start, lte: end },
            orderStatus: { not: 'pending_payment' },
        },
        select: {
            id: true, orderStatus: true, deliveryPhase: true,
            subtotal: true, packagingFee: true, restaurantCommission: true,
            discount: true, couponCode: true,
        },
    });

    const earnedOrders = orders.filter(isRestaurantEarnedOrder);
    if (!earnedOrders.length) return { gmv: 0, orderCount: 0 };

    const [transactions, offers] = await Promise.all([
        prisma.foodTransaction.findMany({
            where: { orderId: { in: earnedOrders.map((o) => o.id) } },
        }),
        offersForRestaurant(rid),
    ]);

    const txByOrderId = new Map(transactions.map((tx) => [tx.orderId, tx]));

    let gmv = 0;
    for (const order of earnedOrders) {
        gmv += computeRestaurantOrderShare(
            orderMoney(order, txByOrderId.get(order.id)),
            offers,
            rid,
        );
    }

    return { gmv: round2(Math.max(0, gmv)), orderCount: earnedOrders.length };
}

// ---------- Notifications ----------

async function notifyRestaurantBilling(restaurantId, title, message, data = {}) {
    try {
        await prisma.foodNotification.create({
            data: {
                ownerType: 'RESTAURANT',
                ownerId: restaurantId,
                title,
                message,
                category: 'billing',
                source: 'SUBSCRIPTION_BILLING',
            },
        });
        await notifyOwnerSafely(
            { ownerType: 'RESTAURANT', ownerId: restaurantId },
            { title, body: message, data: { type: 'subscription_billing', restaurantId, ...data } },
        );
    } catch (err) {
        logger.warn(`Subscription billing notification failed for ${restaurantId}: ${err?.message || err}`);
    }
}

// ---------- Invoice generation ----------

/**
 * Generates the postpaid invoice for one restaurant for a closed billing month.
 * Skips zero-GMV months and months already invoiced.
 */
export async function generateInvoiceForRestaurant(restaurant, billingMonth, settings, generatedBy = 'system') {
    const restaurantId = restaurant?.id;
    if (!restaurantId) return { status: 'skipped', reason: 'missing_restaurant' };

    const existing = await prisma.foodSubscriptionInvoice.findUnique({
        where: { restaurantId_billingMonth: { restaurantId, billingMonth } },
        select: { id: true },
    });
    if (existing) return { status: 'skipped', reason: 'already_invoiced' };

    const { start, end } = getMonthWindow(billingMonth);
    const { gmv, orderCount } = await computeMonthlyGmv(restaurantId, start, end);
    if (gmv <= 0) return { status: 'skipped', reason: 'zero_gmv' };

    const catalog = buildPlanCatalog(settings);
    const planName = resolveEligiblePlanByGmv(gmv, catalog);
    const planEntry = catalog.plans.find((plan) => plan.id === planName) || catalog.plans[0];
    const planAmount = Math.max(0, Number(planEntry?.basePrice) || 0);
    const gstAmount = Math.round(planAmount * GST_RATE);
    const totalAmount = planAmount + gstAmount;

    let invoice;
    try {
        // The invoice and its opening ledger row land together: an invoice with
        // no audit trail would be unexplainable to the restaurant it bills.
        invoice = await prisma.$transaction(async (tx) => {
            const created = await tx.foodSubscriptionInvoice.create({
                data: {
                    restaurantId,
                    billingMonth,
                    periodStart: start,
                    periodEnd: end,
                    gmv,
                    orderCount,
                    planName,
                    planAmount,
                    gstAmount,
                    totalAmount,
                    outstandingAmount: totalAmount,
                    status: 'pending',
                    settingsSnapshot: {
                        starterMinGmv: catalog.starterMinGmv,
                        starterMaxGmv: catalog.starterMaxGmv,
                        growthMinGmv: catalog.growthMinGmv,
                        growthMaxGmv: catalog.growthMaxGmv,
                        premiumMinGmv: catalog.premiumMinGmv,
                        plans: catalog.plans,
                        gstRate: GST_RATE,
                    },
                    generatedBy,
                },
            });

            await tx.foodSubscriptionTransaction.create({
                data: {
                    restaurantId,
                    invoiceId: created.id,
                    billingMonth,
                    type: 'invoice_generated',
                    amount: totalAmount,
                    outstandingAfter: totalAmount,
                    invoiceStatusAfter: 'pending',
                    processedByRole: 'SYSTEM',
                    remarks: `Monthly invoice for ${billingMonthLabel(billingMonth)} — GMV ₹${gmv}, ${planEntry?.label || planName} plan`,
                    metadata: { gmv, orderCount, planAmount, gstAmount },
                },
            });

            return created;
        });
    } catch (err) {
        // Two runs racing for the same month: the unique index is the backstop.
        if (err?.code === 'P2002') return { status: 'skipped', reason: 'already_invoiced' };
        throw err;
    }

    await notifyRestaurantBilling(
        restaurantId,
        'Subscription Invoice Generated 💳',
        `Your ${billingMonthLabel(billingMonth)} subscription invoice is ready: ${planEntry?.label || planName} plan ₹${totalAmount} (incl. GST) based on monthly GMV of ₹${gmv}. The amount is due and locked against your wallet balance.`,
        { billingMonth, invoiceId: invoice.id, amount: String(totalAmount) },
    );

    return { status: 'invoiced', invoice };
}

/**
 * Runs (or re-runs) billing for one closed calendar month across all approved restaurants.
 * Idempotent: already-invoiced restaurants are skipped.
 */
export async function runMonthlyBilling(billingMonth, { generatedBy = 'system' } = {}) {
    if (!parseBillingMonth(billingMonth)) {
        throw new ValidationError(`Invalid billing month: ${billingMonth}`);
    }
    if (!isMonthBeforeOrEqual(billingMonth, previousBillingMonth())) {
        throw new ValidationError('Cannot bill the current or a future month — the month must be closed first');
    }

    const run = await prisma.foodSubscriptionBillingRun.upsert({
        where: { billingMonth },
        create: { billingMonth, status: 'pending', startedAt: new Date() },
        update: { status: 'pending', startedAt: new Date() },
    });

    const settings = (await getRestaurantSubscriptionSettings()) || {};
    const restaurants = await prisma.foodRestaurant.findMany({
        where: { status: 'approved' },
        select: { id: true, restaurantName: true },
    });

    let invoicedCount = 0;
    let skippedZeroGmvCount = 0;
    let errorCount = 0;
    const errors = [];

    for (const restaurant of restaurants) {
        try {
            const result = await generateInvoiceForRestaurant(restaurant, billingMonth, settings, generatedBy);
            if (result.status === 'invoiced') invoicedCount += 1;
            else if (result.reason === 'zero_gmv') skippedZeroGmvCount += 1;
        } catch (err) {
            // One restaurant's bad data must not stop the other thousand.
            errorCount += 1;
            errors.push(`${restaurant.id}: ${err?.message || err}`);
            logger.error(`Monthly billing failed for restaurant ${restaurant.id} (${billingMonth}): ${err?.message || err}`);
        }
    }

    await prisma.foodSubscriptionBillingRun.update({
        where: { id: run.id },
        data: {
            status: errorCount > 0 ? 'failed' : 'completed',
            invoicedCount,
            skippedZeroGmvCount,
            errorCount,
            errors: errors.slice(0, 50),
            finishedAt: new Date(),
        },
    });

    logger.info(
        `[SUBSCRIPTION BILLING] ${billingMonth}: invoiced=${invoicedCount}, zeroGmvSkipped=${skippedZeroGmvCount}, errors=${errorCount}`,
    );
    return { billingMonth, invoicedCount, skippedZeroGmvCount, errorCount };
}

/**
 * Job entry point. Bills every unbilled month up to and including the previous
 * calendar month — BullMQ repeatable jobs do not backfill runs missed while
 * the worker was down, so this catches up on restart.
 */
export async function runBillingCatchUp() {
    const enabled = await isFeatureEnabled(FEATURE_KEYS.RESTAURANT_SUBSCRIPTION, true);
    if (!enabled) {
        logger.info('[SUBSCRIPTION BILLING] Feature disabled — skipping billing run');
        return { skipped: true, reason: 'feature_disabled' };
    }

    const targetMonth = previousBillingMonth();
    const lastCompleted = await prisma.foodSubscriptionBillingRun.findFirst({
        where: { status: 'completed' },
        orderBy: { billingMonth: 'desc' },
    });

    // Start from the month after the last completed run; first-ever run bills only the previous month.
    let month = lastCompleted ? nextBillingMonth(lastCompleted.billingMonth) : targetMonth;
    if (!isMonthBeforeOrEqual(month, targetMonth)) month = targetMonth;

    const results = [];
    while (isMonthBeforeOrEqual(month, targetMonth)) {
        results.push(await runMonthlyBilling(month));
        month = nextBillingMonth(month);
    }
    return { skipped: false, results };
}

// ---------- Outstanding / locking ----------

const OPEN_INVOICE_STATUSES = ['pending', 'partially_settled'];

/**
 * Total outstanding subscription due = wallet locked amount, plus per-invoice breakdown.
 */
export async function getOutstandingSummary(restaurantId) {
    if (!isId(restaurantId)) return { lockedAmount: 0, openInvoices: [], monthsLabel: '' };

    const rows = await prisma.foodSubscriptionInvoice.findMany({
        where: {
            restaurantId: String(restaurantId),
            status: { in: OPEN_INVOICE_STATUSES },
            outstandingAmount: { gt: 0 },
        },
        orderBy: { billingMonth: 'asc' },
        select: {
            id: true, billingMonth: true, planName: true, totalAmount: true,
            outstandingAmount: true, status: true, isLegacyCarryForward: true,
        },
    });

    const openInvoices = rows.map((inv) => ({
        ...inv,
        _id: inv.id,
        totalAmount: Number(inv.totalAmount),
        outstandingAmount: Number(inv.outstandingAmount),
    }));

    return {
        lockedAmount: round2(openInvoices.reduce((sum, inv) => sum + inv.outstandingAmount, 0)),
        openInvoices,
        monthsLabel: openInvoices.map((inv) => billingMonthLabel(inv.billingMonth)).join(', '),
    };
}

// ---------- Settlement primitives ----------

function resolveInvoiceStatus(invoice) {
    if (Number(invoice.outstandingAmount) <= 0) {
        return Number(invoice.waivedAmount) > 0 && Number(invoice.paidAmount) <= 0 ? 'waived' : 'settled';
    }
    return Number(invoice.paidAmount) > 0 || Number(invoice.waivedAmount) > 0 ? 'partially_settled' : 'pending';
}

/** Numbers, not Decimal strings, for everything that leaves this module. */
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
});

/**
 * Move money against an invoice and record why.
 *
 * The outstanding check lives in the `where`, not in a prior read, so two
 * admins settling the same invoice at once cannot both succeed — the loser
 * matches no rows. Everything happens in one transaction: an invoice whose
 * balance moved without a matching ledger row would be unauditable.
 */
async function settleInvoice(invoiceId, {
    type,
    /** Column that records what kind of money this was, and by how much. */
    amountField,
    amountDelta,
    /** Signed change to what is still owed. */
    outstandingDelta,
    /** The invoice must still owe at least this much for the move to apply. */
    minOutstanding,
    /** What the ledger row records — signed, so a reduction reads as negative. */
    ledgerAmount,
    admin,
    remarks,
    metadata = {},
}) {
    if (!isId(invoiceId)) throw new NotFoundError('Subscription invoice not found');

    return prisma.$transaction(async (tx) => {
        const { count } = await tx.foodSubscriptionInvoice.updateMany({
            where: { id: String(invoiceId), outstandingAmount: { gte: minOutstanding } },
            data: {
                [amountField]: { increment: amountDelta },
                outstandingAmount: { increment: outstandingDelta },
            },
        });
        if (!count) throw new ValidationError('Invoice was settled concurrently — refresh and retry');

        const moved = await tx.foodSubscriptionInvoice.findUnique({ where: { id: String(invoiceId) } });
        const status = resolveInvoiceStatus(moved);
        const invoice = await tx.foodSubscriptionInvoice.update({
            where: { id: moved.id },
            data: { status },
        });

        const transaction = await tx.foodSubscriptionTransaction.create({
            data: {
                restaurantId: invoice.restaurantId,
                invoiceId: invoice.id,
                billingMonth: invoice.billingMonth,
                type,
                amount: ledgerAmount,
                outstandingAfter: invoice.outstandingAmount,
                invoiceStatusAfter: status,
                ...(admin
                    ? {
                        processedByRole: 'ADMIN',
                        processedById: isId(admin.id ?? admin._id) ? String(admin.id ?? admin._id) : null,
                        processedByName: admin.name || '',
                    }
                    : { processedByRole: 'SYSTEM' }),
                remarks: remarks || '',
                metadata,
            },
        });

        return { invoice: serializeInvoice(invoice), transaction };
    });
}

const loadInvoice = async (invoiceId) => {
    if (!isId(invoiceId)) throw new NotFoundError('Subscription invoice not found');
    const invoice = await prisma.foodSubscriptionInvoice.findUnique({ where: { id: String(invoiceId) } });
    if (!invoice) throw new NotFoundError('Subscription invoice not found');
    return serializeInvoice(invoice);
};

/**
 * Admin deducts (part of) the due directly from the restaurant wallet.
 * `maxDeductible` — the restaurant's current available wallet balance, computed
 * by the caller from the finance service so the number matches what the
 * restaurant sees. The deduction itself is recorded as a wallet_deduction
 * transaction, which the finance service subtracts from the balance.
 */
export async function applyWalletDeduction(invoiceId, amount, admin, remarks, { maxDeductible = null } = {}) {
    const invoice = await loadInvoice(invoiceId);
    const deductAmount = round2(Number(amount));

    if (!Number.isFinite(deductAmount) || deductAmount <= 0) {
        throw new ValidationError('Deduction amount must be greater than zero');
    }
    if (deductAmount > invoice.outstandingAmount) {
        throw new ValidationError(
            `Deduction ₹${deductAmount} exceeds outstanding due of ₹${invoice.outstandingAmount}`,
        );
    }
    if (maxDeductible != null && deductAmount > round2(maxDeductible)) {
        throw new ValidationError(
            `Deduction ₹${deductAmount} exceeds the restaurant's wallet balance of ₹${round2(maxDeductible)}`,
        );
    }

    const result = await settleInvoice(invoiceId, {
        type: 'wallet_deduction',
        amountField: 'paidAmount',
        amountDelta: deductAmount,
        outstandingDelta: -deductAmount,
        minOutstanding: deductAmount,
        ledgerAmount: deductAmount,
        admin,
        remarks,
        metadata: { method: 'wallet' },
    });

    await notifyRestaurantBilling(
        result.invoice.restaurantId,
        'Subscription Due Deducted',
        `₹${deductAmount} was deducted from your wallet towards the ${billingMonthLabel(result.invoice.billingMonth)} subscription due. Remaining due: ₹${result.invoice.outstandingAmount}.${remarks ? ` Note: ${remarks}` : ''}`,
        { billingMonth: result.invoice.billingMonth, amount: String(deductAmount) },
    );

    return result;
}

/**
 * Admin marks (part of) the due as paid outside the platform (cash/bank transfer).
 */
export async function applyManualPayment(invoiceId, amount, admin, remarks) {
    const invoice = await loadInvoice(invoiceId);
    const payAmount = round2(amount != null ? Number(amount) : invoice.outstandingAmount);

    if (!Number.isFinite(payAmount) || payAmount <= 0) {
        throw new ValidationError('Payment amount must be greater than zero');
    }
    if (payAmount > invoice.outstandingAmount) {
        throw new ValidationError(`Payment ₹${payAmount} exceeds outstanding due of ₹${invoice.outstandingAmount}`);
    }
    if (!String(remarks || '').trim()) {
        throw new ValidationError('Remarks are required when marking a due as paid manually');
    }

    const result = await settleInvoice(invoiceId, {
        type: 'manual_payment',
        amountField: 'paidAmount',
        amountDelta: payAmount,
        outstandingDelta: -payAmount,
        minOutstanding: payAmount,
        ledgerAmount: payAmount,
        admin,
        remarks,
        metadata: { method: 'manual' },
    });

    await notifyRestaurantBilling(
        result.invoice.restaurantId,
        'Subscription Payment Recorded',
        `₹${payAmount} was recorded against your ${billingMonthLabel(result.invoice.billingMonth)} subscription due. Remaining due: ₹${result.invoice.outstandingAmount}.`,
        { billingMonth: result.invoice.billingMonth, amount: String(payAmount) },
    );

    return result;
}

/**
 * Admin waives the full remaining due. Wallet lock releases immediately
 * (locking is computed from outstanding amounts).
 */
export async function applyWaiver(invoiceId, admin, remarks) {
    const invoice = await loadInvoice(invoiceId);

    if (!String(remarks || '').trim()) {
        throw new ValidationError('Remarks are required when waiving a subscription due');
    }
    const waiveAmount = round2(invoice.outstandingAmount);
    if (waiveAmount <= 0) throw new ValidationError('Invoice has no outstanding amount to waive');

    const result = await settleInvoice(invoiceId, {
        type: 'waiver',
        amountField: 'waivedAmount',
        amountDelta: waiveAmount,
        outstandingDelta: -waiveAmount,
        minOutstanding: waiveAmount,
        ledgerAmount: waiveAmount,
        admin,
        remarks,
    });

    await notifyRestaurantBilling(
        result.invoice.restaurantId,
        'Subscription Due Waived 🎉',
        `Your ${billingMonthLabel(result.invoice.billingMonth)} subscription due of ₹${waiveAmount} has been waived. The locked wallet amount has been released.${remarks ? ` Note: ${remarks}` : ''}`,
        { billingMonth: result.invoice.billingMonth, amount: String(waiveAmount) },
    );

    return result;
}

/**
 * Admin manual adjustment: positive increases the outstanding due,
 * negative reduces it (floored at zero).
 */
export async function applyAdjustment(invoiceId, signedAmount, admin, remarks) {
    const invoice = await loadInvoice(invoiceId);
    const adjustment = round2(Number(signedAmount));

    if (!Number.isFinite(adjustment) || adjustment === 0) {
        throw new ValidationError('Adjustment amount must be a non-zero number');
    }
    if (!String(remarks || '').trim()) {
        throw new ValidationError('Remarks are required for manual adjustments');
    }

    // A reduction can never take the due below zero.
    const effective = adjustment < 0 ? Math.max(adjustment, -invoice.outstandingAmount) : adjustment;

    const result = await settleInvoice(invoiceId, {
        type: 'adjustment',
        amountField: 'adjustmentAmount',
        // Signed throughout: a negative adjustment reduces the due, and the
        // ledger has to say so rather than record its magnitude.
        amountDelta: effective,
        outstandingDelta: effective,
        minOutstanding: effective < 0 ? -effective : 0,
        ledgerAmount: effective,
        admin,
        remarks,
        metadata: { requestedAmount: adjustment },
    });

    await notifyRestaurantBilling(
        result.invoice.restaurantId,
        'Subscription Due Adjusted',
        `Your ${billingMonthLabel(result.invoice.billingMonth)} subscription due was adjusted by ₹${effective}. Remaining due: ₹${result.invoice.outstandingAmount}.${remarks ? ` Note: ${remarks}` : ''}`,
        { billingMonth: result.invoice.billingMonth, amount: String(effective) },
    );

    return result;
}
