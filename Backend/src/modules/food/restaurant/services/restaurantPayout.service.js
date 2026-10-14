import { Prisma } from '@prisma/client';
import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { ValidationError } from '../../../../core/auth/errors.js';
import { logger } from '../../../../utils/logger.js';
import { getWalletSummaries } from './restaurantFinance.service.js';
import { getPayoutSnapshots } from '../../admin/services/withdrawalMethods.service.js';
import { emailWithdrawalDecision } from '../../../../core/notifications/emailEvents.js';

/**
 * Automatic restaurant payouts, run the way the previous system ran them.
 *
 * Once a day (or once a week, or on the 1st of the month -- the old panel's
 * "disbursement time period") the job works out what each approved restaurant
 * is owed and writes one payout line per restaurant into a batch. Nothing is
 * transferred: the admin pays each line by bank transfer or UPI and marks it
 * paid, or cancels it. A line is an ordinary withdrawal with source
 * 'disbursement', so a pending line already counts against the restaurant's
 * balance -- the same money cannot also be asked for by hand -- and a
 * cancelled one gives it back.
 *
 * What is owed holds back recent earnings: only orders placed before the
 * cut-off (the start of today in India, less the waiting days) count, so an
 * order refunded or cancelled the day after is settled before money leaves.
 *
 * Restaurants can still ask for a payout themselves in between.
 */

const IST_OFFSET_MINUTES = 330;
const DAY_MS = 24 * 60 * 60 * 1000;

const money = (value) => Math.round((Number(value) || 0) * 100) / 100;

export const PAYOUT_FREQUENCIES = ['daily', 'weekly', 'monthly'];
export const PAYOUT_METHODS = ['bank', 'upi'];

const DEFAULT_SETTINGS = {
    isEnabled: true,
    frequency: 'daily',
    weekday: 6,
    runTime: '03:05',
    waitingDays: 1,
    minAmount: 1,
};

const serializeSettings = (row) => ({
    ...DEFAULT_SETTINGS,
    ...(row || {}),
    minAmount: Number(row?.minAmount ?? DEFAULT_SETTINGS.minAmount),
});

export async function getPayoutSettings() {
    const row = await prisma.foodRestaurantPayoutSettings.findFirst({ orderBy: { createdAt: 'asc' } });
    return serializeSettings(row);
}

export async function updatePayoutSettings(body = {}) {
    const data = {};
    if (body.isEnabled !== undefined) data.isEnabled = body.isEnabled === true || body.isEnabled === 'true';
    if (body.frequency !== undefined) {
        if (!PAYOUT_FREQUENCIES.includes(body.frequency)) throw new ValidationError('Frequency must be daily, weekly or monthly');
        data.frequency = body.frequency;
    }
    if (body.weekday !== undefined) {
        const day = Number(body.weekday);
        if (!Number.isInteger(day) || day < 0 || day > 6) throw new ValidationError('Weekday must be 0 (Sunday) to 6 (Saturday)');
        data.weekday = day;
    }
    if (body.runTime !== undefined) {
        const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(body.runTime));
        if (!match) throw new ValidationError('Run time must be HH:MM, 24-hour');
        data.runTime = String(body.runTime);
    }
    if (body.waitingDays !== undefined) {
        const days = Number(body.waitingDays);
        if (!Number.isInteger(days) || days < 0 || days > 30) throw new ValidationError('Waiting days must be 0 to 30');
        data.waitingDays = days;
    }
    if (body.minAmount !== undefined) {
        const amount = Number(body.minAmount);
        if (!Number.isFinite(amount) || amount < 1 || amount > 1000000) {
            throw new ValidationError('Minimum payout must be between ₹1 and ₹10,00,000');
        }
        data.minAmount = money(amount);
    }

    const existing = await prisma.foodRestaurantPayoutSettings.findFirst({ orderBy: { createdAt: 'asc' } });
    const saved = existing
        ? await prisma.foodRestaurantPayoutSettings.update({ where: { id: existing.id }, data })
        : await prisma.foodRestaurantPayoutSettings.create({ data });
    return serializeSettings(saved);
}

/** The calendar day, weekday and minutes past midnight in India for a moment. */
export function istClock(now = new Date()) {
    const shifted = new Date(now.getTime() + IST_OFFSET_MINUTES * 60 * 1000);
    const runDate = shifted.toISOString().slice(0, 10);
    return {
        runDate,
        weekday: shifted.getUTCDay(),
        monthDay: shifted.getUTCDate(),
        minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
        // Midnight at the start of that Indian day, as a real instant.
        startOfDay: new Date(Date.parse(`${runDate}T00:00:00.000Z`) - IST_OFFSET_MINUTES * 60 * 1000),
    };
}

