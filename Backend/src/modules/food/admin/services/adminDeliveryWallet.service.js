import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { ValidationError } from '../../../../core/auth/errors.js';
import { getBulkDeliveryPartnerStats } from './adminDeliveryPartner.service.js';

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

/**
 * Manual wallet adjustment from the admin panel.
 *
 * ponytail: this writes the balance directly rather than posting to the ledger,
 * so the wallet and its transaction history disagree afterwards — the rider
 * sees a number move with nothing explaining it. Kept because the panel offers
 * it as a correction tool; the real fix is to route it through
 * recordTransaction with an 'admin_adjustment' category.
 */
export async function updateDeliveryBoyWallet(data = {}) {
    const { deliveryId, pocketBalance, cashInHand } = data;
    if (!isId(deliveryId)) throw new ValidationError('Delivery partner ID required');

    const partner = await prisma.foodDeliveryPartner.findUnique({
        where: { id: String(deliveryId) },
        select: { id: true },
    });
    if (!partner) throw new ValidationError('Delivery partner not found');

    const update = {};
    if (pocketBalance !== undefined) update.balance = Number(pocketBalance) || 0;
    if (cashInHand !== undefined) update.cashInHand = Number(cashInHand) || 0;

    // The wallet is keyed on (entityType, entityId) — riders share the table
    // with restaurants, users and the platform.
    return prisma.wallet.upsert({
        where: { entityType_entityId: { entityType: 'deliveryBoy', entityId: partner.id } },
        create: {
            entityType: 'deliveryBoy',
            entityId: partner.id,
            balance: Number(pocketBalance) || 0,
            cashInHand: Number(cashInHand) || 0,
        },
        update,
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
