import { prisma } from '../../config/prisma.js';
import { logger } from '../../utils/logger.js';

/**
 * The wallet ledger.
 *
 * Mongo kept four wallet collections and a resolveWallet() switch to pick between
 * them; Postgres keeps one `wallets` table keyed by (entityType, entityId), so the
 * switch is gone and every entity type takes the same code path.
 *
 * RULE: never write Wallet.balance directly — always go through recordTransaction().
 */

/** The admin wallet is a singleton, addressed by a fixed id. */
export const ADMIN_ENTITY_ID = '000000000000000000000001';

const resolveEntityId = (entityType, entityId) =>
    entityType === 'admin' ? ADMIN_ENTITY_ID : String(entityId);

const walletKey = (entityType, entityId) => ({
    entityType_entityId: { entityType, entityId: resolveEntityId(entityType, entityId) }
});

/** Wallet rows come back with Decimal columns; the API has always spoken numbers. */
const toNumber = (value) => Number(value ?? 0);

/**
 * Ensure a wallet row exists, creating it at zero if not. Returns the wallet.
 */
export async function ensureWallet(entityType, entityId) {
    const id = resolveEntityId(entityType, entityId);
    return prisma.wallet.upsert({
        where: walletKey(entityType, entityId),
        create: { entityType, entityId: id, balance: 0 },
        update: {}
    });
}

/**
 * Get balance for an entity wallet.
 */
export async function getBalance(entityType, entityId) {
    const wallet = await ensureWallet(entityType, entityId);
    const balance = toNumber(wallet.balance);
    const lockedAmount = toNumber(wallet.lockedAmount);

    return { balance, lockedAmount, availableBalance: balance - lockedAmount };
}

/**
 * Lifetime counters, which differ per entity type. Mongo tracked these with $inc
 * on the type-specific wallet model; here they are nullable columns on the one table.
 */
function lifetimeTotals(entityType, type, amount) {
    if (type !== 'credit') return {};
    if (entityType === 'restaurant' || entityType === 'deliveryBoy') {
        return { totalEarnings: { increment: amount } };
    }
    if (entityType === 'admin') return { totalRevenue: { increment: amount } };
    return {};
}

/**
 * CORE ATOMIC OPERATION: record a transaction AND move the wallet balance in one
 * database transaction. This is the ONLY way to change a wallet balance.
 *
 * @param {Object} payload
 * @param {string} payload.entityType - 'user' | 'restaurant' | 'deliveryBoy' | 'admin'
 * @param {string} payload.entityId - id of the entity
 * @param {string} payload.type - 'credit' | 'debit'
 * @param {number} payload.amount - positive amount
 * @param {string} [payload.description] - human readable
 * @param {string} [payload.category] - transaction category
 * @param {string} [payload.orderId] - linked order
 * @param {string} [payload.paymentId] - linked payment
 * @param {Object} [payload.metadata] - extra data
 * @param {string} [payload.idempotencyKey] - pass on any retryable caller (gateway
 *        webhooks, queue jobs); a replay returns the original row instead of
 *        moving the balance a second time.
 * @returns {Object} { transaction, wallet }
 */
export async function recordTransaction(payload) {
    const {
        entityType, entityId, type, amount,
        description = '', category = 'other',
        orderId = null, paymentId = null,
        metadata = undefined, module = 'food',
        idempotencyKey = null
    } = payload;

    if (!['credit', 'debit'].includes(type)) throw new Error('type must be credit or debit');
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) throw new Error('amount must be positive');

    const id = resolveEntityId(entityType, entityId);

    if (idempotencyKey) {
        const replay = await prisma.transaction.findUnique({ where: { idempotencyKey } });
        if (replay) {
            logger.info(`Transaction replay ignored: ${idempotencyKey}`);
            return { transaction: replay, wallet: { balance: toNumber(replay.balanceAfter) } };
        }
    }

    const result = await prisma.$transaction(async (tx) => {
        await tx.wallet.upsert({
            where: walletKey(entityType, entityId),
            create: { entityType, entityId: id, balance: 0 },
            update: {}
        });

        // The overdraw guard lives in the WHERE clause, not in a preceding read.
        // Mongo did findOne -> compute -> updateOne, so two concurrent debits could
        // both pass the check and drive the balance negative; a conditional UPDATE
        // is one statement and cannot interleave. Admin is allowed to go negative,
        // as it was before.
        const guarded = type === 'debit' && entityType !== 'admin';
        const { count } = await tx.wallet.updateMany({
            where: {
                entityType,
                entityId: id,
                ...(guarded ? { balance: { gte: value } } : {})
            },
            data: {
                balance: type === 'credit' ? { increment: value } : { decrement: value },
                ...lifetimeTotals(entityType, type, value)
            }
        });

        if (count === 0) {
            const { balance } = await getBalance(entityType, id);
            throw new Error(`Insufficient balance. Current: ${balance}, Debit: ${value}`);
        }

        const wallet = await tx.wallet.findUniqueOrThrow({ where: walletKey(entityType, entityId) });

        const transaction = await tx.transaction.create({
            data: {
                paymentId,
                orderId,
                entityType,
                entityId: id,
                type,
                amount: value,
                balanceAfter: wallet.balance,
                currency: 'INR',
                status: 'completed',
                description,
                category,
                module,
                metadata,
                idempotencyKey
            }
        });

        return { transaction, wallet: { balance: toNumber(wallet.balance) } };
    });

    logger.info(
        `Transaction recorded: ${type} ${value} INR for ${entityType}:${id} → balance ${result.wallet.balance}`
    );
    return result;
}

/**
 * List transactions for an entity with pagination.
 */
export async function getTransactionsByEntity(entityType, entityId, { page = 1, limit = 20 } = {}) {
    const currentPage = Math.max(1, page);
    const where = { entityType, entityId: resolveEntityId(entityType, entityId) };

    const [transactions, total] = await Promise.all([
        prisma.transaction.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            skip: (currentPage - 1) * limit,
            take: limit
        }),
        prisma.transaction.count({ where })
    ]);

    return {
        transactions,
        total,
        page: currentPage,
        limit,
        totalPages: Math.ceil(total / limit)
    };
}

/**
 * Get transactions for a specific order across all entities.
 */
export async function getTransactionsByOrder(orderId) {
    return prisma.transaction.findMany({
        where: { orderId: String(orderId) },
        orderBy: { createdAt: 'desc' }
    });
}