/**
 * Whether a scheduled run is due now. Pure, so the timing rules are testable.
 * Only whether it is due -- whether it already ran today is the batch table's
 * unique runDate, which no clock arithmetic can race.
 */
export function isPayoutDue(settings, now = new Date()) {
    if (!settings.isEnabled) return false;
    const clock = istClock(now);
    if (settings.frequency === 'weekly' && clock.weekday !== settings.weekday) return false;
    // Monthly runs on the 1st, as the old panel's cron line did ("M H 1 * *").
    if (settings.frequency === 'monthly' && clock.monthDay !== 1) return false;
    const [hours, minutes] = String(settings.runTime).split(':').map(Number);
    return clock.minutes >= hours * 60 + minutes;
}

/** Orders placed before this count toward the run on this day. */
export function payoutCutoff(settings, now = new Date()) {
    return new Date(istClock(now).startOfDay.getTime() - Math.max(0, settings.waitingDays) * DAY_MS);
}

/**
 * Where a restaurant's payout goes, and a snapshot of the details, or null
 * when it has neither a complete bank account nor a UPI id. The snapshot is
 * what the admin pays to, even if the restaurant edits its details later.
 */
export function resolvePayee(restaurant) {
    const bank = restaurant.accountNumber && restaurant.ifscCode
        ? {
            paymentMethod: 'bank_transfer',
            bankDetails: {
                accountHolderName: restaurant.accountHolderName || '',
                accountNumber: restaurant.accountNumber,
                ifscCode: restaurant.ifscCode,
                accountType: restaurant.accountType || '',
            },
        }
        : null;
    const upi = restaurant.upiId
        ? { paymentMethod: 'upi', bankDetails: { upiId: restaurant.upiId, upiQrImage: restaurant.upiQrImage || '' } }
        : null;
    if (restaurant.payoutMethod === 'upi') return upi || bank;
    return bank || upi;
}

/**
 * Add the payee's chosen payout method to a resolved payee, or use the method
 * alone when there is no bank account or UPI id. Null when there is neither.
 */
export function withPayoutMethod(payee, snapshot) {
    if (!snapshot) return payee;
    if (payee) return { ...payee, bankDetails: { ...payee.bankDetails, payoutMethod: snapshot } };
    return {
        paymentMethod: String(snapshot.methodName || 'payout_method').slice(0, 60),
        bankDetails: { payoutMethod: snapshot },
    };
}

const PAYEE_SELECT = {
    id: true, restaurantName: true, payoutMethod: true,
    accountHolderName: true, accountNumber: true, ifscCode: true, accountType: true,
    upiId: true, upiQrImage: true,
};

