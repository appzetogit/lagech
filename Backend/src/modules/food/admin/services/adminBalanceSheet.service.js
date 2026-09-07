import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { ValidationError } from '../../../../core/auth/errors.js';

/**
 * What the platform owes each restaurant and rider, and paying it.
 *
 * The ledger already carries the split -- restaurantShare, riderShare -- and a
 * pair of settled flags per side that nothing ever wrote. So every transaction
 * has been unsettled since the system was built, and "what do we still owe
 * this restaurant" had no answer. A balance is the sum of the unsettled
 * shares; a payout writes those flags and records a Settlement against them.
 *
 * Settling is not the same as the existing withdrawals. Those are pull: a
 * restaurant or rider asks for money. This is push: an admin runs a period and
 * pays out what is owed, whether or not anyone asked.
 */

const num = (value) => Number(value ?? 0) || 0;
const money = (value) => Math.round(num(value) * 100) / 100;

/**
 * Only captured payments count toward a balance.
 *
 * A pending transaction is an order whose money has not arrived, and paying a
 * restaurant for it would be paying out of the platform's own pocket. Refunded
 * and failed ones are self-explanatory. COD is captured on delivery, so it is
 * included -- the cash is real, the rider is simply holding it, which the rider
 * side accounts for separately.
 */
const SETTLEABLE_STATUS = 'captured';

/** A period always has both ends; an open-ended payout run is a mistake. */
const parsePeriod = ({ from, to } = {}) => {
    const start = from ? new Date(from) : null;
    const end = to ? new Date(to) : null;

    if (!start || Number.isNaN(start.getTime())) throw new ValidationError('A valid "from" date is required');
    if (!end || Number.isNaN(end.getTime())) throw new ValidationError('A valid "to" date is required');
    if (end <= start) throw new ValidationError('"to" must be after "from"');

    return { start, end };
};

const periodWhere = (start, end) => ({
    status: SETTLEABLE_STATUS,
    createdAt: { gte: start, lte: end },
});

// ─── Restaurants ─────────────────────────────────────────────────────────────

/**
 * Every restaurant with money owed in the period.
 *
 * Restaurants with nothing outstanding are dropped rather than listed at zero:
 * a payout run is a list of people to pay, and thirty zero rows between the
 * ones that matter is how a real balance gets missed.
 */
export async function getRestaurantBalances(query = {}) {
    const { start, end } = parsePeriod(query);

    const grouped = await prisma.foodTransaction.groupBy({
        by: ['restaurantId'],
        where: { ...periodWhere(start, end), isRestaurantSettled: false },
        _sum: { restaurantShare: true, commissionAmount: true, subtotal: true },
        _count: { _all: true },
    });

    if (!grouped.length) {
        return { period: { from: start, to: end }, rows: [], totals: emptyTotals() };
    }

    const restaurants = await prisma.foodRestaurant.findMany({
        where: { id: { in: grouped.map((g) => g.restaurantId) } },
        select: {
            id: true, restaurantName: true, ownerName: true, ownerPhone: true,
            accountNumber: true, ifscCode: true, accountHolderName: true, upiId: true,
        },
    });
    const byId = new Map(restaurants.map((r) => [r.id, r]));

    const rows = grouped
        .map((g) => {
            const restaurant = byId.get(g.restaurantId);
            return {
                entityType: 'restaurant',
                entityId: g.restaurantId,
                name: restaurant?.restaurantName || 'Unknown restaurant',
                contact: restaurant?.ownerPhone || '',
                orders: g._count._all,
                grossSales: money(g._sum.subtotal),
                commission: money(g._sum.commissionAmount),
                payable: money(g._sum.restaurantShare),
                // Surfaced so an admin can see, before running a payout, which
                // rows they will not actually be able to pay.
                hasBankDetails: Boolean(
                    (restaurant?.accountNumber && restaurant?.ifscCode) || restaurant?.upiId,
                ),
                bank: restaurant
                    ? {
                          accountHolderName: restaurant.accountHolderName || '',
                          accountNumber: restaurant.accountNumber || '',
                          ifscCode: restaurant.ifscCode || '',
                          upiId: restaurant.upiId || '',
                      }
                    : null,
            };
        })
        .filter((row) => row.payable !== 0)
        .sort((a, b) => b.payable - a.payable);

    return {
        period: { from: start, to: end },
        rows,
        totals: {
            entities: rows.length,
            orders: rows.reduce((sum, r) => sum + r.orders, 0),
            grossSales: money(rows.reduce((sum, r) => sum + r.grossSales, 0)),
            commission: money(rows.reduce((sum, r) => sum + r.commission, 0)),
            payable: money(rows.reduce((sum, r) => sum + r.payable, 0)),
        },
    };
}

