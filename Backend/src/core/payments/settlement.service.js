import { prisma } from '../../config/prisma.js';
import { debitWallet } from './wallet.service.js';
import { logger } from '../../utils/logger.js';

/**
 * Create a settlement (payout request) for a restaurant or delivery partner.
 *
 * Note: this records the request only. It does not lock the amount — the previous
 * docstring claimed it did, but no version of this code ever called
 * lockWalletAmount(). Behaviour is unchanged here; wire the lock in deliberately
 * if payouts should reserve funds at request time.
 */
export async function createSettlement({ entityType, entityId, amount, notes = '', periodStart, periodEnd }) {
    if (!['restaurant', 'deliveryBoy'].includes(entityType)) {
        throw new Error('Settlements only for restaurant or deliveryBoy');
    }

    const settlement = await prisma.settlement.create({
        data: {
            entityType,
            entityId: String(entityId),
            amount: Number(amount),
            currency: 'INR',
            status: 'pending',
            notes,
            periodStart: periodStart || null,
            periodEnd: periodEnd || null
        }
    });

    logger.info(`Settlement created: ${settlement.id} for ${entityType}:${entityId} amount=${amount}`);
    return settlement;
}

/**
 * Process a settlement — debit the entity wallet and mark it paid out.
 */
export async function processSettlement(settlementId, { processedBy, payoutRef = '' } = {}) {
    const settlement = await prisma.settlement.findUnique({ where: { id: String(settlementId) } });
    if (!settlement) throw new Error('Settlement not found');
    if (settlement.status === 'processed') return settlement;
    if (settlement.status === 'failed') throw new Error('Cannot process a failed settlement');

    try {
        const { transaction } = await debitWallet({
            entityType: settlement.entityType,
            entityId: settlement.entityId,
            amount: Number(settlement.amount),
            description: `Settlement payout #${settlement.id.slice(-6)}`,
            category: 'settlement_payout',
            // A retried payout must not debit the wallet twice.
            idempotencyKey: `settlement_payout:${settlement.id}`,
            metadata: { settlementId: settlement.id }
        });

        // Mongo pushed the transaction id into Settlement.transactionIds[] and
        // bumped totalSettled in a separate unguarded write. Both are one
        // transaction here, and the array is now the FK on the ledger row.
        const [processed] = await prisma.$transaction([
            prisma.settlement.update({
                where: { id: settlement.id },
                data: {
                    status: 'processed',
                    processedAt: new Date(),
                    processedBy: processedBy ? String(processedBy) : null,
                    payoutRef
                }
            }),
            prisma.transaction.update({
                where: { id: transaction.id },
                data: { settlementId: settlement.id }
            }),
            prisma.wallet.update({
                where: {
                    entityType_entityId: {
                        entityType: settlement.entityType,
                        entityId: settlement.entityId
                    }
                },
                data: { totalSettled: { increment: Number(settlement.amount) } }
            })
        ]);

        logger.info(`Settlement processed: ${settlementId} payoutRef=${payoutRef}`);
        return processed;
    } catch (err) {
        await prisma.settlement.update({
            where: { id: settlement.id },
            data: { status: 'failed', metadata: { error: err.message } }
        });
        throw err;
    }
}

/**
 * List settlements with filters.
 */
export async function listSettlements({ entityType, entityId, status, page = 1, limit = 20 } = {}) {
    const currentPage = Math.max(1, page);
    const where = {
        ...(entityType ? { entityType } : {}),
        ...(entityId ? { entityId: String(entityId) } : {}),
        ...(status ? { status } : {})
    };

    const [settlements, total] = await Promise.all([
        prisma.settlement.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            skip: (currentPage - 1) * limit,
            take: limit
        }),
        prisma.settlement.count({ where })
    ]);

    return {
        // Number(), not the raw column. amount is a Decimal, and a Decimal
        // coerces to a string in arithmetic — the admin finance summary sums
        // these with a reduce, so a raw column made the pending-payout total
        // read "0300500": every amount concatenated rather than added.
        settlements: settlements.map((s) => ({ ...s, amount: Number(s.amount) })),
        total,
        page: currentPage,
        limit,
        totalPages: Math.ceil(total / limit),
    };
}

/**
 * Get a settlement by id.
 */
export async function getSettlementById(settlementId) {
    return prisma.settlement.findUnique({
        where: { id: String(settlementId) },
        include: { transactions: true }
    });
}