/** Serialises writes against one restaurant's balance, in the caller's transaction. */
export const lockRestaurantBalance = (tx, restaurantId) =>
    tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`restaurant-balance:${restaurantId}`}))`;

/**
 * Create today's payout batch, if one is due and has not been made.
 *
 * @param {object} options
 * @param {Date} [options.now]
 * @param {boolean} [options.force] an admin running it by hand: ignores the
 *   time, weekday and on/off switch, but still once per day
 * @param {string} [options.triggeredBy]
 * @returns {Promise<{ created: boolean, reason?: string, batch?: object }>}
 */
export async function generateRestaurantPayouts({ now = new Date(), force = false, triggeredBy = 'schedule' } = {}) {
    const settings = await getPayoutSettings();
    if (!force && !isPayoutDue(settings, now)) return { created: false, reason: 'not due' };

    const { runDate } = istClock(now);
    const cutoffAt = payoutCutoff(settings, now);

    // Claim the day. The unique runDate means a second scheduler, a restart or
    // an admin clicking twice all lose here instead of paying twice.
    let batch;
    try {
        batch = await prisma.foodRestaurantPayoutBatch.create({
            data: { runDate, cutoffAt, triggeredBy: String(triggeredBy).slice(0, 32) },
        });
    } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
            return { created: false, reason: `a payout batch for ${runDate} already exists` };
        }
        throw error;
    }

    const restaurants = await prisma.foodRestaurant.findMany({
        where: { status: 'approved' },
        select: PAYEE_SELECT,
        orderBy: { createdAt: 'asc' },
    });

    const minAmount = Math.max(1, Number(settings.minAmount) || 1);
    const skipped = [];
    let total = 0;
    let count = 0;

    for (let i = 0; i < restaurants.length; i += 100) {
        const page = restaurants.slice(i, i + 100);
        const summaries = await getWalletSummaries(page.map((r) => r.id), { earnedBefore: cutoffAt });
        // The payout method each restaurant chose, if any: the fallback when
        // it has no bank account or UPI id, and shown to the admin either way.
        const methods = await getPayoutSnapshots('restaurant', page.map((r) => r.id)).catch(() => new Map());

        for (const restaurant of page) {
            const owed = money(summaries.get(restaurant.id)?.availableBeforeCutoff);
            if (owed < minAmount) continue;

            const payee = withPayoutMethod(resolvePayee(restaurant), methods.get(restaurant.id));
            if (!payee) {
                skipped.push({
                    restaurantId: restaurant.id,
                    name: restaurant.restaurantName,
                    amount: owed,
                    reason: 'No bank account, UPI id or payout method on file',
                });
                continue;
            }

            try {
                const amount = await prisma.$transaction(async (tx) => {
                    // Re-checked under the lock: a manual request made since the
                    // page summary above must not be paid a second time here.
                    await lockRestaurantBalance(tx, restaurant.id);
                    const fresh = await getWalletSummaries([restaurant.id], { db: tx, earnedBefore: cutoffAt });
                    const value = money(fresh.get(restaurant.id)?.availableBeforeCutoff);
                    if (value < minAmount) return 0;
                    await tx.foodRestaurantWithdrawal.create({
                        data: {
                            restaurantId: restaurant.id,
                            amount: value,
                            status: 'pending',
                            source: 'disbursement',
                            batchId: batch.id,
                            paymentMethod: payee.paymentMethod,
                            bankDetails: payee.bankDetails,
                        },
                    });
                    return value;
                }, { timeout: 20000 });
                if (amount > 0) {
                    total = money(total + amount);
                    count += 1;
                }
            } catch (error) {
                // One restaurant's bad data must not stop everyone else's payout.
                logger.error(`[PAYOUTS] ${runDate} restaurant ${restaurant.id}: ${error?.message || error}`);
                skipped.push({ restaurantId: restaurant.id, name: restaurant.restaurantName, amount: owed, reason: 'Error while creating the payout' });
            }
        }
    }

    batch = await prisma.foodRestaurantPayoutBatch.update({
        where: { id: batch.id },
        data: {
            totalAmount: total,
            restaurantCount: count,
            skipped,
            // A run that found nobody owed anything has nothing left to do.
            status: count > 0 ? 'pending' : 'completed',
        },
    });

    logger.info(`[PAYOUTS] ${runDate}: ${count} restaurant(s), ₹${total}, ${skipped.length} skipped`);
    return { created: true, batch: serializeBatch(batch) };
}

/** The batch status that its lines add up to. */
export function batchStatusFor(statuses) {
    if (!statuses.length) return 'completed';
    if (statuses.every((s) => s === 'approved')) return 'completed';
    if (statuses.every((s) => s === 'rejected')) return 'canceled';
    if (statuses.every((s) => s === 'pending')) return 'pending';
    return 'partially_completed';
}

/** Bring a batch's status in line with its lines, after one of them changed. */
export async function syncBatchStatus(batchId, db = prisma) {
    if (!batchId) return;
    const lines = await db.foodRestaurantWithdrawal.findMany({ where: { batchId }, select: { status: true } });
    await db.foodRestaurantPayoutBatch.update({
        where: { id: batchId },
        data: { status: batchStatusFor(lines.map((l) => l.status)) },
    });
}

/** The old panel's words for a line: completed / canceled rather than approved / rejected. */
export const LINE_STATUS_WORDS = { pending: 'pending', approved: 'completed', rejected: 'canceled' };
const LINE_STATUS_FROM_WORD = { pending: 'pending', completed: 'approved', approved: 'approved', canceled: 'rejected', rejected: 'rejected' };
export const BATCH_STATUSES = ['pending', 'partially_completed', 'completed', 'canceled'];

const serializeBatch = (b) => ({
    ...b,
    // "Disbursement # 1117" in the old panel. A batch brought over from it
    // keeps its old number.
    title: `Disbursement #${b.legacyNumber ?? b.number}`,
    isLegacy: b.legacyNumber !== null && b.legacyNumber !== undefined,
    totalAmount: Number(b.totalAmount),
});