const emptyTotals = () => ({ entities: 0, orders: 0, grossSales: 0, commission: 0, payable: 0 });

// ─── Riders ──────────────────────────────────────────────────────────────────

/**
 * Every rider with a non-zero balance in the period.
 *
 * A rider's balance can be negative, and that is the point of showing it. On a
 * cash order the rider physically holds the customer's money, so the platform
 * is owed it back; net it against what they earned and a rider who did mostly
 * COD work may owe more than they are due. Paying out the earnings alone and
 * chasing the cash separately is how float goes missing.
 */
export async function getRiderBalances(query = {}) {
    const { start, end } = parsePeriod(query);

    const grouped = await prisma.foodTransaction.groupBy({
        by: ['deliveryPartnerId'],
        where: {
            ...periodWhere(start, end),
            isRiderSettled: false,
            deliveryPartnerId: { not: null },
        },
        _sum: { riderShare: true },
        _count: { _all: true },
    });

    if (!grouped.length) {
        return { period: { from: start, to: end }, rows: [], totals: emptyRiderTotals() };
    }

    const partnerIds = grouped.map((g) => g.deliveryPartnerId).filter(Boolean);

    const [partners, cashCollected, cashDeposited, bonuses] = await Promise.all([
        prisma.foodDeliveryPartner.findMany({
            where: { id: { in: partnerIds } },
            select: {
                id: true, name: true, phone: true,
                bankAccountNumber: true, bankIfscCode: true, bankName: true,
                bankAccountHolderName: true, upiId: true,
            },
        }),
        // Cash the rider took at the door, in this period.
        prisma.foodTransaction.groupBy({
            by: ['deliveryPartnerId'],
            where: {
                ...periodWhere(start, end),
                isRiderSettled: false,
                deliveryPartnerId: { in: partnerIds },
                paymentMethod: { in: ['cash', 'razorpay_qr'] },
            },
            _sum: { totalCustomerPaid: true },
        }),
        // Cash they have already handed back.
        prisma.foodDeliveryCashDeposit.groupBy({
            by: ['deliveryPartnerId'],
            where: {
                deliveryPartnerId: { in: partnerIds },
                status: 'Completed',
                createdAt: { gte: start, lte: end },
            },
            _sum: { amount: true },
        }),
        prisma.deliveryBonusTransaction.groupBy({
            by: ['deliveryPartnerId'],
            where: { deliveryPartnerId: { in: partnerIds }, createdAt: { gte: start, lte: end } },
            _sum: { amount: true },
        }),
    ]);

    const byId = new Map(partners.map((p) => [p.id, p]));
    const cashById = new Map(cashCollected.map((c) => [c.deliveryPartnerId, num(c._sum.totalCustomerPaid)]));
    const depositById = new Map((cashDeposited || []).map((d) => [d.deliveryPartnerId, num(d._sum.amount)]));
    const bonusById = new Map(bonuses.map((b) => [b.deliveryPartnerId, num(b._sum.amount)]));

    const rows = grouped
        .map((g) => {
            const id = g.deliveryPartnerId;
            const partner = byId.get(id);
            const earnings = money(g._sum.riderShare);
            const bonus = money(bonusById.get(id) || 0);
            const collected = money(cashById.get(id) || 0);
            const deposited = money(depositById.get(id) || 0);
            const cashInHand = money(Math.max(0, collected - deposited));

            return {
                entityType: 'rider',
                entityId: id,
                name: partner?.name || 'Unknown rider',
                contact: partner?.phone || '',
                deliveries: g._count._all,
                earnings,
                bonus,
                cashCollected: collected,
                cashDeposited: deposited,
                cashInHand,
                // Negative means the rider owes the platform, which happens
                // whenever the cash they are holding exceeds what they earned.
                payable: money(earnings + bonus - cashInHand),
                hasBankDetails: Boolean(
                    (partner?.bankAccountNumber && partner?.bankIfscCode) || partner?.upiId,
                ),
                bank: partner
                    ? {
                          accountHolderName: partner.bankAccountHolderName || '',
                          accountNumber: partner.bankAccountNumber || '',
                          ifscCode: partner.bankIfscCode || '',
                          bankName: partner.bankName || '',
                          upiId: partner.upiId || '',
                      }
                    : null,
            };
        })
        .filter((row) => row.payable !== 0 || row.cashInHand !== 0)
        .sort((a, b) => b.payable - a.payable);

    return {
        period: { from: start, to: end },
        rows,
        totals: {
            entities: rows.length,
            deliveries: rows.reduce((sum, r) => sum + r.deliveries, 0),
            earnings: money(rows.reduce((sum, r) => sum + r.earnings, 0)),
            bonus: money(rows.reduce((sum, r) => sum + r.bonus, 0)),
            cashInHand: money(rows.reduce((sum, r) => sum + r.cashInHand, 0)),
            payable: money(rows.reduce((sum, r) => sum + r.payable, 0)),
        },
    };
}

