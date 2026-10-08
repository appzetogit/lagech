import { prisma } from '../../../../config/prisma.js';
import { NotFoundError, ValidationError } from '../../../../core/auth/errors.js';
import { recordTransaction } from '../../../../core/payments/transaction.service.js';
import { isId } from '../../../../utils/helpers.js';
import { logger } from '../../../../utils/logger.js';
import {
    WALLET_SOURCES,
    createdAtRange,
    istMonthStart,
    toCsv,
    walletSourceOf,
} from '../../shared/customerRewards.util.js';
import {
    getLoyaltySettings,
    serializePointTransaction,
    upsertLoyaltySettings,
} from '../../user/services/loyaltyPoint.service.js';
import { serializeWalletBonus } from '../../user/services/walletBonus.service.js';
import { emailWalletCredited } from '../../../../core/notifications/emailEvents.js';
import {
    validateAddFundDto,
    validateLoyaltySettingsDto,
    validateWalletBonusDto,
} from '../validators/customerExtras.validator.js';

/**
 * Customer-side admin pages the old (6amMart) panel had: wallet add-fund, the
 * wallet report, top-up bonus rules, the loyalty point report and settings,
 * the newsletter list, and the user overview.
 *
 * Money only ever moves through recordTransaction(), the same ledger the
 * customer app's wallet reads, so an admin credit shows there immediately.
 */

const pageOf = (query = {}, max = 100) => {
    const limit = Math.min(max, Math.max(1, Number(query.limit) || 25));
    const page = Math.max(1, Number(query.page) || 1);
    return { page, limit, skip: (page - 1) * limit };
};

const pagination = ({ page, limit }, total) => ({ page, limit, total, pages: Math.ceil(total / limit) });

/** Names and phones for a set of customer ids, keyed by id. */
const customersById = async (ids) => {
    const unique = [...new Set(ids.filter(isId))];
    if (!unique.length) return new Map();
    const users = await prisma.foodUser.findMany({
        where: { id: { in: unique } },
        select: { id: true, name: true, phone: true, email: true },
    });
    return new Map(users.map((u) => [u.id, u]));
};

const customerLabel = (user) => (user ? { id: user.id, name: user.name || '', phone: user.phone, email: user.email || '' } : null);

// ─── Customer search (add-fund picker, report filters) ───────────────────────

export async function searchCustomers({ search = '', limit = 20 } = {}) {
    const q = String(search || '').trim();
    const take = Math.min(50, Math.max(1, Number(limit) || 20));
    const where = q
        ? {
            OR: [
                { name: { contains: q, mode: 'insensitive' } },
                { phone: { contains: q.replace(/\s+/g, '') } },
                { email: { contains: q, mode: 'insensitive' } },
            ],
        }
        : {};
    const users = await prisma.foodUser.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take,
        select: { id: true, name: true, phone: true, email: true },
    });
    const wallets = users.length
        ? await prisma.wallet.findMany({
            where: { entityType: 'user', entityId: { in: users.map((u) => u.id) } },
            select: { entityId: true, balance: true },
        })
        : [];
    const balance = new Map(wallets.map((w) => [w.entityId, Number(w.balance)]));
    return users.map((u) => ({ ...customerLabel(u), walletBalance: balance.get(u.id) ?? 0 }));
}

// ─── Add fund ────────────────────────────────────────────────────────────────

/**
 * Credit a customer's wallet. `requestId` (generated once per form submit)
 * is the idempotency key, so a double click or a retried request credits once.
 * Who did it is stamped on the ledger entry itself.
 */