/** An Indian calendar day 'YYYY-MM-DD' -> the instant it starts, or null. */
export function istDayStart(value) {
    const text = String(value || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
    const time = Date.parse(`${text}T00:00:00.000Z`);
    if (Number.isNaN(time)) return null;
    return new Date(time - IST_OFFSET_MINUTES * 60 * 1000);
}

/** createdAt between two Indian calendar days, both included. */
const createdBetween = (from, to) => {
    const start = istDayStart(from);
    const end = istDayStart(to);
    if (!start && !end) return null;
    return { ...(start ? { gte: start } : {}), ...(end ? { lt: new Date(end.getTime() + DAY_MS) } : {}) };
};

/** The batch filter of the list page: status tab, date range, "#number" search. */
export function batchListWhere(query = {}) {
    // Runs that found nobody to pay are kept (they mark the day as done) but
    // are noise in the list.
    const where = { restaurantCount: { gt: 0 } };
    if (query.status && query.status !== 'all') {
        if (!BATCH_STATUSES.includes(String(query.status))) throw new ValidationError('Unknown disbursement status');
        where.status = String(query.status);
    }
    const created = createdBetween(query.from, query.to);
    if (created) where.createdAt = created;
    const search = String(query.search || '').replace(/^#/, '').trim();
    if (search) {
        const number = /^\d{1,9}$/.test(search) ? Number(search) : -1;
        // A batch brought over is known by its old number only; its own
        // `number` is never shown.
        where.OR = [{ number, legacyNumber: null }, { legacyNumber: number }];
    }
    return where;
}

/** groupBy on status -> { pending, completed, canceled }, each { count, amount }. */
export const statusTotals = (groups) => {
    const out = {
        pending: { count: 0, amount: 0 },
        completed: { count: 0, amount: 0 },
        canceled: { count: 0, amount: 0 },
    };
    for (const g of groups) {
        const key = LINE_STATUS_WORDS[g.status];
        if (!key) continue;
        out[key].count += g._count?._all || 0;
        out[key].amount = money(out[key].amount + Number(g._sum?.amount || 0));
    }
    return out;
};

export async function listPayoutBatches(query = {}) {
    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 20, 1), 100);
    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    const where = batchListWhere(query);

    const [rows, total, overall, lineTotals] = await Promise.all([
        prisma.foodRestaurantPayoutBatch.findMany({
            where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit,
        }),
        prisma.foodRestaurantPayoutBatch.count({ where }),
        prisma.foodRestaurantPayoutBatch.aggregate({ where, _sum: { totalAmount: true } }),
        // Across every batch the filters match, not just this page: the
        // cards above the list.
        prisma.foodRestaurantWithdrawal.groupBy({
            by: ['status'],
            where: { batch: { is: where } },
            _sum: { amount: true },
            _count: { _all: true },
        }),
    ]);

    // Paid / waiting / cancelled per batch, so the list shows progress
    // without opening each.
    const perBatch = rows.length
        ? await prisma.foodRestaurantWithdrawal.groupBy({
            by: ['batchId', 'status'],
            where: { batchId: { in: rows.map((r) => r.id) } },
            _sum: { amount: true },
            _count: { _all: true },
        })
        : [];
    const byBatch = new Map();
    for (const g of perBatch) byBatch.set(g.batchId, [...(byBatch.get(g.batchId) || []), g]);

    return {
        batches: rows.map((b) => {
            const lines = statusTotals(byBatch.get(b.id) || []);
            return {
                ...serializeBatch(b),
                paidAmount: lines.completed.amount,
                pendingAmount: lines.pending.amount,
                canceledAmount: lines.canceled.amount,
                lines,
            };
        }),
        summary: {
            count: total,
            totalAmount: money(overall._sum.totalAmount),
            ...statusTotals(lineTotals),
        },
        pagination: { total, page, limit, pages: Math.ceil(total / limit) || 1 },
    };
}

/** One line as the pages show it, with the old panel's status word beside ours. */
const lineOut = (w) => ({
    id: w.id,
    restaurantId: w.restaurantId,
    restaurantName: w.restaurant?.restaurantName || 'N/A',
    ownerName: w.restaurant?.ownerName || '',
    ownerPhone: w.restaurant?.ownerPhone || '',
    amount: Number(w.amount),
    status: w.status,
    disbursementStatus: LINE_STATUS_WORDS[w.status] || w.status,
    paymentMethod: w.paymentMethod,
    bankDetails: w.bankDetails || {},
    transactionId: w.transactionId || '',
    adminNote: w.adminNote || '',
    rejectionReason: w.rejectionReason || '',
    createdAt: w.createdAt,
    processedAt: w.processedAt,
});

