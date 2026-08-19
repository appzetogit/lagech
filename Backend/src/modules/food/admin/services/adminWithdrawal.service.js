import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { ValidationError } from '../../../../core/auth/errors.js';

/**
 * Withdrawal approvals, extracted from admin.service.js.
 *
 * This is a payout path, and the Mongo version was a read-check-write: it
 * loaded the request, confirmed it was still pending, loaded the wallet,
 * compared the balance, and only then wrote — with the wallet debit and the
 * status change as separate statements. Two admins clicking approve at the same
 * moment both saw `pending` and both debited, so the rider was paid twice.
 *
 * The transition is claimed with a conditional update instead, and the debit
 * shares its transaction. Whoever loses the race gets "already processed".
 */

const WITHDRAWAL_STATUSES = ['pending', 'approved', 'rejected'];

/** The admin table renders the status capitalised. */
const titleCase = (value) => {
    const s = String(value || '');
    return s.charAt(0).toUpperCase() + s.slice(1);
};

const RESTAURANT_PAYEE = {
    select: {
        id: true, restaurantName: true, profileImage: true, ownerName: true,
        ownerPhone: true, accountHolderName: true, accountNumber: true,
        ifscCode: true, accountType: true, upiId: true, upiQrImage: true,
    },
};

const PARTNER_PAYEE = {
    select: { id: true, name: true, phone: true, upiId: true, upiQrCode: true },
};

const serializeRestaurantWithdrawal = (w) => ({
    ...w,
    id: w.id,
    amount: Number(w.amount),
    restaurantName: w.restaurant?.restaurantName || 'N/A',
    restaurantIdString: w.restaurant ? `REST${w.restaurant.id.slice(-6).padStart(6, '0')}` : 'N/A',
    restaurantBankDetails: {
        accountHolderName: w.restaurant?.accountHolderName || '',
        accountNumber: w.restaurant?.accountNumber || '',
        ifscCode: w.restaurant?.ifscCode || '',
        accountType: w.restaurant?.accountType || '',
        upiId: w.restaurant?.upiId || '',
        upiQrImage: w.restaurant?.upiQrImage || '',
    },
    status: titleCase(w.status),
});

const serializeDeliveryWithdrawal = (w) => ({
    ...w,
    id: w.id,
    amount: Number(w.amount),
    deliveryName: w.deliveryPartner?.name || 'N/A',
    deliveryPhone: w.deliveryPartner?.phone || 'N/A',
    // Mongo carried a stored `profilePartnerId` code; the schema has no such
    // column, so it is derived from the id exactly as the restaurant one is.
    deliveryIdString: w.deliveryPartner ? `DEL${w.deliveryPartner.id.slice(-6).padStart(6, '0')}` : 'N/A',
    status: titleCase(w.status),
});

export async function getWithdrawals(query = {}) {
    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 50, 1), 500);
    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    const skip = (page - 1) * limit;

    const where = {};
    if (query.status && query.status !== 'all') {
        where.status = String(query.status).toLowerCase();
    }
    if (isId(query.restaurantId)) where.restaurantId = String(query.restaurantId);

    const [withdrawals, total] = await Promise.all([
        prisma.foodRestaurantWithdrawal.findMany({
            where,
            include: { restaurant: RESTAURANT_PAYEE },
            orderBy: { createdAt: 'desc' },
            skip,
            take: limit,
        }),
        prisma.foodRestaurantWithdrawal.count({ where }),
    ]);

    return { requests: withdrawals.map(serializeRestaurantWithdrawal), total, page, limit };
}

export async function updateWithdrawalStatus(id, { status, adminNote, rejectionReason, transactionId }) {
    if (!isId(id)) throw new ValidationError('Invalid withdrawal ID');

    const next = String(status || '').toLowerCase();
    if (!WITHDRAWAL_STATUSES.includes(next)) throw new ValidationError('Invalid withdrawal status');

    // Only a pending request can be decided, and the guard is inside the write:
    // two admins deciding at once means one of them loses and is told so,
    // rather than both writing and the last one silently winning.
    const { count } = await prisma.foodRestaurantWithdrawal.updateMany({
        where: { id: String(id), status: 'pending' },
        data: {
            status: next,
            adminNote,
            rejectionReason,
            transactionId,
            processedAt: next === 'pending' ? null : new Date(),
        },
    });

    if (!count) {
        const existing = await prisma.foodRestaurantWithdrawal.findUnique({
            where: { id: String(id) },
            select: { status: true },
        });
        if (!existing) throw new ValidationError('Withdrawal request not found');
        throw new ValidationError(`Cannot change a ${existing.status} withdrawal request`);
    }

    const updated = await prisma.foodRestaurantWithdrawal.findUnique({
        where: { id: String(id) },
        include: { restaurant: { select: { id: true, restaurantName: true } } },
    });
    return { ...updated, amount: Number(updated.amount) };
}

