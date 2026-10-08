import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { ValidationError, NotFoundError } from '../../../../core/auth/errors.js';
import { getWalletSummaries } from '../../restaurant/services/restaurantFinance.service.js';
import { lockRestaurantBalance } from '../../restaurant/services/restaurantPayout.service.js';
import { getPayoutSnapshot } from './withdrawalMethods.service.js';
import { emailWithdrawalDecision } from '../../../../core/notifications/emailEvents.js';

/**
 * Restaurant payments: the old panel's "provide payment". The admin has paid
 * a restaurant outside the system (bank transfer, UPI, cash, cheque) and
 * records it here.
 *
 * A payment is a restaurant withdrawal with source 'admin_payment', already
 * approved. That is deliberate: the restaurant's balance is derived as
 * earnings minus pending and approved withdrawals (restaurantFinance), so the
 * payment comes off the balance the moment it is written -- the same money
 * cannot then be paid again by the daily payout run or asked for by the
 * restaurant. It also shows in the restaurant's own withdrawal history.
 *
 * Settling the balance-sheet flags instead would leave the balance untouched,
 * which is exactly why the balance sheet refuses restaurants.
 */

export const ADMIN_PAYMENT_SOURCE = 'admin_payment';
export const PAYMENT_METHODS = ['bank_transfer', 'upi', 'cash', 'cheque', 'other'];

const money = (value) => Math.round((Number(value) || 0) * 100) / 100;
const rupees = (value) => `₹${money(value).toLocaleString('en-IN')}`;

const serialize = (row) => ({
    id: row.id,
    restaurantId: row.restaurantId,
    restaurantName: row.restaurant?.restaurantName || '',
    amount: Number(row.amount),
    method: row.paymentMethod,
    reference: row.transactionId || '',
    note: row.adminNote || '',
    payoutMethod: row.bankDetails?.payoutMethod || null,
    paidAt: row.processedAt || row.createdAt,
    createdAt: row.createdAt,
});

/** Read and check what the admin entered. Pure, so it is tested on its own. */
export function readPaymentBody(body = {}) {
    const amount = money(body.amount);
    if (!(amount > 0)) throw new ValidationError('Amount must be greater than zero');
    if (amount > 10000000) throw new ValidationError('Amount is too large');

    const method = String(body.method || '').trim().toLowerCase();
    if (!PAYMENT_METHODS.includes(method)) {
        throw new ValidationError(`Method must be one of: ${PAYMENT_METHODS.join(', ')}`);
    }

    const reference = String(body.reference ?? '').trim().slice(0, 120);
    const note = String(body.note ?? '').trim().slice(0, 500);
    // A key the form makes once per payment, so a double click or a retried
    // request records the payment once.
    const requestKey = String(body.requestKey ?? '').trim().slice(0, 64);
    return { amount, method, reference, note, requestKey };
}

/** What a restaurant can be paid now, and where to pay it. */
export async function getRestaurantPayable(restaurantId) {
    if (!isId(restaurantId)) throw new ValidationError('Invalid restaurant');
    const restaurant = await prisma.foodRestaurant.findUnique({
        where: { id: String(restaurantId) },
        select: {
            id: true, restaurantName: true, accountHolderName: true, accountNumber: true,
            ifscCode: true, upiId: true, payoutMethod: true,
        },
    });
    if (!restaurant) throw new NotFoundError('Restaurant not found');

    const [summary, payoutMethod, pending] = await Promise.all([
        getWalletSummaries([restaurant.id]).then((map) => map.get(restaurant.id)),
        getPayoutSnapshot('restaurant', restaurant.id),
        prisma.foodRestaurantWithdrawal.aggregate({
            where: { restaurantId: restaurant.id, status: 'pending' },
            _sum: { amount: true },
            _count: true,
        }),
    ]);

    return {
        restaurantId: restaurant.id,
        restaurantName: restaurant.restaurantName,
        balance: money(summary?.walletBalance),
        payable: money(summary?.netAvailable),
        lockedAmount: money(summary?.lockedAmount),
        pendingRequests: { count: pending._count || 0, amount: money(pending._sum?.amount) },
        bank: {
            accountHolderName: restaurant.accountHolderName || '',
            accountNumber: restaurant.accountNumber || '',
            ifscCode: restaurant.ifscCode || '',
            upiId: restaurant.upiId || '',
            preferred: restaurant.payoutMethod || '',
        },
        payoutMethod,
    };
}

