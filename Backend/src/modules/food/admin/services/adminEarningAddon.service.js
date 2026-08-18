import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { logger } from '../../../../utils/logger.js';

/**
 * Rider incentives ("earning addons"), extracted from admin.service.js.
 *
 * Two money bugs shaped this file.
 *
 * Crediting an incentive read the row, checked it was still pending, set it to
 * credited, saved, and only then topped up the wallet — three separate writes.
 * Two admins crediting at once both read `pending` and both paid.
 *
 * And the completion sweep looked for an existing grant before inserting one,
 * so two runs both found nothing and both granted. That is now a partial unique
 * index (earning_addon_one_grant_per_partner in constraints.sql); the lookup
 * stays as the fast path, the index is what makes it true.
 */

const num = (value) => Number(value) || 0;

const serializeAddon = (addon, now = Date.now()) => {
    const start = addon.startDate ? new Date(addon.startDate).getTime() : 0;
    const end = addon.endDate ? new Date(addon.endDate).getTime() : 0;

    return {
        ...addon,
        earningAmount: num(addon.earningAmount),
        isValid: Boolean(addon.status === 'active' && start && end && now >= start && now <= end),
        // 'expired' is a display state derived from the dates, not a stored one.
        status: end && now > end ? 'expired' : addon.status || 'inactive',
    };
};

export async function getEarningAddons() {
    const list = await prisma.foodEarningAddon.findMany({ orderBy: { createdAt: 'desc' } });
    const now = Date.now();
    return { earningAddons: list.map((addon) => serializeAddon(addon, now)) };
}

const addonFields = (body = {}) => ({
    title: body.title,
    requiredOrders: Number(body.requiredOrders) || 0,
    earningAmount: Number(body.earningAmount) || 0,
    startDate: body.startDate ? new Date(body.startDate) : undefined,
    endDate: body.endDate ? new Date(body.endDate) : undefined,
    maxRedemptions: body.maxRedemptions ?? null,
});

export async function createEarningAddon(body = {}) {
    const created = await prisma.foodEarningAddon.create({
        data: { ...addonFields(body), status: 'active' },
    });
    return serializeAddon(created);
}

export async function updateEarningAddon(id, body = {}) {
    if (!isId(id)) return null;

    const { count } = await prisma.foodEarningAddon.updateMany({
        where: { id: String(id) },
        data: addonFields(body),
    });
    if (!count) return null;

    return serializeAddon(await prisma.foodEarningAddon.findUnique({ where: { id: String(id) } }));
}

export async function deleteEarningAddon(id) {
    if (!isId(id)) return null;
    const { count } = await prisma.foodEarningAddon.deleteMany({ where: { id: String(id) } });
    return count ? { id: String(id) } : null;
}

export async function toggleEarningAddonStatus(id, status) {
    if (!isId(id)) return null;

    const { count } = await prisma.foodEarningAddon.updateMany({
        where: { id: String(id) },
        data: { status },
    });
    if (!count) return null;

    return serializeAddon(await prisma.foodEarningAddon.findUnique({ where: { id: String(id) } }));
}

// ─── Grant history ───────────────────────────────────────────────────────────

const HISTORY_INCLUDE = {
    deliveryPartner: { select: { id: true, name: true, phone: true, email: true } },
    offer: { select: { id: true, title: true, requiredOrders: true, earningAmount: true } },
};

const serializeHistory = (h, index = 0, offset = 0) => ({
    _id: h.id,
    id: h.id,
    sl: offset + index + 1,
    deliveryPartnerId: h.deliveryPartnerId,
    deliveryId: h.deliveryPartnerId ? `DP-${h.deliveryPartnerId.slice(-8).toUpperCase()}` : null,
    deliveryman: h.deliveryPartner?.name || '',
    deliveryPhone: h.deliveryPartner?.phone || 'N/A',
    offerTitle: h.offer?.title || '',
    ordersCompleted: h.ordersCompleted ?? 0,
    ordersRequired: h.ordersRequired ?? h.offer?.requiredOrders ?? 0,
    earningAmount: num(h.earningAmount ?? h.offer?.earningAmount),
    totalEarning: num(h.totalEarning ?? h.earningAmount),
    status: h.status || 'pending',
    date: h.completedAt || h.createdAt,
    completedAt: h.completedAt || h.createdAt,
});