export async function addFundToCustomer(adminId, body = {}) {
    const dto = validateAddFundDto(body);

    const user = await prisma.foodUser.findUnique({ where: { id: dto.userId }, select: { id: true, name: true, phone: true } });
    if (!user) throw new NotFoundError('Customer not found');

    const admin = isId(adminId)
        ? await prisma.foodAdmin.findUnique({ where: { id: String(adminId) }, select: { id: true, name: true, email: true } })
        : null;
    if (!admin) throw new ValidationError('Your admin account could not be found');

    const { transaction, wallet } = await recordTransaction({
        entityType: 'user',
        entityId: user.id,
        type: 'credit',
        amount: dto.amount,
        description: dto.reference ? `Added by admin: ${dto.reference}` : 'Added by admin',
        category: 'adjustment',
        idempotencyKey: dto.requestId ? `admin_add_fund:${dto.requestId}` : null,
        metadata: {
            source: 'admin_add_fund',
            reference: dto.reference,
            addedById: admin.id,
            addedByName: admin.name || admin.email,
            addedByEmail: admin.email,
        },
    });

    logger.info(`Admin ${admin.id} added ₹${dto.amount} to user ${user.id} wallet (txn ${transaction.id})`);

    try {
        const { notifyOwnerSafely } = await import('../../orders/services/order.helpers.js');
        void notifyOwnerSafely(
            { ownerType: 'USER', ownerId: user.id },
            {
                title: 'Money added to your wallet',
                body: `₹${dto.amount} has been added to your wallet.`,
                data: { type: 'wallet_credited', amount: String(dto.amount) },
            },
        );
    } catch {
        /* a notification failure must not undo the credit */
    }
    // Keyed by the ledger row, which a retried request (same requestId) reuses.
    emailWalletCredited(user.id, transaction.id, dto.amount, wallet.balance);

    return {
        transaction: serializeWalletTransaction(transaction, new Map([[user.id, user]])),
        walletBalance: Number(wallet.balance),
    };
}

// ─── Wallet report ───────────────────────────────────────────────────────────

const serializeWalletTransaction = (row, customers) => {
    const meta = row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
    const source = walletSourceOf(row);
    return {
        id: row.id,
        createdAt: row.createdAt,
        customer: customerLabel(customers.get(row.entityId)) || { id: row.entityId, name: '', phone: '', email: '' },
        type: row.type,
        amount: Number(row.amount),
        balanceAfter: Number(row.balanceAfter),
        source,
        sourceLabel: WALLET_SOURCES[source]?.label || 'Other',
        description: row.description || '',
        reference: meta.reference || '',
        addedBy: meta.addedByName || '',
        orderId: row.orderId || null,
    };
};

const walletReportWhere = (query = {}) => {
    const and = [{ entityType: 'user' }];
    if (query.userId) {
        if (!isId(query.userId)) throw new ValidationError('Invalid customer');
        and.push({ entityId: String(query.userId) });
    }
    if (query.type) {
        if (!['credit', 'debit'].includes(query.type)) throw new ValidationError('Type must be credit or debit');
        and.push({ type: query.type });
    }
    if (query.source) {
        const source = WALLET_SOURCES[query.source];
        if (!source) throw new ValidationError('Unknown source');
        and.push(source.where);
    }
    const createdAt = createdAtRange(query.from, query.to);
    if (createdAt) and.push({ createdAt });
    return { AND: and };
};

/** Wallet ledger entries across customers, filtered, with credit/debit totals. */
export async function listCustomerWalletTransactions(query = {}) {
    const where = walletReportWhere(query);
    const page = pageOf(query);
    const [rows, total, sums] = await Promise.all([
        prisma.transaction.findMany({ where, orderBy: { createdAt: 'desc' }, skip: page.skip, take: page.limit }),
        prisma.transaction.count({ where }),
        prisma.transaction.groupBy({ by: ['type'], where, _sum: { amount: true }, _count: { _all: true } }),
    ]);
    const customers = await customersById(rows.map((r) => r.entityId));
    const sumOf = (type) => sums.find((s) => s.type === type);
    const credit = Number(sumOf('credit')?._sum.amount ?? 0);
    const debit = Number(sumOf('debit')?._sum.amount ?? 0);

    return {
        transactions: rows.map((row) => serializeWalletTransaction(row, customers)),
        totals: {
            credit,
            debit,
            net: Math.round((credit - debit) * 100) / 100,
            creditCount: sumOf('credit')?._count._all ?? 0,
            debitCount: sumOf('debit')?._count._all ?? 0,
        },
        sources: Object.entries(WALLET_SOURCES).map(([key, s]) => ({ key, label: s.label })),
        pagination: pagination(page, total),
    };
}

// ─── Wallet top-up bonus rules ───────────────────────────────────────────────

