import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { ValidationError } from '../../../../core/auth/errors.js';
import { recordTransaction } from '../../../../core/payments/transaction.service.js';
import { logger } from '../../../../utils/logger.js';

export const getActiveCashbackSettings = async () => {
    const doc = await prisma.foodCashbackSettings.findFirst({
        where: { isActive: true },
        orderBy: { createdAt: 'desc' },
    });
    return (
        doc || {
            isEnabled: false,
            cashbackType: 'percentage',
            cashbackValue: 0,
            minOrderValue: 0,
            maxCashback: 0,
            firstOrderOnly: false,
            perUserLimit: 0,
        }
    );
};

/** Preview the cashback an order would earn. Pure — no writes. */
export const computeCashbackAmount = (settings, subtotal) => {
    if (!settings?.isEnabled) return 0;
    const base = Number(subtotal) || 0;
    if (base <= 0) return 0;
    if (base < (Number(settings.minOrderValue) || 0)) return 0;

    const value = Number(settings.cashbackValue) || 0;
    if (value <= 0) return 0;

    let amount = settings.cashbackType === 'flat' ? value : (base * value) / 100;
    const cap = Number(settings.maxCashback) || 0;
    if (settings.cashbackType === 'percentage' && cap > 0) amount = Math.min(amount, cap);

    return Math.max(0, Math.floor(amount)); // whole rupees, never round up in our favour
};

/** Every cashback credit this customer has received, newest first. */
const listCashbackTransactions = (userId, { skip, take } = {}) =>
    prisma.transaction.findMany({
        where: { entityType: 'user', entityId: userId, category: 'wallet_topup', description: { startsWith: 'Cashback' } },
        orderBy: { createdAt: 'desc' },
        ...(skip !== undefined ? { skip } : {}),
        ...(take !== undefined ? { take } : {}),
    });

/**
 * Award cashback for a delivered order and credit the customer's wallet.
 *
 * Idempotent by order: `cashback:<orderId>` is the ledger's unique idempotency
 * key, so a replay is refused by the database rather than by scanning prior
 * transactions and hoping no two calls interleave. Never throws — a cashback
 * failure must not affect the delivery.
 */
export const awardOrderCashback = async (orderId) => {
    try {
        if (!isId(orderId)) return { awarded: false, reason: 'invalid_order' };

        const order = await prisma.foodOrder.findUnique({
            where: { id: String(orderId) },
            select: { id: true, order_id: true, userId: true, subtotal: true, orderStatus: true },
        });
        if (!order) return { awarded: false, reason: 'order_not_found' };
        if (order.orderStatus !== 'delivered') return { awarded: false, reason: 'not_delivered' };

        const settings = await getActiveCashbackSettings();
        if (!settings.isEnabled) return { awarded: false, reason: 'disabled' };

        const amount = computeCashbackAmount(settings, order.subtotal);
        if (amount <= 0) return { awarded: false, reason: 'not_eligible' };

        const idempotencyKey = `cashback:${order.id}`;
        const already = await prisma.transaction.findUnique({ where: { idempotencyKey } });
        if (already) return { awarded: false, reason: 'already_awarded' };

        if (settings.firstOrderOnly) {
            const deliveredCount = await prisma.foodOrder.count({
                where: { userId: order.userId, orderStatus: 'delivered' },
            });
            if (deliveredCount > 1) return { awarded: false, reason: 'not_first_order' };
        }

        const perUserLimit = Number(settings.perUserLimit) || 0;
        if (perUserLimit > 0) {
            const priorAwards = await listCashbackTransactions(order.userId);
            if (priorAwards.length >= perUserLimit) {
                return { awarded: false, reason: 'per_user_limit_reached' };
            }
        }

        // Through the ledger, not a direct balance write. Cashback used to push
        // onto the wallet's embedded array and recompute the balance itself,
        // which made it a second writer racing the real one.
        await recordTransaction({
            entityType: 'user',
            entityId: order.userId,
            type: 'credit',
            amount,
            description: `Cashback on order ${order.order_id || order.id}`,
            category: 'wallet_topup',
            orderId: order.id,
            idempotencyKey,
            metadata: {
                source: 'cashback',
                orderId: order.id,
                orderDisplayId: order.order_id || order.id,
            },
        });

        try {
            const { notifyOwnerSafely } = await import('../../orders/services/order.helpers.js');
            void notifyOwnerSafely(
                { ownerType: 'USER', ownerId: order.userId },
                {
                    title: 'Cashback credited! 🎁',
                    body: `₹${amount} cashback added to your wallet for order ${order.order_id || ''}.`,
                    data: { type: 'cashback_credited', amount: String(amount), orderId: order.id },
                },
            );
        } catch {
            /* notification failure must not affect the credit */
        }

        logger.info(`Cashback ₹${amount} credited to user ${order.userId} for order ${order.id}`);
        return { awarded: true, amount };
    } catch (e) {
        logger.warn(`awardOrderCashback failed: ${e?.message || e}`);
        return { awarded: false, reason: 'error' };
    }
};