export async function getEarningAddonHistory(query = {}) {
    const limit = Math.max(1, Math.min(1000, Number(query.limit) || 100));
    const page = Math.max(1, Number(query.page) || 1);
    const skip = (page - 1) * limit;

    const where = {};
    const search = typeof query.search === 'string' ? query.search.trim() : '';

    if (search) {
        // The searchable names live on the partner and the offer, so the filter
        // reaches through the relations rather than pre-resolving id lists.
        const contains = { contains: search, mode: 'insensitive' };
        where.OR = [
            { deliveryPartner: { OR: [{ name: contains }, { phone: contains }, { email: contains }] } },
            { offer: { title: contains } },
        ];
    }

    const [list, total] = await Promise.all([
        prisma.foodEarningAddonHistory.findMany({
            where,
            orderBy: [{ completedAt: 'desc' }, { createdAt: 'desc' }],
            skip,
            take: limit,
            include: HISTORY_INCLUDE,
        }),
        prisma.foodEarningAddonHistory.count({ where }),
    ]);

    return {
        history: list.map((h, i) => serializeHistory(h, i, skip)),
        pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 },
    };
}

export async function creditEarningAddonHistory(historyId, notes) {
    if (!isId(historyId)) return null;

    const existing = await prisma.foodEarningAddonHistory.findUnique({
        where: { id: String(historyId) },
        include: HISTORY_INCLUDE,
    });
    if (!existing) return null;
    // Already decided: report it rather than paying again.
    if (existing.status !== 'pending') return serializeHistory(existing);

    const amount = num(existing.earningAmount);

    const credited = await prisma.$transaction(async (tx) => {
        // Claim it. Only the caller that moves it out of pending pays.
        const { count } = await tx.foodEarningAddonHistory.updateMany({
            where: { id: String(historyId), status: 'pending' },
            data: {
                status: 'credited',
                creditedAt: new Date(),
                creditedNotes: typeof notes === 'string' ? notes.trim() : '',
            },
        });
        if (!count) return false;

        if (amount > 0) {
            // upsert, because a partner may not have a wallet row yet.
            await tx.wallet.upsert({
                where: {
                    entityType_entityId: {
                        entityType: 'deliveryBoy',
                        entityId: existing.deliveryPartnerId,
                    },
                },
                create: {
                    entityType: 'deliveryBoy',
                    entityId: existing.deliveryPartnerId,
                    balance: amount,
                    totalEarnings: amount,
                },
                update: {
                    balance: { increment: amount },
                    totalEarnings: { increment: amount },
                },
            });

            // The ledger row shares the transaction. It used to be a
            // fire-and-forget create in its own try/catch, so a failure left
            // the rider's balance moving with nothing explaining it.
            await tx.deliveryBonusTransaction.create({
                data: {
                    deliveryPartnerId: existing.deliveryPartnerId,
                    transactionId: `ADDON-${existing.id.slice(-8).toUpperCase()}`,
                    amount,
                    reference: `Earning Addon: ${existing.offer?.title || 'Offer Reward'}`,
                },
            });
        }

        return true;
    });

    const fresh = await prisma.foodEarningAddonHistory.findUnique({
        where: { id: String(historyId) },
        include: HISTORY_INCLUDE,
    });

    if (credited) {
        // Outside the transaction: a push failure must not undo the payment.
        try {
            const { notifyOwnerSafely } = await import('../../../../core/notifications/firebase.service.js');
            await notifyOwnerSafely(
                { ownerType: 'DELIVERY_PARTNER', ownerId: existing.deliveryPartnerId },
                {
                    title: 'Incentive Credited',
                    body: `Your incentive for "${existing.offer?.title || 'Earning Addon'}" has been approved and moved to your pocket.`,
                    data: {
                        type: 'incentive_credited',
                        historyId: existing.id,
                        amount: String(amount),
                    },
                },
            );
        } catch (e) {
            logger.error('Failed to send incentive credited notification:', e);
        }
    }

    return serializeHistory(fresh);
}

