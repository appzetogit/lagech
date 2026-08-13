import { prisma } from '../../config/prisma.js';
import { isId } from '../../utils/helpers.js';
import { logger } from '../../utils/logger.js';
import {
    recordTransaction,
    ensureWallet,
    getBalance,
    getTransactionsByEntity
} from './transaction.service.js';

/**
 * Universal wallet service — facade over transaction.service for the common
 * operations (credit, debit, lock, unlock, balance).
 */

/**
 * Credit an entity's wallet.
 */
export async function creditWallet({
    entityType, entityId, amount, description,
    category = 'other', orderId, paymentId, metadata, idempotencyKey
}) {
    return recordTransaction({
        entityType,
        entityId: String(entityId),
        type: 'credit',
        amount: Number(amount),
        description,
        category,
        orderId: orderId ? String(orderId) : null,
        paymentId: paymentId ? String(paymentId) : null,
        metadata,
        idempotencyKey
    });
}

/**
 * Debit an entity's wallet.
 */
export async function debitWallet({
    entityType, entityId, amount, description,
    category = 'other', orderId, paymentId, metadata, idempotencyKey
}) {
    return recordTransaction({
        entityType,
        entityId: String(entityId),
        type: 'debit',
        amount: Number(amount),
        description,
        category,
        orderId: orderId ? String(orderId) : null,
        paymentId: paymentId ? String(paymentId) : null,
        metadata,
        idempotencyKey
    });
}

/**
 * Get wallet info for any entity.
 */
export async function getWalletBalance(entityType, entityId) {
    return getBalance(entityType, entityId);
}

/**
 * Get wallet + recent transactions for any entity.
 */
export async function getWalletWithTransactions(entityType, entityId, { page = 1, limit = 20 } = {}) {
    const [balance, txns] = await Promise.all([
        getBalance(entityType, entityId),
        getTransactionsByEntity(entityType, entityId, { page, limit })
    ]);

    return { ...balance, ...txns };
}

/**
 * Lock an amount against a wallet (pending settlements). Locked funds stay in the
 * balance but cannot be withdrawn.
 *
 * The availability check is the WHERE clause rather than a preceding read: the old
 * version read the wallet, compared in JS, then saved, so two settlements raised at
 * the same time could both see the same headroom and over-lock it.
 */
export async function lockWalletAmount(entityType, entityId, amount) {
    const value = Number(amount);
    await ensureWallet(entityType, entityId);

    // Raw because the guard is arithmetic across two columns — `balance -
    // lockedAmount >= value` is not expressible in a Prisma where clause, and
    // splitting it into read-then-write would reintroduce the race.
    const locked = await prisma.$executeRaw`
        UPDATE "wallets"
           SET "lockedAmount" = "lockedAmount" + ${value}::numeric,
               "updatedAt" = now()
         WHERE "entityType" = ${entityType}::"EntityType"
           AND "entityId" = ${String(entityId)}
           AND "balance" - "lockedAmount" >= ${value}::numeric
    `;

    if (locked === 0) {
        const { availableBalance } = await getBalance(entityType, entityId);
        throw new Error(`Cannot lock ${value}. Available: ${availableBalance}`);
    }

    const wallet = await ensureWallet(entityType, entityId);
    logger.info(`Locked ${value} for ${entityType}:${entityId}. Total locked: ${wallet.lockedAmount}`);
    return { lockedAmount: Number(wallet.lockedAmount), balance: Number(wallet.balance) };
}

/**
 * Release a locked amount (settlement processed or cancelled).
 */
export async function unlockWalletAmount(entityType, entityId, amount) {
    const value = Number(amount);
    await ensureWallet(entityType, entityId);

    // GREATEST is the old Math.max clamp, moved into the statement so the floor
    // holds under concurrent unlocks too.
    await prisma.$executeRaw`
        UPDATE "wallets"
           SET "lockedAmount" = GREATEST(0::numeric, "lockedAmount" - ${value}::numeric),
               "updatedAt" = now()
         WHERE "entityType" = ${entityType}::"EntityType"
           AND "entityId" = ${String(entityId)}
    `;

    const wallet = await ensureWallet(entityType, entityId);
    logger.info(`Unlocked ${value} for ${entityType}:${entityId}. Total locked: ${wallet.lockedAmount}`);
    return { lockedAmount: Number(wallet.lockedAmount), balance: Number(wallet.balance) };
}

/**
 * Ledger row → the shape the wallet UI has always consumed.
 * Kept so the frontend needs no change now that the embedded transaction array
 * is gone and the ledger is the only source.
 */
export const toWalletTransaction = (row) => ({
    id: row.id,
    _id: row.id,
    type: row.type === 'credit' ? 'addition' : 'deduction',
    amount: Number(row.amount),
    status: row.status === 'completed' ? 'Completed' : row.status,
    description: row.description || '',
    date: row.createdAt,
    createdAt: row.createdAt,
    metadata: row.metadata || {},
    category: row.category,
    balanceAfter: Number(row.balanceAfter)
});

/**
 * USER WALLET in the format the existing frontend expects.
 *
 * Mongo stored user wallet history twice — an embedded `transactions` array on
 * FoodUserWallet AND the Transaction ledger — and this function merged the two
 * without deduplicating, so a top-up written through both paths showed twice. The
 * embedded array is gone; the ledger is the only source.
 */
export async function getUserWalletForFrontend(userId) {
    const id = String(userId || '');
    if (!isId(id)) return { balance: 0, referralEarnings: 0, transactions: [] };

    const [wallet, { transactions }] = await Promise.all([
        ensureWallet('user', id),
        getTransactionsByEntity('user', id, { page: 1, limit: 50 })
    ]);

    return {
        balance: Number(wallet.balance),
        referralEarnings: Number(wallet.referralEarnings ?? 0),
        transactions: transactions.map(toWalletTransaction)
    };
}
