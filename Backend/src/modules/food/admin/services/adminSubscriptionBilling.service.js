import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { ValidationError, NotFoundError } from '../../../../core/auth/errors.js';
import {
    applyWalletDeduction,
    applyManualPayment,
    applyWaiver,
    applyAdjustment,
    runMonthlyBilling,
    billingMonthLabel,
    computeMonthlyGmv,
    getMonthWindow,
    formatBillingMonth,
    getOutstandingSummary,
} from '../../restaurant/services/subscriptionBilling.service.js';
import { getRestaurantFinance } from '../../restaurant/services/restaurantFinance.service.js';

/**
 * The admin view of subscription billing: every restaurant's invoices, what
 * they owe, and the actions that settle them.
 */

const INVOICE_STATUSES = ['pending', 'partially_settled', 'settled', 'waived'];
const PLAN_NAMES = ['starter', 'growth', 'premium', 'legacy'];

const RESTAURANT_SUMMARY = {
    select: {
        id: true, restaurantName: true, ownerName: true, ownerPhone: true, profileImage: true,
    },
};

const EMPTY_WALLET = { totalEarnings: 0, walletBalance: 0, netAvailable: 0, lockedAmount: 0 };

/** Decimal columns reach JSON as strings; the admin table does arithmetic on these. */
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

function buildInvoiceFilter(query = {}) {
    const where = {};
    if (isId(query.restaurantId)) where.restaurantId = String(query.restaurantId);
    if (query.billingMonth) where.billingMonth = String(query.billingMonth).trim();

    const planName = String(query.planName || '').trim().toLowerCase();
    if (PLAN_NAMES.includes(planName)) where.planName = planName;

    const status = String(query.status || '').trim().toLowerCase();
    if (INVOICE_STATUSES.includes(status)) where.status = status;

    if (String(query.dueOnly) === 'true') where.outstandingAmount = { gt: 0 };

    const amountOn = String(query.amountOn || 'gmv').toLowerCase() === 'wallet' ? 'wallet' : 'gmv';
    const toBound = (value) => (value != null && String(value).trim() !== '' ? Number(value) : null);
    const amountMin = toBound(query.amountMin);
    const amountMax = toBound(query.amountMax);

    // A GMV bound is a column and filters in SQL; a wallet bound is derived per
    // restaurant and can only be applied after the rows are hydrated.
    if (amountOn === 'gmv' && (Number.isFinite(amountMin) || Number.isFinite(amountMax))) {
        where.gmv = {};
        if (Number.isFinite(amountMin)) where.gmv.gte = amountMin;
        if (Number.isFinite(amountMax)) where.gmv.lte = amountMax;
    }

    return { where, amountOn, amountMin, amountMax };
}

/** Narrow the invoices to a zone or a restaurant search, when either was asked for. */
async function resolveScopedRestaurantIds(query = {}) {
    const zoneId = isId(query.zoneId || query.zone) ? String(query.zoneId || query.zone) : null;
    const search = String(query.search || '').trim();
    if (!zoneId && !search) return null;

    const where = {};
    if (zoneId) where.zoneId = zoneId;
    if (search) {
        const contains = { contains: search, mode: 'insensitive' };
        where.OR = [
            { restaurantName: contains },
            { ownerName: contains },
            { ownerPhone: contains },
            { primaryContactNumber: contains },
        ];
    }

    const matches = await prisma.foodRestaurant.findMany({
        where,
        select: { id: true },
        take: 1000,
    });
    return matches.map((row) => row.id);
}

function parseInvoiceSort(query = {}) {
    const raw = String(query.sortBy || 'billingMonth').trim().toLowerCase();
    const sortBy = raw === 'gmv' || raw === 'wallet' ? raw : 'billingMonth';
    const sortOrder = String(query.sortOrder || 'desc').trim().toLowerCase() === 'asc' ? 'asc' : 'desc';
    return { sortBy, sortOrder };
}

function mapInvoiceRow(inv, walletByRestaurantId) {
    return {
        ...serializeInvoice(inv),
        restaurant: inv.restaurant
            ? { ...inv.restaurant, _id: inv.restaurant.id }
            : null,
        wallet: walletByRestaurantId[inv.restaurantId] || { ...EMPTY_WALLET },
    };
}

function applyWalletAmountFilter(rows, amountMin, amountMax) {
    return rows.filter((row) => {
        const value = Number(row.wallet?.walletBalance ?? 0);
        if (Number.isFinite(amountMin) && value < amountMin) return false;
        if (Number.isFinite(amountMax) && value > amountMax) return false;
        return true;
    });
}

