import { prisma } from '../../../../config/prisma.js';
import { ValidationError } from '../../../../core/auth/errors.js';
import { getRestaurantFinance } from './restaurantFinance.service.js';

/**
 * A restaurant asking to be paid out. Admin acts on these in
 * adminWithdrawal.service.js.
 */

// Decimal columns reach JSON as strings otherwise.
const serialize = (w) => ({ ...w, amount: Number(w.amount) });

const rupees = (value) => `₹${Number(value).toLocaleString('en-IN')}`;

export async function createWithdrawalRequest(restaurantId, { amount, bankDetails } = {}) {
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) throw new ValidationError('Invalid withdrawal amount');

    const finance = await getRestaurantFinance(restaurantId);

    const lockedAmount = Math.max(0, Number(finance?.subscription?.lockedAmount || 0));
    const lockedMonths = String(finance?.subscription?.lockedMonths || '');
    const netAvailable = Math.max(
        0,
        Number(finance?.wallet?.netAvailable ?? finance?.currentCycle?.netAvailable ?? 0),
    );

    // ponytail: the balance is derived from order aggregates, not a stored
    // column, so two requests sent at once can both pass this check. Bounded by
    // admin approval today. A wallet balance column with a conditional update
    // is the fix if that stops being enough.
    if (value > netAvailable) {
        if (lockedAmount > 0) {
            throw new ValidationError(
                `Withdrawal restricted. ${rupees(lockedAmount)} is locked against subscription dues`
                + `${lockedMonths ? ` for ${lockedMonths}` : ''}.`
                + ` Available to withdraw: ${rupees(netAvailable)}`,
            );
        }
        throw new ValidationError(`Insufficient balance. Available to withdraw: ${rupees(netAvailable)}`);
    }

    const withdrawal = await prisma.foodRestaurantWithdrawal.create({
        data: { restaurantId, amount: value, bankDetails: bankDetails ?? undefined, status: 'pending' },
    });

    return serialize(withdrawal);
}

export async function listMyWithdrawals(restaurantId) {
    const rows = await prisma.foodRestaurantWithdrawal.findMany({
        where: { restaurantId },
        orderBy: { createdAt: 'desc' },
    });
    return rows.map(serialize);
}
