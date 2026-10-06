import { randomUUID } from 'node:crypto';
import { prisma } from '../../../../config/prisma.js';
import { ValidationError } from '../../../../core/auth/errors.js';
import { recordTransaction } from '../../../../core/payments/transaction.service.js';
import { isId } from '../../../../utils/helpers.js';
import { logger } from '../../../../utils/logger.js';
import {
    conversionProblem,
    pointsForOrder,
    round2,
    walletAmountForPoints,
} from '../../shared/customerRewards.util.js';
import { getUserWallet } from './userWallet.service.js';

/**
 * Loyalty points (the old panel's Customer Loyalty Point).
 *
 * Customers earn points on every delivered order and convert them into wallet
 * balance. Points live in their own ledger (food_loyalty_point_transactions)
 * with a per-customer balance row whose decrement is guarded in the WHERE
 * clause, so two conversions racing cannot spend the same points twice. A
 * conversion pays out through recordTransaction() in the same database
 * transaction: the points leave and the rupees arrive together, or neither does.
 */

const DEFAULT_SETTINGS = Object.freeze({
    isEnabled: false,
    pointsPerHundred: 0,
    pointsPerRupee: 0,
    minimumConvertPoints: 0,
});

const serializeSettings = (row) =>
    row
        ? {
            id: row.id,
            isEnabled: Boolean(row.isEnabled),
            pointsPerHundred: Number(row.pointsPerHundred),
            pointsPerRupee: Number(row.pointsPerRupee),
            minimumConvertPoints: Number(row.minimumConvertPoints),
            updatedAt: row.updatedAt,
        }
        : { ...DEFAULT_SETTINGS };

/** The one settings row, or the switched-off defaults when none was saved yet. */
export const getLoyaltySettings = async () =>
    serializeSettings(await prisma.foodLoyaltySettings.findFirst({ orderBy: { createdAt: 'desc' } }));

/** Saves the settings row, edited in place. Input is already validated. */
export const upsertLoyaltySettings = async (data) => {
    const existing = await prisma.foodLoyaltySettings.findFirst({ orderBy: { createdAt: 'desc' }, select: { id: true } });
    const row = existing
        ? await prisma.foodLoyaltySettings.update({ where: { id: existing.id }, data })
        : await prisma.foodLoyaltySettings.create({ data });
    return serializeSettings(row);
};

export const serializePointTransaction = (row) => ({
    id: row.id,
    userId: row.userId,
    type: row.type,
    points: row.points,
    balanceAfter: row.balanceAfter,
    source: row.source,
    orderId: row.orderId,
    walletAmount: Number(row.walletAmount),
    note: row.note,
    createdAt: row.createdAt,
});

/** Creates the customer's balance row at zero if missing. Safe under concurrency. */
const ensureAccount = (tx, userId) => tx.$executeRaw`
    INSERT INTO "food_loyalty_point_accounts" ("userId", "points", "totalEarned", "totalConverted", "createdAt", "updatedAt")
    VALUES (${userId}, 0, 0, 0, now(), now())
    ON CONFLICT ("userId") DO NOTHING
`;

/** The customer's points, what they are worth, the rules, and recent history. */
export const getMyLoyaltyPoints = async (userId, { page = 1, limit = 20 } = {}) => {
    const id = String(userId || '');
    if (!isId(id)) throw new ValidationError('User not found');
    const take = Math.min(100, Math.max(1, Number(limit) || 20));
    const current = Math.max(1, Number(page) || 1);

    const [settings, account, rows, total] = await Promise.all([
        getLoyaltySettings(),
        prisma.foodLoyaltyPointAccount.findUnique({ where: { userId: id } }),
        prisma.foodLoyaltyPointTransaction.findMany({
            where: { userId: id },
            orderBy: { createdAt: 'desc' },
            skip: (current - 1) * take,
            take,
        }),
        prisma.foodLoyaltyPointTransaction.count({ where: { userId: id } }),
    ]);

    const points = account?.points || 0;
    return {
        enabled: settings.isEnabled,
        points,
        worth: walletAmountForPoints(settings, points),
        totalEarned: account?.totalEarned || 0,
        totalConverted: account?.totalConverted || 0,
        settings: {
            pointsPerHundred: settings.pointsPerHundred,
            pointsPerRupee: settings.pointsPerRupee,
            minimumConvertPoints: settings.minimumConvertPoints,
        },
        transactions: rows.map(serializePointTransaction),
        pagination: { page: current, limit: take, total, pages: Math.ceil(total / take) },
    };
};

