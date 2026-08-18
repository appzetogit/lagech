import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { ValidationError } from '../../../../core/auth/errors.js';
import { getBulkDeliveryPartnerStats } from './adminDeliveryPartner.service.js';
import { ensureWallet, recordTransaction } from '../../../../core/payments/transaction.service.js';

/**
 * Rider wallets and cash settlements, extracted from admin.service.js.
 *
 * The wallet figures here are derived from orders, bonuses, deposits and
 * withdrawals rather than read from the wallet row — see
 * getBulkDeliveryPartnerStats. The wallet row is the balance the ledger
 * maintains; this screen answers "what has this rider earned and what are they
 * holding", which are different questions and come from different places.
 */

export async function getDeliveryWallets(query = {}) {
    const limit = Math.max(1, Math.min(500, parseInt(query.limit, 10) || 20));
    const page = Math.max(1, parseInt(query.page, 10) || 1);
    const skip = (page - 1) * limit;

    const where = { status: 'approved' };
    if (query.search) {
        const contains = { contains: String(query.search), mode: 'insensitive' };
        where.OR = [{ name: contains }, { phone: contains }];
    }

    const [partners, total, cashLimitSettings] = await Promise.all([
        prisma.foodDeliveryPartner.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            skip,
            take: limit,
        }),
        prisma.foodDeliveryPartner.count({ where }),
        prisma.foodDeliveryCashLimit.findFirst({ where: { isActive: true } }),
    ]);

    // 0 means no limit, which is why it is not defaulted to something else.
    const globalLimit = Number(cashLimitSettings?.deliveryCashLimit || 0);
    const statsMap = await getBulkDeliveryPartnerStats(partners.map((p) => p.id));

    const wallets = partners.map((p) => {
        const stats = statsMap.get(p.id) || {};
        const cashInHand = stats.cashInHand || 0;

        return {
            walletId: p.id,
            deliveryId: p.id,
            name: p.name,
            deliveryIdString: p.phone,
            pocketBalance: stats.pocketBalance || 0,
            // How much more COD this rider may take before they must settle up.
            remainingCashLimit: Math.max(0, globalLimit - cashInHand),
            cashCollected: cashInHand,
            totalEarning: stats.totalEarning || 0,
            bonus: stats.bonus || 0,
            totalWithdrawn: stats.totalWithdrawn || 0,
            availableCashLimit: globalLimit,
            totalOrders: stats.totalOrders || 0,
        };
    });

    return { wallets, pagination: { total, page, limit, pages: Math.ceil(total / limit) || 1 } };
}

/** Decimal(14,2) columns, so a float subtraction has to be rounded back to paise. */
const toPaise = (value) => Math.round(Number(value) * 100) / 100;

/**
 * Manual wallet adjustment from the admin panel.
 *
 * The panel asks for a target balance, but the balance is not the thing that
 * can be set — it is the running total of the ledger, and writing over it made
 * the wallet and its own transaction history disagree. The rider saw a number
 * move with nothing explaining it, and the difference reappeared the next time
 * anything recomputed from the ledger.
 *
 * So the target is turned into the movement that reaches it, and posted like
 * any other. recordTransaction moves the balance and writes the ledger row in
 * one database transaction; nothing else may write Wallet.balance.
 *
 * cashInHand is not ledger money — it is how much physical cash the rider is
 * holding from COD orders, reconciled against deposits rather than against the
 * wallet — so it is still a direct write.
 */
export async function updateDeliveryBoyWallet(data = {}, actingAdminId = null) {
    const { deliveryId, pocketBalance, cashInHand, reason } = data;
    if (!isId(deliveryId)) throw new ValidationError('Delivery partner ID required');

    const partner = await prisma.foodDeliveryPartner.findUnique({
        where: { id: String(deliveryId) },
        select: { id: true },
    });
    if (!partner) throw new ValidationError('Delivery partner not found');

    // The wallet is keyed on (entityType, entityId) — riders share the table
    // with restaurants, users and the platform.
    const wallet = await ensureWallet('deliveryBoy', partner.id);

    if (pocketBalance !== undefined) {
        const target = Number(pocketBalance);
        if (!Number.isFinite(target) || target < 0) {
            throw new ValidationError('Balance must be a number of zero or more');
        }

        const delta = toPaise(target - Number(wallet.balance));
        // Submitting the form without changing the figure should not post an
        // adjustment of zero, which recordTransaction rejects anyway.
        if (delta !== 0) {
            await recordTransaction({
                entityType: 'deliveryBoy',
                entityId: partner.id,
                type: delta > 0 ? 'credit' : 'debit',
                amount: Math.abs(delta),
                category: 'adjustment',
                description: String(reason || '').trim() || 'Manual wallet adjustment by admin',
                metadata: {
                    adjustedBy: actingAdminId,
                    previousBalance: Number(wallet.balance),
                    newBalance: target,
                },
            });
        }
    }

    if (cashInHand !== undefined) {
        const cash = Number(cashInHand);
        if (!Number.isFinite(cash) || cash < 0) {
            throw new ValidationError('Cash in hand must be a number of zero or more');
        }
        await prisma.wallet.update({
            where: { entityType_entityId: { entityType: 'deliveryBoy', entityId: partner.id } },
            data: { cashInHand: cash },
        });
    }

    return prisma.wallet.findUniqueOrThrow({
        where: { entityType_entityId: { entityType: 'deliveryBoy', entityId: partner.id } },
    });
}

export async function getCashLimitSettlements(query = {}) {
    const limit = Math.max(1, Math.min(500, parseInt(query.limit, 10) || 20));
    const page = Math.max(1, parseInt(query.page, 10) || 1);
    const skip = (page - 1) * limit;

    const where = {};
    const search = String(query.search || '').trim();
    if (search) {
        // A gateway reference is exact; anything else matches the rider, which
        // the Mongo version could not do without a join.
        if (search.startsWith('pay_')) {
            where.razorpayPaymentId = search;
        } else {
            const contains = { contains: search, mode: 'insensitive' };
            where.deliveryPartner = { OR: [{ name: contains }, { phone: contains }] };
        }
    }

    const [deposits, total] = await Promise.all([
        prisma.foodDeliveryCashDeposit.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            skip,
            take: limit,
            include: { deliveryPartner: { select: { id: true, name: true, phone: true } } },
        }),
        prisma.foodDeliveryCashDeposit.count({ where }),
    ]);

    const transactions = deposits.map((d) => ({
        id: d.id,
        createdAt: d.createdAt,
        deliveryId: d.deliveryPartner?.id || d.deliveryPartnerId,
        deliveryName: d.deliveryPartner?.name || 'N/A',
        deliveryIdString: d.deliveryPartner?.phone || 'N/A',
        amount: Number(d.amount || 0),
        status: d.status,
        razorpayPaymentId: d.razorpayPaymentId || '-',
    }));

    return { transactions, pagination: { total, page, limit, pages: Math.ceil(total / limit) || 1 } };
}