function sortInvoiceRows(rows, { sortBy, sortOrder }) {
    const dir = sortOrder === 'asc' ? 1 : -1;
    const byName = (a, b) => String(a.restaurant?.restaurantName || '')
        .localeCompare(String(b.restaurant?.restaurantName || '')) * dir;

    return [...rows].sort((a, b) => {
        if (sortBy === 'wallet' || sortBy === 'gmv') {
            const av = sortBy === 'wallet' ? Number(a.wallet?.walletBalance ?? 0) : Number(a.gmv ?? 0);
            const bv = sortBy === 'wallet' ? Number(b.wallet?.walletBalance ?? 0) : Number(b.gmv ?? 0);
            return av === bv ? byName(a, b) : (av - bv) * dir;
        }

        const cmp = String(a.billingMonth || '').localeCompare(String(b.billingMonth || ''));
        if (cmp !== 0) return cmp * dir;
        return (new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime()) * dir;
    });
}

/**
 * The wallet figures shown beside each invoice.
 *
 * ponytail: one full finance computation per restaurant, and each one reads
 * that restaurant's whole order history — so a page of twenty invoices is
 * twenty history scans. It was the same before the port. A materialised
 * balance per restaurant is the fix when this gets slow.
 */
async function getWalletSummariesForRestaurants(restaurantIds = []) {
    const uniqueIds = [...new Set((restaurantIds || []).map((id) => String(id || '').trim()).filter(Boolean))];
    if (uniqueIds.length === 0) return {};

    const entries = await Promise.all(uniqueIds.map(async (restaurantId) => {
        try {
            const finance = await getRestaurantFinance(restaurantId);
            const wallet = finance?.wallet ?? finance?.currentCycle ?? {};
            return [restaurantId, {
                totalEarnings: Number(wallet.totalEarnings ?? wallet.estimatedPayout ?? 0),
                walletBalance: Number(wallet.withdrawableBalance ?? 0),
                netAvailable: Number(wallet.netAvailable ?? wallet.withdrawableBalance ?? 0),
                lockedAmount: Number(finance?.subscription?.lockedAmount ?? 0),
            }];
        } catch {
            // One unreadable restaurant must not blank the whole table.
            return [restaurantId, { ...EMPTY_WALLET }];
        }
    }));

    return Object.fromEntries(entries);
}

async function listHydratedInvoicesAdmin(query = {}, { paginate = true } = {}) {
    const page = Math.max(1, parseInt(query.page, 10) || 1);
    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 20, 1), 100);
    const { where, amountOn, amountMin, amountMax } = buildInvoiceFilter(query);
    const sort = parseInvoiceSort(query);

    if (!where.restaurantId) {
        const scopedRestaurantIds = await resolveScopedRestaurantIds(query);
        if (scopedRestaurantIds !== null) where.restaurantId = { in: scopedRestaurantIds };
    }

    // Sorting or filtering on the wallet balance cannot happen in SQL, so those
    // two cases pull a bounded page-set and finish the job in memory.
    const needsWalletPostFilter = amountOn === 'wallet'
        && (Number.isFinite(amountMin) || Number.isFinite(amountMax));
    const useInMemoryPipeline = needsWalletPostFilter || sort.sortBy === 'wallet';

    let invoices;
    let total;

    if (useInMemoryPipeline) {
        invoices = await prisma.foodSubscriptionInvoice.findMany({
            where,
            include: { restaurant: RESTAURANT_SUMMARY },
            orderBy: [{ billingMonth: 'desc' }, { createdAt: 'desc' }],
            take: 5000,
        });
    } else {
        const orderBy = sort.sortBy === 'gmv'
            ? [{ gmv: sort.sortOrder }, { billingMonth: 'desc' }, { createdAt: 'desc' }]
            : [{ billingMonth: sort.sortOrder }, { createdAt: 'desc' }];

        [invoices, total] = await Promise.all([
            prisma.foodSubscriptionInvoice.findMany({
                where,
                include: { restaurant: RESTAURANT_SUMMARY },
                orderBy,
                skip: paginate ? (page - 1) * limit : 0,
                take: paginate ? limit : 5000,
            }),
            prisma.foodSubscriptionInvoice.count({ where }),
        ]);
    }

    const walletByRestaurantId = await getWalletSummariesForRestaurants(
        invoices.map((inv) => inv.restaurantId),
    );

    let rows = invoices.map((inv) => mapInvoiceRow(inv, walletByRestaurantId));

    if (needsWalletPostFilter) rows = applyWalletAmountFilter(rows, amountMin, amountMax);
    if (useInMemoryPipeline) {
        rows = sortInvoiceRows(rows, sort);
        total = rows.length;
        if (paginate) rows = rows.slice((page - 1) * limit, page * limit);
    }

    return {
        invoices: rows,
        pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    };
}