/**
 * Convert points into wallet balance.
 *
 * `requestId` (any string the app generates once per tap) makes a retried or
 * double-tapped request a no-op; without one every call is a new conversion.
 */
export const convertLoyaltyPoints = async (userId, body = {}) => {
    const id = String(userId || '');
    if (!isId(id)) throw new ValidationError('User not found');

    const points = Number(body.points);
    const requestId = String(body.requestId || '').trim().slice(0, 64) || randomUUID();
    const idempotencyKey = `loyalty_convert:${id}:${requestId}`;

    const replay = await prisma.foodLoyaltyPointTransaction.findUnique({ where: { idempotencyKey } });
    if (!replay) {
        const [settings, account] = await Promise.all([
            getLoyaltySettings(),
            prisma.foodLoyaltyPointAccount.findUnique({ where: { userId: id } }),
        ]);
        const problem = conversionProblem(settings, points, account?.points || 0);
        if (problem) throw new ValidationError(problem);
        const walletAmount = walletAmountForPoints(settings, points);

        try {
            await prisma.$transaction(async (tx) => {
                // The guard is the WHERE clause: a concurrent conversion that got
                // there first leaves too few points and this matches nothing.
                const { count } = await tx.foodLoyaltyPointAccount.updateMany({
                    where: { userId: id, points: { gte: points } },
                    data: { points: { decrement: points }, totalConverted: { increment: points } },
                });
                if (count === 0) throw new ValidationError('You do not have that many points');

                const after = await tx.foodLoyaltyPointAccount.findUniqueOrThrow({ where: { userId: id } });
                const row = await tx.foodLoyaltyPointTransaction.create({
                    data: {
                        userId: id,
                        type: 'debit',
                        points,
                        balanceAfter: after.points,
                        source: 'conversion',
                        walletAmount,
                        note: `Converted to ₹${round2(walletAmount).toFixed(2)} wallet balance`,
                        idempotencyKey,
                    },
                });

                await recordTransaction({
                    entityType: 'user',
                    entityId: id,
                    type: 'credit',
                    amount: walletAmount,
                    description: `Loyalty points converted (${points} points)`,
                    category: 'adjustment',
                    idempotencyKey: `loyalty_conversion:${row.id}`,
                    metadata: { source: 'loyalty_conversion', points, loyaltyTransactionId: row.id },
                }, { client: tx });
            });
        } catch (error) {
            // The same request arriving twice at once: the second insert hits the
            // unique key and rolls back, the first one stands.
            if (error?.code !== 'P2002') throw error;
        }
    }

    const [loyalty, wallet] = await Promise.all([getMyLoyaltyPoints(id), getUserWallet(id)]);
    return { ...loyalty, wallet };
};

/**
 * Take back the points an order earned, when the order is refunded.
 *
 * Idempotent per order (`loyalty_reverse:<orderId>` is unique); never takes the
 * balance below zero -- points already converted to wallet money stay spent, and
 * only what is left is deducted. An order that earned nothing changes nothing.
 * Never throws: a points problem must not undo a refund that already happened.
 */