export async function getDeliveryWithdrawals(query = {}) {
    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 100, 1), 500);
    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    const skip = (page - 1) * limit;

    const where = {};
    if (query.status && query.status !== 'All') {
        where.status = String(query.status).toLowerCase();
    }
    // The search box accepts an amount; a name needs the partner table, which
    // the original did not reach either.
    if (query.search && !Number.isNaN(Number(query.search))) {
        where.amount = Number(query.search);
    }

    const [withdrawals, total] = await Promise.all([
        prisma.foodDeliveryWithdrawal.findMany({
            where,
            include: { deliveryPartner: PARTNER_PAYEE },
            orderBy: { createdAt: 'desc' },
            skip,
            take: limit,
        }),
        prisma.foodDeliveryWithdrawal.count({ where }),
    ]);

    return { requests: withdrawals.map(serializeDeliveryWithdrawal), total, page, limit };
}

export async function updateDeliveryWithdrawalStatus(
    id,
    { status, adminNote, rejectionReason, transactionId },
) {
    if (!isId(id)) throw new ValidationError('Invalid withdrawal ID');

    // 'processed' is what the admin UI sends for an approval.
    const raw = String(status || '').toLowerCase();
    const next = raw === 'processed' ? 'approved' : raw;
    if (!WITHDRAWAL_STATUSES.includes(next)) throw new ValidationError('Invalid withdrawal status');

    await prisma.$transaction(async (tx) => {
        // Claim the request first. Everything below only runs for the caller
        // that actually moved it out of pending.
        const { count } = await tx.foodDeliveryWithdrawal.updateMany({
            where: { id: String(id), status: 'pending' },
            data: {
                status: next,
                adminNote,
                rejectionReason,
                transactionId,
                processedAt: next === 'pending' ? null : new Date(),
            },
        });

        if (!count) {
            const existing = await tx.foodDeliveryWithdrawal.findUnique({
                where: { id: String(id) },
                select: { status: true },
            });
            if (!existing) throw new ValidationError('Withdrawal request not found');
            if (existing.status === next) return; // Already in the requested state.
            throw new ValidationError(`Cannot change a ${existing.status} withdrawal request`);
        }

        if (next === 'pending') return;

        const claimed = await tx.foodDeliveryWithdrawal.findUnique({
            where: { id: String(id) },
            select: { deliveryPartnerId: true, amount: true },
        });
        const amount = Number(claimed.amount) || 0;
        if (amount <= 0) return;

        const walletKey = {
            entityType_entityId: {
                entityType: 'deliveryBoy',
                entityId: claimed.deliveryPartnerId,
            },
        };
        const wallet = await tx.wallet.findUnique({ where: walletKey });
        const locked = Number(wallet?.lockedAmount) || 0;

        if (next === 'approved') {
            // ponytail: this moves the balance without posting to the ledger,
            // so an approved rider withdrawal leaves the wallet lighter with
            // nothing in the rider's transaction history explaining it — the
            // same gap that manual wallet adjustments had. settlement.service
            // does the equivalent through recordTransaction and gets an entry.
            //
            // Not fixed here because recordTransaction opens its own
            // interactive transaction and this work is already inside one, so
            // it needs an optional client parameter threaded through it first.
            // Worth doing with the suite running against a real database.
            //
            // Conditional on the balance still covering it, so the check and
            // the debit are one statement. wallet_balance_non_negative would
            // refuse an overdraw anyway; this reports it as a sentence.
            const { count: debited } = await tx.wallet.updateMany({
                where: {
                    entityType: 'deliveryBoy',
                    entityId: claimed.deliveryPartnerId,
                    balance: { gte: amount },
                },
                data: {
                    balance: { decrement: amount },
                    totalSettled: { increment: amount },
                    lockedAmount: { decrement: Math.min(locked, amount) },
                },
            });

            if (!debited) {
                throw new ValidationError('Delivery wallet balance is lower than the requested amount');
            }
        }

        // Rejecting releases whatever the request had reserved.
        if (next === 'rejected' && locked > 0) {
            await tx.wallet.update({
                where: walletKey,
                data: { lockedAmount: { decrement: Math.min(locked, amount) } },
            });
        }
    });

    const updated = await prisma.foodDeliveryWithdrawal.findUnique({
        where: { id: String(id) },
        include: {
            deliveryPartner: { select: { id: true, name: true, phone: true } },
        },
    });
    return { ...updated, amount: Number(updated.amount) };
}