/**
 * Paginated invoice list with restaurant name populated and optional search.
 */
export async function listSubscriptionInvoicesAdmin(query = {}) {
    return listHydratedInvoicesAdmin(query, { paginate: true });
}

export async function getSubscriptionInvoiceAdmin(invoiceId) {
    if (!isId(invoiceId)) throw new ValidationError('Invalid invoice id');
    const id = String(invoiceId);

    const invoice = await prisma.foodSubscriptionInvoice.findUnique({
        where: { id },
        include: { restaurant: RESTAURANT_SUMMARY },
    });
    if (!invoice) throw new NotFoundError('Invoice not found');

    const [walletByRestaurantId, transactions] = await Promise.all([
        getWalletSummariesForRestaurants([invoice.restaurantId]),
        prisma.foodSubscriptionTransaction.findMany({
            where: { invoiceId: id },
            orderBy: { createdAt: 'asc' },
        }),
    ]);

    return {
        invoice: mapInvoiceRow(invoice, walletByRestaurantId),
        transactions: transactions.map((tx) => ({
            ...tx,
            _id: tx.id,
            amount: Number(tx.amount),
            outstandingAfter: Number(tx.outstandingAfter),
        })),
    };
}

/**
 * Analytics summary: per-month totals + plan distribution + overall outstanding.
 */
export async function getSubscriptionBillingSummaryAdmin(query = {}) {
    const monthsBack = Math.min(Math.max(parseInt(query.months, 10) || 12, 1), 36);
    const since = new Date();
    since.setMonth(since.getMonth() - monthsBack);
    const sinceMonth = formatBillingMonth(since);

    const recent = { billingMonth: { gte: sinceMonth } };
    const MONEY_SUMS = {
        _sum: {
            gmv: true, totalAmount: true, paidAmount: true,
            waivedAmount: true, outstandingAmount: true,
        },
        _count: { _all: true },
    };

    const [monthly, planDistribution, totals, billingRuns, collection] = await Promise.all([
        prisma.foodSubscriptionInvoice.groupBy({
            by: ['billingMonth'],
            where: recent,
            orderBy: { billingMonth: 'asc' },
            ...MONEY_SUMS,
        }),
        prisma.foodSubscriptionInvoice.groupBy({
            by: ['planName'],
            where: recent,
            _count: { _all: true },
            _sum: { totalAmount: true },
        }),
        prisma.foodSubscriptionInvoice.aggregate(MONEY_SUMS),
        prisma.foodSubscriptionBillingRun.findMany({
            orderBy: { billingMonth: 'desc' },
            take: monthsBack,
        }),
        prisma.foodSubscriptionTransaction.groupBy({
            by: ['type'],
            where: { type: { in: ['wallet_deduction', 'manual_payment'] } },
            _sum: { amount: true },
            _count: { _all: true },
        }),
    ]);

    const num = (value) => Number(value) || 0;

    return {
        totals: {
            totalBilled: num(totals._sum.totalAmount),
            totalPaid: num(totals._sum.paidAmount),
            totalWaived: num(totals._sum.waivedAmount),
            totalOutstanding: num(totals._sum.outstandingAmount),
            invoiceCount: totals._count._all,
        },
        monthly: monthly.map((row) => ({
            _id: row.billingMonth,
            billingMonth: row.billingMonth,
            label: billingMonthLabel(row.billingMonth),
            invoiceCount: row._count._all,
            totalGmv: num(row._sum.gmv),
            totalBilled: num(row._sum.totalAmount),
            totalPaid: num(row._sum.paidAmount),
            totalWaived: num(row._sum.waivedAmount),
            totalOutstanding: num(row._sum.outstandingAmount),
        })),
        planDistribution: planDistribution.map((row) => ({
            _id: row.planName,
            count: row._count._all,
            billed: num(row._sum.totalAmount),
        })),
        collectionByMethod: Object.fromEntries(collection.map((row) => [
            row.type,
            { total: num(row._sum.amount), count: row._count._all },
        ])),
        billingRuns,
    };
}

