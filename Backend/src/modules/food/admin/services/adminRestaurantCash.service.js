import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { ValidationError, NotFoundError } from '../../../../core/auth/errors.js';
import { getRestaurantFinance, getWalletSummaries } from '../../restaurant/services/restaurantFinance.service.js';
import { lockRestaurantBalance } from '../../restaurant/services/restaurantPayout.service.js';
import {
    CASH_COLLECTION_METHODS,
    assertCollectable,
    money,
    readCashCollectionBody,
    walletCards,
} from './adminRestaurantCash.helpers.js';

/**
 * The money side of the admin restaurant details page: the old panel's cards
 * (Collected Cash By Store, Pending Withdraw, Total Withdrawal Amount,
 * Withdraw Able Balance, Total Earning) and "Collect Cash From Store".
 *
 * Restaurants here never take the platform's cash on an order -- riders
 * collect cash on delivery -- so "collected cash" is what a restaurant holds
 * because its withdrawals and subscription deductions outran its earnings
 * (an order refunded after it was paid out). Collecting it is recorded in
 * food_restaurant_cash_collections, which getWalletSummaries adds back, so
 * the debt is settled instead of eating the restaurant's next earnings.
 */

const serialize = (row) => ({
    id: row.id,
    restaurantId: row.restaurantId,
    amount: Number(row.amount),
    method: row.paymentMethod,
    reference: row.reference || '',
    note: row.note || '',
    adminId: row.adminId || null,
    createdAt: row.createdAt,
});

const withdrawalTotals = async (restaurantId, db = prisma) => {
    const rows = await db.foodRestaurantWithdrawal.groupBy({
        by: ['status'],
        where: { restaurantId, status: { in: ['pending', 'approved'] } },
        _sum: { amount: true },
        _count: { _all: true },
    });
    const of = (status) => rows.find((row) => row.status === status);
    return {
        pendingAmount: money(of('pending')?._sum?.amount),
        pendingCount: of('pending')?._count?._all || 0,
        approvedAmount: money(of('approved')?._sum?.amount),
    };
};

/** The money cards for one restaurant. */
export async function getRestaurantWalletOverview(restaurantId) {
    if (!isId(restaurantId)) throw new ValidationError('Invalid restaurant');
    const id = String(restaurantId);

    const restaurant = await prisma.foodRestaurant.findUnique({ where: { id }, select: { id: true } });
    if (!restaurant) throw new NotFoundError('Restaurant not found');

    const [summaries, totals] = await Promise.all([
        getWalletSummaries([id]),
        withdrawalTotals(id),
    ]);
    return {
        restaurantId: id,
        ...walletCards(summaries.get(id), totals),
        pendingWithdrawCount: totals.pendingCount,
        methods: CASH_COLLECTION_METHODS,
    };
}

/**
 * Record cash the admin collected from a restaurant. Under the restaurant's
 * balance lock -- the one payouts and withdrawal requests take -- so what it
 * owes is read and settled with nothing moving in between.
 */
export async function collectCashFromRestaurant(restaurantId, body = {}, adminId = null) {
    if (!isId(restaurantId)) throw new ValidationError('Invalid restaurant');
    const { amount, method, reference, note, requestKey } = readCashCollectionBody(body);
    const id = String(restaurantId);

    return prisma.$transaction(async (tx) => {
        await lockRestaurantBalance(tx, id);

        const restaurant = await tx.foodRestaurant.findUnique({ where: { id }, select: { id: true } });
        if (!restaurant) throw new NotFoundError('Restaurant not found');

        if (requestKey) {
            const same = await tx.foodRestaurantCashCollection.findFirst({
                where: { restaurantId: id, requestKey },
            });
            // Already recorded by an earlier attempt: hand it back, do not collect twice.
            if (same) return { ...serialize(same), duplicate: true };
        }

        const summary = (await getWalletSummaries([id], { db: tx })).get(id);
        assertCollectable(amount, summary?.cashOwed);

        const row = await tx.foodRestaurantCashCollection.create({
            data: {
                restaurantId: id,
                amount,
                paymentMethod: method,
                reference: reference || null,
                note: note || null,
                adminId: isId(adminId) ? String(adminId) : null,
                requestKey: requestKey || null,
            },
        });
        return serialize(row);
    }, { timeout: 20000 });
}

/**
 * One page of the restaurant's earned orders with its share of each -- the
 * same rows and arithmetic the restaurant's own finance screen shows.
 */
export async function getRestaurantEarnings(restaurantId, query = {}) {
    if (!isId(restaurantId)) throw new ValidationError('Invalid restaurant');
    const finance = await getRestaurantFinance(String(restaurantId), {
        ordersPage: query.page,
        ordersLimit: query.limit,
    });
    if (!finance) throw new NotFoundError('Restaurant not found');
    return {
        orders: finance.wallet.orders,
        pagination: finance.wallet.pagination,
        totals: {
            totalEarnings: money(finance.wallet.totalEarnings),
            totalOrders: finance.wallet.totalOrders,
        },
    };
}

/** Collections for one restaurant, newest first, with the total. */
export async function listRestaurantCashCollections(restaurantId, query = {}) {
    if (!isId(restaurantId)) throw new ValidationError('Invalid restaurant');
    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 25, 1), 200);
    const where = { restaurantId: String(restaurantId) };

    const [rows, total, sum] = await Promise.all([
        prisma.foodRestaurantCashCollection.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            skip: (page - 1) * limit,
            take: limit,
        }),
        prisma.foodRestaurantCashCollection.count({ where }),
        prisma.foodRestaurantCashCollection.aggregate({ where, _sum: { amount: true } }),
    ]);

    return {
        collections: rows.map(serialize),
        totals: { count: total, amount: money(sum._sum?.amount) },
        pagination: { total, page, limit, pages: Math.ceil(total / limit) || 1 },
    };
}