export async function cancelEarningAddonHistory(historyId, reason) {
    if (!isId(historyId)) return null;

    const existing = await prisma.foodEarningAddonHistory.findUnique({
        where: { id: String(historyId) },
        include: HISTORY_INCLUDE,
    });
    if (!existing) return null;
    if (existing.status !== 'pending') return serializeHistory(existing);

    const cancelReason = typeof reason === 'string' ? reason.trim() : '';

    const { count } = await prisma.foodEarningAddonHistory.updateMany({
        where: { id: String(historyId), status: 'pending' },
        data: { status: 'cancelled', cancelledAt: new Date(), cancelReason },
    });

    if (count) {
        try {
            const { notifyOwnerSafely } = await import('../../../../core/notifications/firebase.service.js');
            await notifyOwnerSafely(
                { ownerType: 'DELIVERY_PARTNER', ownerId: existing.deliveryPartnerId },
                {
                    title: 'Incentive Update',
                    body: `Your incentive request for "${existing.offer?.title || 'Earning Addon'}" was not approved. Reason: ${cancelReason || 'Ineligible'}`,
                    data: { type: 'incentive_rejected', historyId: existing.id, reason: cancelReason },
                },
            );
        } catch (e) {
            logger.error('Failed to send incentive rejection notification:', e);
        }
    }

    const fresh = await prisma.foodEarningAddonHistory.findUnique({
        where: { id: String(historyId) },
        include: HISTORY_INCLUDE,
    });
    return serializeHistory(fresh);
}

/**
 * Grant any incentive a partner has now qualified for.
 *
 * @param {string} deliveryPartnerId  a partner id, or 'all' to sweep everyone
 */
export async function checkEarningAddonCompletions(deliveryPartnerId, _force = false) {
    const now = new Date();

    const activeOffers = await prisma.foodEarningAddon.findMany({
        where: { status: 'active', startDate: { lte: now }, endDate: { gte: now } },
    });
    if (!activeOffers.length) return { completionsFound: 0 };

    let partnerIds = [];
    if (deliveryPartnerId === 'all') {
        const partners = await prisma.foodDeliveryPartner.findMany({
            where: { status: 'approved' },
            select: { id: true },
        });
        partnerIds = partners.map((p) => p.id);
    } else if (isId(deliveryPartnerId)) {
        partnerIds = [String(deliveryPartnerId)];
    }
    if (!partnerIds.length) return { completionsFound: 0 };

    let completionsFound = 0;

    for (const partnerId of partnerIds) {
        for (const offer of activeOffers) {
            // Fast path. The unique index is what actually prevents a double
            // grant when two sweeps overlap.
            const already = await prisma.foodEarningAddonHistory.count({
                where: {
                    deliveryPartnerId: partnerId,
                    offerId: offer.id,
                    status: { in: ['pending', 'credited'] },
                },
            });
            if (already) continue;

            const orderCount = await prisma.foodOrder.count({
                where: {
                    dispatchDeliveryPartnerId: partnerId,
                    orderStatus: 'delivered',
                    createdAt: { gte: offer.startDate, lte: offer.endDate },
                },
            });
            if (orderCount < (offer.requiredOrders || 1)) continue;

            try {
                await prisma.$transaction(async (tx) => {
                    // maxRedemptions was stored and never checked, so a capped
                    // offer could be granted without limit. The cap is part of
                    // the increment, so the count cannot overshoot it.
                    if (offer.maxRedemptions != null) {
                        const { count } = await tx.foodEarningAddon.updateMany({
                            where: {
                                id: offer.id,
                                currentRedemptions: { lt: offer.maxRedemptions },
                            },
                            data: { currentRedemptions: { increment: 1 } },
                        });
                        if (!count) return; // Fully redeemed.
                    } else {
                        await tx.foodEarningAddon.update({
                            where: { id: offer.id },
                            data: { currentRedemptions: { increment: 1 } },
                        });
                    }

                    await tx.foodEarningAddonHistory.create({
                        data: {
                            offerId: offer.id,
                            deliveryPartnerId: partnerId,
                            ordersCompleted: orderCount,
                            ordersRequired: offer.requiredOrders,
                            earningAmount: offer.earningAmount,
                            totalEarning: offer.earningAmount,
                            status: 'pending',
                            completedAt: now,
                        },
                    });

                    completionsFound += 1;
                });
            } catch (error) {
                // A concurrent sweep got there first; the unique index caught it.
                if (error?.code !== 'P2002') throw error;
            }
        }
    }

    return { completionsFound };
}