export async function listWalletBonuses({ search = '' } = {}) {
    const q = String(search || '').trim();
    const rows = await prisma.foodWalletBonus.findMany({
        where: q ? { title: { contains: q, mode: 'insensitive' } } : {},
        orderBy: { createdAt: 'desc' },
    });
    const now = new Date();
    // How often each rule has actually paid out, and how much.
    const paid = rows.length
        ? await prisma.$queryRaw`
            SELECT "metadata"->>'bonusId' AS "bonusId", COUNT(*)::int AS "count", COALESCE(SUM("amount"), 0)::float AS "total"
              FROM "transactions"
             WHERE "entityType" = 'user'::"EntityType" AND "metadata"->>'source' = 'wallet_bonus'
             GROUP BY 1`
        : [];
    const byId = new Map(paid.map((p) => [p.bonusId, p]));
    return rows.map((row) => ({
        ...serializeWalletBonus(row, now),
        timesPaid: byId.get(row.id)?.count ?? 0,
        totalPaid: byId.get(row.id)?.total ?? 0,
    }));
}

export async function createWalletBonus(body) {
    const data = validateWalletBonusDto(body);
    return serializeWalletBonus(await prisma.foodWalletBonus.create({ data }));
}

export async function updateWalletBonus(id, body) {
    if (!isId(id)) throw new NotFoundError('Bonus not found');
    const existing = await prisma.foodWalletBonus.findUnique({ where: { id: String(id) } });
    if (!existing) throw new NotFoundError('Bonus not found');
    // A status toggle sends only isActive; anything else is a full edit.
    const onlyToggle = Object.keys(body || {}).every((k) => k === 'isActive');
    const data = onlyToggle
        ? { isActive: Boolean(body.isActive) }
        : validateWalletBonusDto(body);
    return serializeWalletBonus(await prisma.foodWalletBonus.update({ where: { id: existing.id }, data }));
}

export async function deleteWalletBonus(id) {
    if (!isId(id)) throw new NotFoundError('Bonus not found');
    // Bonuses already paid stay in the ledger; their metadata keeps the title.
    const { count } = await prisma.foodWalletBonus.deleteMany({ where: { id: String(id) } });
    if (!count) throw new NotFoundError('Bonus not found');
    return { deleted: true };
}

// ─── Loyalty points ──────────────────────────────────────────────────────────

export { getLoyaltySettings };

export async function saveLoyaltySettings(body) {
    return upsertLoyaltySettings(validateLoyaltySettingsDto(body));
}

/** The points ledger across customers, filtered, with totals. */
export async function listLoyaltyPointTransactions(query = {}) {
    const where = {};
    if (query.userId) {
        if (!isId(query.userId)) throw new ValidationError('Invalid customer');
        where.userId = String(query.userId);
    }
    if (query.type) {
        if (!['credit', 'debit'].includes(query.type)) throw new ValidationError('Type must be credit or debit');
        where.type = query.type;
    }
    const createdAt = createdAtRange(query.from, query.to);
    if (createdAt) where.createdAt = createdAt;

    const page = pageOf(query);
    const [rows, total, sums, outstanding] = await Promise.all([
        prisma.foodLoyaltyPointTransaction.findMany({ where, orderBy: { createdAt: 'desc' }, skip: page.skip, take: page.limit }),
        prisma.foodLoyaltyPointTransaction.count({ where }),
        prisma.foodLoyaltyPointTransaction.groupBy({ by: ['type'], where, _sum: { points: true, walletAmount: true } }),
        prisma.foodLoyaltyPointAccount.aggregate({ _sum: { points: true } }),
    ]);
    const customers = await customersById(rows.map((r) => r.userId));
    const sumOf = (type) => sums.find((s) => s.type === type)?._sum;

    return {
        transactions: rows.map((row) => ({
            ...serializePointTransaction(row),
            customer: customerLabel(customers.get(row.userId)) || { id: row.userId, name: '', phone: '', email: '' },
        })),
        totals: {
            earned: sumOf('credit')?.points ?? 0,
            converted: sumOf('debit')?.points ?? 0,
            walletPaid: Number(sumOf('debit')?.walletAmount ?? 0),
            // Not filtered: what every customer holds right now.
            outstanding: outstanding._sum.points ?? 0,
        },
        settings: await getLoyaltySettings(),
        pagination: pagination(page, total),
    };
}

// ─── Newsletter subscribers ──────────────────────────────────────────────────

const subscriberWhere = (search) => {
    const q = String(search || '').trim();
    return q ? { email: { contains: q, mode: 'insensitive' } } : {};
};

export async function listNewsletterSubscribers(query = {}) {
    const where = subscriberWhere(query.search);
    const page = pageOf(query);
    const [rows, total] = await Promise.all([
        prisma.foodNewsletterSubscriber.findMany({ where, orderBy: { createdAt: 'desc' }, skip: page.skip, take: page.limit }),
        prisma.foodNewsletterSubscriber.count({ where }),
    ]);
    return {
        subscribers: rows.map((r) => ({ id: r.id, email: r.email, createdAt: r.createdAt })),
        pagination: pagination(page, total),
    };
}