const emptyRiderTotals = () => ({
    entities: 0, deliveries: 0, earnings: 0, bonus: 0, cashInHand: 0, payable: 0,
});

// ─── Paying out ──────────────────────────────────────────────────────────────

/**
 * Settle one entity for one period.
 *
 * The flag update and the Settlement row go in one transaction, and the update
 * is scoped to `isSettled: false` rather than to a list of ids read earlier --
 * so if two admins run the same period at once, the second settles nothing
 * instead of paying twice. `count` is what actually moved, and a zero means
 * somebody got there first.
 */
export async function payoutEntity(entityType, entityId, body = {}) {
    if (!isId(entityId)) throw new ValidationError('Invalid entity id');
    if (!['restaurant', 'rider'].includes(entityType)) {
        throw new ValidationError('entityType must be "restaurant" or "rider"');
    }

    const { start, end } = parsePeriod(body);
    const isRestaurant = entityType === 'restaurant';

    const scope = isRestaurant
        ? { restaurantId: String(entityId), isRestaurantSettled: false }
        : { deliveryPartnerId: String(entityId), isRiderSettled: false };

    return prisma.$transaction(async (tx) => {
        const pending = await tx.foodTransaction.aggregate({
            where: { ...periodWhere(start, end), ...scope },
            _sum: isRestaurant ? { restaurantShare: true } : { riderShare: true },
            _count: { _all: true },
        });

        if (!pending._count._all) {
            throw new ValidationError('Nothing outstanding for this period');
        }

        const amount = money(
            isRestaurant ? pending._sum.restaurantShare : pending._sum.riderShare,
        );

        const { count } = await tx.foodTransaction.updateMany({
            where: { ...periodWhere(start, end), ...scope },
            data: isRestaurant
                ? { isRestaurantSettled: true, restaurantSettledAt: new Date() }
                : { isRiderSettled: true, riderSettledAt: new Date() },
        });

        if (!count) throw new ValidationError('Nothing outstanding for this period');

        const settlement = await tx.settlement.create({
            data: {
                entityType: isRestaurant ? 'restaurant' : 'deliveryBoy',
                entityId: String(entityId),
                amount,
                status: 'processed',
                payoutRef: String(body.reference || ''),
                periodStart: start,
                periodEnd: end,
                processedAt: new Date(),
                processedBy: body.adminId ? String(body.adminId) : null,
                notes: String(body.notes || ''),
                // The transaction count is the audit trail: it says how many
                // orders this settlement closed, so a later reconciliation can
                // check the sum against them.
                metadata: { transactionsSettled: count },
            },
        });

        return {
            settlementId: settlement.id,
            entityType,
            entityId: String(entityId),
            amount,
            transactionsSettled: count,
            period: { from: start, to: end },
        };
    });
}

/** Past payout runs, newest first. */
export async function getSettlementHistory(query = {}) {
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(200, Math.max(1, Number(query.limit) || 50));

    const where = {
        ...(query.entityType === 'restaurant' ? { entityType: 'restaurant' } : {}),
        ...(query.entityType === 'rider' ? { entityType: 'deliveryBoy' } : {}),
        ...(isId(query.entityId) ? { entityId: String(query.entityId) } : {}),
    };

    const [rows, total] = await Promise.all([
        prisma.settlement.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            skip: (page - 1) * limit,
            take: limit,
        }),
        prisma.settlement.count({ where }),
    ]);

    return {
        settlements: rows.map((row) => ({
            id: row.id,
            entityType: row.entityType === 'deliveryBoy' ? 'rider' : row.entityType,
            entityId: row.entityId,
            amount: money(row.amount),
            status: row.status,
            payoutRef: row.payoutRef,
            periodStart: row.periodStart,
            periodEnd: row.periodEnd,
            processedAt: row.processedAt,
            notes: row.notes,
            transactionsSettled: row.metadata?.transactionsSettled ?? null,
            createdAt: row.createdAt,
        })),
        pagination: { page, limit, total },
    };
}