export async function getPayoutBatch(batchId, query = {}) {
    if (!isId(batchId)) throw new ValidationError('Invalid payout batch');
    const batch = await prisma.foodRestaurantPayoutBatch.findUnique({ where: { id: String(batchId) } });
    if (!batch) throw new ValidationError('Payout batch not found');

    const where = { batchId: batch.id };
    if (query.status && query.status !== 'all') {
        const status = LINE_STATUS_FROM_WORD[String(query.status)];
        if (!status) throw new ValidationError('Unknown disbursement status');
        where.status = status;
    }
    const search = String(query.search || '').trim();
    if (search) where.restaurant = { restaurantName: { contains: search, mode: 'insensitive' } };

    const [lines, groups] = await Promise.all([
        prisma.foodRestaurantWithdrawal.findMany({
            where,
            orderBy: { amount: 'desc' },
            include: { restaurant: { select: { id: true, restaurantName: true, ownerName: true, ownerPhone: true } } },
        }),
        prisma.foodRestaurantWithdrawal.groupBy({
            by: ['status'],
            where: { batchId: batch.id },
            _sum: { amount: true },
            _count: { _all: true },
        }),
    ]);

    return {
        batch: serializeBatch(batch),
        // Over every line of the batch, whatever the filter.
        summary: statusTotals(groups),
        payouts: lines.map(lineOut),
    };
}

/**
 * A restaurant's own disbursement lines (the old store panel's "Disbursement"
 * page): every payout the runs created for it, newest first, with the run's
 * number and where it was paid.
 */
export async function listRestaurantDisbursements(restaurantId, query = {}) {
    if (!isId(restaurantId)) throw new ValidationError('Invalid restaurant');
    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 20, 1), 100);
    const page = Math.max(parseInt(query.page, 10) || 1, 1);

    const scope = { restaurantId: String(restaurantId), source: 'disbursement' };
    const where = { ...scope };
    if (query.status && query.status !== 'all') {
        const status = LINE_STATUS_FROM_WORD[String(query.status)];
        if (!status) throw new ValidationError('Unknown disbursement status');
        where.status = status;
    }
    const created = createdBetween(query.from, query.to);
    if (created) where.createdAt = created;

    const [rows, total, groups] = await Promise.all([
        prisma.foodRestaurantWithdrawal.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            skip: (page - 1) * limit,
            take: limit,
            include: { batch: { select: { id: true, number: true, legacyNumber: true } } },
        }),
        prisma.foodRestaurantWithdrawal.count({ where }),
        prisma.foodRestaurantWithdrawal.groupBy({
            by: ['status'],
            where: scope,
            _sum: { amount: true },
            _count: { _all: true },
        }),
    ]);

    return {
        disbursements: rows.map((w) => {
            const { restaurantName, ownerName, ownerPhone, ...line } = lineOut(w);
            return {
                ...line,
                batchId: w.batchId,
                title: w.batch ? `Disbursement #${w.batch.legacyNumber ?? w.batch.number}` : 'Disbursement',
            };
        }),
        // Over all of this restaurant's lines, whatever the filter.
        summary: statusTotals(groups),
        pagination: { total, page, limit, pages: Math.ceil(total / limit) || 1 },
    };
}

/**
 * Mark several lines of one batch paid or cancelled at once, as the old
 * panel's checkboxes did. Each line is claimed only if still pending, so a
 * line someone else decided in the meantime is reported, not overwritten.
 */
export async function decidePayouts(batchId, { ids = [], status: asked, transactionId, adminNote } = {}) {
    if (!isId(batchId)) throw new ValidationError('Invalid payout batch');
    // 'completed' / 'canceled' as the old panel said them, or ours.
    const status = LINE_STATUS_FROM_WORD[String(asked || '')];
    if (!['approved', 'rejected'].includes(status)) throw new ValidationError('Status must be completed (paid) or canceled');
    const wanted = [...new Set((Array.isArray(ids) ? ids : []).map(String))].filter(isId);
    if (!wanted.length) throw new ValidationError('Select at least one payout');

    const decidedAt = new Date();
    const result = await prisma.$transaction(async (tx) => {
        const { count } = await tx.foodRestaurantWithdrawal.updateMany({
            where: { id: { in: wanted }, batchId: String(batchId), status: 'pending' },
            data: {
                status,
                processedAt: decidedAt,
                ...(transactionId ? { transactionId: String(transactionId).trim().slice(0, 120) } : {}),
                ...(adminNote ? { adminNote: String(adminNote).trim().slice(0, 500) } : {}),
            },
        });
        await syncBatchStatus(String(batchId), tx);
        return count;
    });
    // Keyed per withdrawal: a line already emailed is not emailed again.
    if (result) emailWithdrawalDecision('restaurant', wanted, { processedAt: decidedAt });

    return { updated: result, notPending: wanted.length - result };
}