/** Every subscriber matching the search, as CSV. */
export async function exportNewsletterSubscribersCsv(query = {}) {
    const rows = await prisma.foodNewsletterSubscriber.findMany({
        where: subscriberWhere(query.search),
        orderBy: { createdAt: 'desc' },
        select: { email: true, createdAt: true },
    });
    return toCsv(['Email', 'Subscribed at'], rows.map((r) => [r.email, r.createdAt.toISOString()]));
}

export async function deleteNewsletterSubscriber(id) {
    if (!isId(id)) throw new NotFoundError('Subscriber not found');
    const { count } = await prisma.foodNewsletterSubscriber.deleteMany({ where: { id: String(id) } });
    if (!count) throw new NotFoundError('Subscriber not found');
    return { deleted: true };
}

// ─── User overview ───────────────────────────────────────────────────────────

const MONTHS = 6;

/** The last `MONTHS` months as 'YYYY-MM' (IST), oldest first. */
const recentMonths = (now = new Date()) => {
    const start = istMonthStart(now);
    const ist = new Date(start.getTime() + 330 * 60000);
    const out = [];
    for (let i = MONTHS - 1; i >= 0; i -= 1) {
        const d = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth() - i, 1));
        out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
    }
    return out;
};

const monthlySeries = (months, rows) => {
    const byMonth = new Map(rows.map((r) => [r.month, Number(r.count)]));
    return months.map((month) => ({ month, count: byMonth.get(month) ?? 0 }));
};

/** Counts and trends for customers, riders and employees. */
export async function getUserOverview(now = new Date()) {
    const monthStart = istMonthStart(now);
    const since30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const months = recentMonths(now);
    const seriesStart = new Date(`${months[0]}-01T00:00:00.000+05:30`);

    const [
        customersTotal,
        customersBlocked,
        customersNew,
        [{ count: customersOrdering }],
        customerSignups,
        ridersByStatus,
        ridersOnline,
        riderSignups,
        employeesTotal,
        employeesActive,
    ] = await Promise.all([
        prisma.foodUser.count(),
        prisma.foodUser.count({ where: { isActive: false } }),
        prisma.foodUser.count({ where: { createdAt: { gte: monthStart } } }),
        prisma.$queryRaw`SELECT COUNT(DISTINCT "userId")::int AS "count" FROM "food_orders" WHERE "createdAt" >= ${since30}`,
        prisma.$queryRaw`
            SELECT to_char(("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM') AS "month", COUNT(*)::int AS "count"
              FROM "food_users" WHERE "createdAt" >= ${seriesStart} GROUP BY 1`,
        prisma.foodDeliveryPartner.groupBy({ by: ['status'], _count: { _all: true } }),
        prisma.foodDeliveryPartner.count({ where: { status: 'approved', availabilityStatus: 'online' } }),
        prisma.$queryRaw`
            SELECT to_char(("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM') AS "month", COUNT(*)::int AS "count"
              FROM "food_delivery_partners" WHERE "createdAt" >= ${seriesStart} GROUP BY 1`,
        prisma.foodAdmin.count({ where: { adminType: 'sub_admin', isDeleted: false } }),
        prisma.foodAdmin.count({ where: { adminType: 'sub_admin', isDeleted: false, isActive: true } }),
    ]);

    const riderCount = (status) => ridersByStatus.find((r) => r.status === status)?._count._all ?? 0;
    const ridersTotal = ridersByStatus.reduce((sum, r) => sum + r._count._all, 0);

    return {
        customers: {
            total: customersTotal,
            active: customersTotal - customersBlocked,
            blocked: customersBlocked,
            newThisMonth: customersNew,
            orderedLast30Days: Number(customersOrdering) || 0,
            signupsByMonth: monthlySeries(months, customerSignups),
        },
        riders: {
            total: ridersTotal,
            approved: riderCount('approved'),
            pending: riderCount('pending'),
            rejected: riderCount('rejected'),
            deactivated: riderCount('deactivated'),
            onlineNow: ridersOnline,
            signupsByMonth: monthlySeries(months, riderSignups),
        },
        employees: {
            total: employeesTotal,
            active: employeesActive,
            inactive: employeesTotal - employeesActive,
        },
        generatedAt: now,
    };
}
