import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { ValidationError } from '../../../../core/auth/errors.js';
import { recordTransaction } from '../../../../core/payments/transaction.service.js';
import { money, riderWithdrawable } from './adminRiderExtras.helpers.js';

/**
 * A rider's withdrawable balance, and paying out of it, for every admin route
 * that pays riders: disbursements, recorded payments and the balance sheet.
 * Kept apart from adminRiderExtras.service.js so the balance sheet can use it
 * without pulling in the rest.
 */

const num = (value) => Number(value ?? 0) || 0;

/** Serialises payouts against one rider's balance, inside the caller's transaction. */
export const lockRiderBalance = (tx, deliveryPartnerId) =>
    tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`rider-balance:${deliveryPartnerId}`}))`;

/**
 * Each rider's withdrawable balance, from the same records the rider's wallet
 * reads, in as few queries as there are records.
 *
 * @param {string[]} ids
 * @param {object} [db] prisma, or a transaction client
 * @returns {Promise<Map<string, ReturnType<typeof riderWithdrawable> & { wallet: object|null }>>}
 */
export async function loadRiderBalances(ids, db = prisma) {
    const list = [...new Set((ids || []).map(String))].filter(isId);
    if (!list.length) return new Map();

    const [earnings, bonuses, withdrawals, wallets] = await Promise.all([
        db.foodOrder.groupBy({
            by: ['dispatchDeliveryPartnerId'],
            where: { dispatchDeliveryPartnerId: { in: list }, orderStatus: 'delivered' },
            _sum: { riderEarning: true },
        }),
        db.deliveryBonusTransaction.groupBy({
            by: ['deliveryPartnerId'],
            where: { deliveryPartnerId: { in: list } },
            _sum: { amount: true },
        }),
        db.foodDeliveryWithdrawal.groupBy({
            by: ['deliveryPartnerId', 'status'],
            where: { deliveryPartnerId: { in: list }, status: { in: ['approved', 'pending'] } },
            _sum: { amount: true },
        }),
        db.wallet.findMany({ where: { entityType: 'deliveryBoy', entityId: { in: list } } }),
    ]);

    const earned = new Map(earnings.map((r) => [r.dispatchDeliveryPartnerId, num(r._sum.riderEarning)]));
    const bonus = new Map(bonuses.map((r) => [r.deliveryPartnerId, num(r._sum.amount)]));
    const walletBy = new Map(wallets.map((w) => [w.entityId, w]));
    const sumOf = (id, status) =>
        num(withdrawals.find((r) => r.deliveryPartnerId === id && r.status === status)?._sum?.amount);

    return new Map(
        list.map((id) => {
            const wallet = walletBy.get(id) || null;
            const figures = riderWithdrawable({
                earned: earned.get(id),
                bonus: bonus.get(id),
                approved: sumOf(id, 'approved'),
                pending: sumOf(id, 'pending'),
                wallet,
            });
            return [id, { ...figures, wallet }];
        }),
    );
}

/**
 * Bring the ledger up to what the rider is owed before money is taken out of
 * it. Delivery earnings are not posted to the ledger as they happen, so the
 * ledger can hold less than the balance the rider sees; the gap is posted as
 * a credit with a reason, exactly as a rider's own withdrawal request does.
 */
export async function syncLedger(tx, deliveryPartnerId, figures, rowId) {
    const gap = money(figures.targetLedgerBalance - num(figures.wallet?.balance));
    if (gap <= 0) return;
    await recordTransaction(
        {
            entityType: 'deliveryBoy',
            entityId: deliveryPartnerId,
            type: 'credit',
            amount: gap,
            description: 'Delivery earnings synced to wallet ledger',
            category: 'adjustment',
            idempotencyKey: `earnings_sync:${rowId}`,
            metadata: { withdrawalId: rowId },
        },
        { client: tx },
    );
}

export const insufficient = (available) =>
    new ValidationError(
        available > 0
            ? `This delivery man can be paid at most ₹${available.toLocaleString('en-IN')} right now`
            : 'This delivery man has no balance left to pay',
    );

/**
 * Record money already paid to a rider, and take it off their balance, inside
 * the caller's transaction. Used by Delivery Man Payments and by the balance
 * sheet's rider payout, so both lower the balance the rider withdraws from.
 *
 * The balance is read under a per-rider lock, so two payments made at once
 * cannot both spend the same money; the ledger debit carries an idempotency
 * key tied to the payment, so a retry cannot debit it twice.
 */
export async function recordRiderPaymentInTx(tx, {
    deliveryPartnerId, amount, method = 'bank_transfer', reference = '', note = '',
    adminId = null, source = 'admin_payment', bankDetails = null,
}) {
    const partnerId = String(deliveryPartnerId);
    const value = money(amount);
    if (!(value > 0)) throw new ValidationError('Amount must be greater than zero');

    await lockRiderBalance(tx, partnerId);
    const figures = (await loadRiderBalances([partnerId], tx)).get(partnerId);
    if (!figures || value > figures.available) throw insufficient(figures?.available || 0);

    const row = await tx.foodDeliveryWithdrawal.create({
        data: {
            deliveryPartnerId: partnerId,
            amount: value,
            status: 'approved',
            paymentMethod: method,
            bankDetails: bankDetails || undefined,
            transactionId: reference || null,
            adminNote: note || null,
            processedAt: new Date(),
            source,
            processedBy: adminId && isId(adminId) ? String(adminId) : null,
        },
    });

    await syncLedger(tx, partnerId, figures, row.id);
    try {
        await recordTransaction(
            {
                entityType: 'deliveryBoy',
                entityId: partnerId,
                type: 'debit',
                amount: value,
                description: source === 'balance_sheet' ? 'Balance sheet payout' : `Payment by admin (${method})`,
                category: 'settlement_payout',
                idempotencyKey: `delivery_payment:${row.id}`,
                metadata: { withdrawalId: row.id, source, reference: reference || undefined },
            },
            { client: tx },
        );
    } catch (error) {
        if (/Insufficient balance/i.test(error.message)) throw insufficient(figures.available);
        throw error;
    }
    await tx.wallet.updateMany({
        where: { entityType: 'deliveryBoy', entityId: partnerId },
        data: { totalSettled: { increment: value } },
    });

    return row;
}