/** Cashback-only slice of the wallet ledger. */
export const getCashbackHistory = async (userId, query = {}) => {
    const id = String(userId || '');
    if (!isId(id)) throw new ValidationError('User not found');

    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 20, 1), 100);

    const all = await listCashbackTransactions(id);
    const totalEarned = all.reduce((sum, t) => sum + (Number(t.amount) || 0), 0);

    const items = all.slice((page - 1) * limit, page * limit).map((t) => ({
        id: t.id,
        amount: Number(t.amount) || 0,
        description: t.description || '',
        orderId: t.orderId || t.metadata?.orderId || null,
        orderDisplayId: t.metadata?.orderDisplayId || null,
        status: t.status === 'completed' ? 'Completed' : t.status,
        date: t.createdAt,
        createdAt: t.createdAt,
    }));

    return {
        totalEarned,
        items,
        pagination: {
            page,
            limit,
            total: all.length,
            totalPages: Math.max(1, Math.ceil(all.length / limit)),
        },
    };
};

/**
 * Refund history across ALL of the user's orders.
 * Sourced from the authoritative order payment records, enriched with the
 * matching wallet refund transaction when the money went back to the wallet.
 */
export const getUserRefundHistory = async (userId, query = {}) => {
    const id = String(userId || '');
    if (!isId(id)) throw new ValidationError('User not found');

    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 20, 1), 100);

    const where = {
        userId: id,
        OR: [
            { refundStatus: { in: ['pending', 'processed', 'failed'] } },
            { paymentStatus: 'refunded' },
        ],
    };

    const [docs, total, walletRefunds] = await Promise.all([
        prisma.foodOrder.findMany({
            where,
            select: {
                id: true, order_id: true, orderId: true, total: true,
                paymentMethod: true, paymentStatus: true,
                refundStatus: true, refundAmount: true, refundId: true, refundProcessedAt: true,
                orderStatus: true, createdAt: true, updatedAt: true,
                restaurant: { select: { id: true, restaurantName: true, profileImage: true } },
            },
            orderBy: { updatedAt: 'desc' },
            skip: (page - 1) * limit,
            take: limit,
        }),
        prisma.foodOrder.count({ where }),
        prisma.transaction.findMany({
            where: { entityType: 'user', entityId: id, category: 'order_refund' },
            select: { orderId: true, amount: true },
        }),
    ]);

    const refundByOrder = new Map(walletRefunds.filter((t) => t.orderId).map((t) => [t.orderId, t]));

    const refunds = docs.map((o) => {
        const walletRow = refundByOrder.get(o.id);
        const amount = Number(o.refundAmount) || Number(walletRow?.amount) || Number(o.total) || 0;

        return {
            orderId: o.id,
            orderDisplayId: o.order_id || o.id,
            restaurantName: o.restaurant?.restaurantName || '',
            amount,
            // 'processed' once the money is back with the customer.
            status: String(
                o.refundStatus && o.refundStatus !== 'none'
                    ? o.refundStatus
                    : o.paymentStatus === 'refunded' ? 'processed' : 'pending',
            ),
            method: o.paymentMethod || '',
            refundId: o.refundId || '',
            // cancellationReason is derived from status history, which this query
            // does not load; the field stays for shape compatibility.
            reason: '',
            creditedToWallet: Boolean(walletRow),
            processedAt: o.refundProcessedAt || null,
            orderStatus: o.orderStatus,
            createdAt: o.createdAt,
            updatedAt: o.updatedAt,
        };
    });

    return {
        totalRefunded: refunds
            .filter((r) => r.status === 'processed')
            .reduce((sum, r) => sum + (Number(r.amount) || 0), 0),
        refunds,
        pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    };
};