/**
 * Record one payment. Under the restaurant's balance lock -- the one the
 * payout run and withdrawal requests take -- so the balance read here is the
 * balance the payment comes off, and nothing else can spend it in between.
 */
export async function recordRestaurantPayment(restaurantId, body = {}, adminId = null) {
    if (!isId(restaurantId)) throw new ValidationError('Invalid restaurant');
    const { amount, method, reference, note, requestKey } = readPaymentBody(body);
    const id = String(restaurantId);

    const payment = await prisma.$transaction(async (tx) => {
        await lockRestaurantBalance(tx, id);

        const restaurant = await tx.foodRestaurant.findUnique({ where: { id }, select: { id: true } });
        if (!restaurant) throw new NotFoundError('Restaurant not found');

        if (requestKey) {
            const same = await tx.foodRestaurantWithdrawal.findFirst({
                where: {
                    restaurantId: id,
                    source: ADMIN_PAYMENT_SOURCE,
                    bankDetails: { path: ['requestKey'], equals: requestKey },
                },
                include: { restaurant: { select: { restaurantName: true } } },
            });
            // Already recorded by an earlier attempt: hand it back, do not pay twice.
            if (same) return { ...serialize(same), duplicate: true };
        }
        if (reference) {
            const clash = await tx.foodRestaurantWithdrawal.count({
                where: { restaurantId: id, source: ADMIN_PAYMENT_SOURCE, transactionId: reference },
            });
            if (clash) throw new ValidationError('A payment with this reference is already recorded for this restaurant');
        }

        const summary = (await getWalletSummaries([id], { db: tx })).get(id);
        const payable = money(summary?.netAvailable);
        if (amount > payable) {
            throw new ValidationError(
                `That is more than the restaurant is owed. Payable now: ${rupees(payable)}`
                + (summary?.lockedAmount > 0 ? ` (${rupees(summary.lockedAmount)} is held for subscription dues)` : ''),
            );
        }

        const payoutMethod = await getPayoutSnapshot('restaurant', id, tx);
        const row = await tx.foodRestaurantWithdrawal.create({
            data: {
                restaurantId: id,
                amount,
                status: 'approved',
                source: ADMIN_PAYMENT_SOURCE,
                paymentMethod: method,
                transactionId: reference || null,
                adminNote: note || null,
                processedAt: new Date(),
                bankDetails: {
                    recordedBy: adminId ? String(adminId) : null,
                    ...(requestKey ? { requestKey } : {}),
                    ...(payoutMethod ? { payoutMethod } : {}),
                },
            },
            include: { restaurant: { select: { restaurantName: true } } },
        });
        return serialize(row);
    }, { timeout: 20000 });
    // A repeat of the same request hands back the same row, so the same email key.
    emailWithdrawalDecision('restaurant', payment?.id);
    return payment;
}

const parseDay = (value, endOfDay) => {
    if (!value) return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) throw new ValidationError('Invalid date');
    if (endOfDay) date.setHours(23, 59, 59, 999);
    else date.setHours(0, 0, 0, 0);
    return date;
};

/** Recorded payments, newest first, with the total for the filter. */
export async function listRestaurantPayments(query = {}) {
    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 25, 1), 500);
    const from = parseDay(query.from, false);
    const to = parseDay(query.to, true);
    const search = String(query.search || '').trim();

    const where = {
        source: ADMIN_PAYMENT_SOURCE,
        ...(isId(query.restaurantId) ? { restaurantId: String(query.restaurantId) } : {}),
        ...(PAYMENT_METHODS.includes(query.method) ? { paymentMethod: query.method } : {}),
        ...(from || to ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
        ...(search
            ? {
                OR: [
                    { restaurant: { restaurantName: { contains: search, mode: 'insensitive' } } },
                    { transactionId: { contains: search, mode: 'insensitive' } },
                ],
            }
            : {}),
    };

    const [rows, total, sum] = await Promise.all([
        prisma.foodRestaurantWithdrawal.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            skip: (page - 1) * limit,
            take: limit,
            include: { restaurant: { select: { restaurantName: true } } },
        }),
        prisma.foodRestaurantWithdrawal.count({ where }),
        prisma.foodRestaurantWithdrawal.aggregate({ where, _sum: { amount: true } }),
    ]);

    return {
        payments: rows.map(serialize),
        totals: { count: total, amount: money(sum._sum?.amount) },
        pagination: { total, page, limit, pages: Math.ceil(total / limit) || 1 },
    };
}