export const reverseOrderLoyaltyPoints = async (orderId) => {
    try {
        if (!isId(orderId)) return { reversed: false, reason: 'invalid_order' };
        const id = String(orderId);
        const earned = await prisma.foodLoyaltyPointTransaction.findUnique({
            where: { idempotencyKey: `loyalty_earn:${id}` },
        });
        if (!earned || earned.points <= 0) return { reversed: false, reason: 'nothing_earned' };

        const idempotencyKey = `loyalty_reverse:${id}`;
        const row = await prisma.$transaction(async (tx) => {
            const already = await tx.foodLoyaltyPointTransaction.findUnique({ where: { idempotencyKey }, select: { id: true } });
            if (already) return null;
            await ensureAccount(tx, earned.userId);
            // Lock the balance row so a conversion racing this sees the result.
            const [account] = await tx.$queryRaw`
                SELECT "points" FROM "food_loyalty_point_accounts" WHERE "userId" = ${earned.userId} FOR UPDATE
            `;
            const deduct = Math.min(earned.points, Math.max(0, Number(account?.points) || 0));
            const after = await tx.foodLoyaltyPointAccount.update({
                where: { userId: earned.userId },
                data: { points: { decrement: deduct } },
            });
            return tx.foodLoyaltyPointTransaction.create({
                data: {
                    userId: earned.userId,
                    type: 'debit',
                    points: deduct,
                    balanceAfter: after.points,
                    source: 'refund',
                    orderId: id,
                    note: deduct < earned.points
                        ? `Order refunded: ${earned.points} points earned, ${deduct} left to take back`
                        : `Order refunded: ${deduct} points taken back`,
                    idempotencyKey,
                },
            });
        });
        if (!row) return { reversed: false, reason: 'already_reversed' };
        return { reversed: true, points: row.points };
    } catch (e) {
        if (e?.code === 'P2002') return { reversed: false, reason: 'already_reversed' };
        logger.warn(`reverseOrderLoyaltyPoints failed: ${e?.message || e}`);
        return { reversed: false, reason: 'error' };
    }
};

/**
 * Credit the points a delivered order earns. Called after delivery; idempotent
 * by order (`loyalty_earn:<orderId>` is unique) and never throws -- a points
 * failure must not affect the delivery.
 */
export const awardOrderLoyaltyPoints = async (orderId) => {
    try {
        if (!isId(orderId)) return { awarded: false, reason: 'invalid_order' };

        const order = await prisma.foodOrder.findUnique({
            where: { id: String(orderId) },
            select: { id: true, order_id: true, userId: true, total: true, orderStatus: true },
        });
        if (!order) return { awarded: false, reason: 'order_not_found' };
        if (order.orderStatus !== 'delivered') return { awarded: false, reason: 'not_delivered' };

        const settings = await getLoyaltySettings();
        if (!settings.isEnabled) return { awarded: false, reason: 'disabled' };
        const points = pointsForOrder(settings, order.total);
        if (points <= 0) return { awarded: false, reason: 'not_eligible' };

        const idempotencyKey = `loyalty_earn:${order.id}`;
        const created = await prisma.$transaction(async (tx) => {
            const already = await tx.foodLoyaltyPointTransaction.findUnique({ where: { idempotencyKey }, select: { id: true } });
            if (already) return null;
            await ensureAccount(tx, order.userId);
            const account = await tx.foodLoyaltyPointAccount.update({
                where: { userId: order.userId },
                data: { points: { increment: points }, totalEarned: { increment: points } },
            });
            return tx.foodLoyaltyPointTransaction.create({
                data: {
                    userId: order.userId,
                    type: 'credit',
                    points,
                    balanceAfter: account.points,
                    source: 'order',
                    orderId: order.id,
                    note: `Order ${order.order_id || order.id}`,
                    idempotencyKey,
                },
            });
        });
        if (!created) return { awarded: false, reason: 'already_awarded' };

        logger.info(`Loyalty: ${points} points to user ${order.userId} for order ${order.id}`);
        return { awarded: true, points };
    } catch (e) {
        if (e?.code === 'P2002') return { awarded: false, reason: 'already_awarded' };
        logger.warn(`awardOrderLoyaltyPoints failed: ${e?.message || e}`);
        return { awarded: false, reason: 'error' };
    }
};