/**
 * POS/per-restaurant overview: live month GMV + estimated plan + invoices + outstanding.
 */
export async function getRestaurantSubscriptionOverviewAdmin(restaurantId) {
    if (!isId(restaurantId)) throw new ValidationError('Invalid restaurant id');
    const rid = String(restaurantId);

    const currentMonth = formatBillingMonth(new Date());
    const { start } = getMonthWindow(currentMonth);

    const [gmvResult, outstanding, invoices] = await Promise.all([
        // Up to now, not to the end of the month: the month is still running.
        computeMonthlyGmv(rid, start, new Date()),
        getOutstandingSummary(rid),
        prisma.foodSubscriptionInvoice.findMany({
            where: { restaurantId: rid },
            orderBy: { billingMonth: 'desc' },
            take: 24,
        }),
    ]);

    return {
        currentMonth: {
            billingMonth: currentMonth,
            label: billingMonthLabel(currentMonth),
            gmv: gmvResult.gmv,
            orderCount: gmvResult.orderCount,
        },
        outstanding,
        invoices: invoices.map(serializeInvoice),
    };
}

// ---------- Settlement actions ----------

/**
 * Deduct (part of) an invoice's due from the restaurant wallet.
 * Validated against the same available balance the restaurant sees, plus the
 * amount already locked for OTHER invoices (deducting for this invoice may
 * consume its own locked share, but never other invoices' locked money).
 */
export async function deductInvoiceFromWalletAdmin(invoiceId, amount, admin, remarks) {
    if (!isId(invoiceId)) throw new ValidationError('Invalid invoice id');

    const invoice = await prisma.foodSubscriptionInvoice.findUnique({
        where: { id: String(invoiceId) },
        select: { restaurantId: true },
    });
    if (!invoice) throw new NotFoundError('Invoice not found');

    const finance = await getRestaurantFinance(invoice.restaurantId);
    const wallet = finance?.wallet ?? finance?.currentCycle ?? {};
    const walletBalance = Math.max(0, Number(wallet.withdrawableBalance ?? 0));

    return applyWalletDeduction(invoiceId, amount, admin, remarks, { maxDeductible: walletBalance });
}

export async function markInvoicePaidAdmin(invoiceId, amount, admin, remarks) {
    if (!isId(invoiceId)) throw new ValidationError('Invalid invoice id');
    return applyManualPayment(invoiceId, amount, admin, remarks);
}

export async function waiveInvoiceAdmin(invoiceId, admin, remarks) {
    if (!isId(invoiceId)) throw new ValidationError('Invalid invoice id');
    return applyWaiver(invoiceId, admin, remarks);
}

export async function adjustInvoiceAdmin(invoiceId, amount, admin, remarks) {
    if (!isId(invoiceId)) throw new ValidationError('Invalid invoice id');
    return applyAdjustment(invoiceId, amount, admin, remarks);
}

export async function runSubscriptionBillingAdmin(billingMonth) {
    return runMonthlyBilling(String(billingMonth || '').trim(), { generatedBy: 'admin' });
}

/**
 * CSV export of invoices (respects the same filters as the list).
 */
export async function exportSubscriptionInvoicesAdmin(query = {}) {
    const { invoices } = await listHydratedInvoicesAdmin(query, { paginate: false });

    const escapeCsv = (value) => {
        const str = String(value ?? '');
        return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
    };

    const header = [
        'Billing Month', 'Restaurant', 'Owner', 'Phone', 'GMV', 'Orders', 'Plan',
        'Plan Amount', 'GST', 'Total', 'Paid', 'Waived', 'Adjustment', 'Outstanding', 'Status', 'Generated At',
    ];
    const rows = invoices.map((inv) => [
        billingMonthLabel(inv.billingMonth),
        inv.restaurant?.restaurantName || '',
        inv.restaurant?.ownerName || '',
        inv.restaurant?.ownerPhone || '',
        inv.gmv,
        inv.orderCount,
        inv.planName,
        inv.planAmount,
        inv.gstAmount,
        inv.totalAmount,
        inv.paidAmount,
        inv.waivedAmount,
        inv.adjustmentAmount,
        inv.outstandingAmount,
        inv.status,
        inv.createdAt ? new Date(inv.createdAt).toISOString() : '',
    ]);

    return [header, ...rows].map((row) => row.map(escapeCsv).join(',')).join('\n');
}
