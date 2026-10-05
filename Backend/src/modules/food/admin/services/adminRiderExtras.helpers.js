/**
 * The arithmetic behind delivery man payouts, payments and the earning
 * report, kept free of the database so it can be tested on its own.
 */

const num = (value) => Number(value ?? 0) || 0;

/** Rupees rounded to paise, as every Decimal(14,2) column stores them. */
export const money = (value) => Math.round(num(value) * 100) / 100;

/** How a rider was paid. 'manual' is a withdrawal the rider asked for. */
export const RIDER_PAYOUT_SOURCES = ['manual', 'disbursement', 'admin_payment', 'balance_sheet'];

export const RIDER_PAYMENT_METHODS = ['cash', 'bank_transfer', 'upi', 'other'];

/**
 * What a rider can still be paid, worked out exactly as the rider's wallet
 * screen and withdrawal request work it out (deliveryFinance.service.js), so
 * an admin payout can never pay more than the rider could withdraw.
 *
 * The rider's money has two records: totals over orders, bonuses and
 * withdrawals, and the wallet ledger row. The larger of each is taken, as the
 * wallet does. Pending withdrawals are already promised and count as spent.
 *
 * @returns {{ available: number, effectiveLocked: number, targetLedgerBalance: number }}
 *   targetLedgerBalance is what the ledger must hold for the available money
 *   to be debitable; the caller posts the gap as a credit before debiting.
 */
export function riderWithdrawable({ earned = 0, bonus = 0, approved = 0, pending = 0, wallet = null } = {}) {
    const balance = num(wallet?.balance);
    const locked = num(wallet?.lockedAmount);

    const totalEarned = Math.max(num(earned), num(wallet?.totalEarnings));
    const totalBonus = Math.max(num(bonus), num(wallet?.totalBonus));
    const totalWithdrawn = Math.max(num(approved), num(wallet?.totalSettled));
    const pendingTotal = num(pending);

    const computed = Math.max(0, totalEarned + totalBonus - (totalWithdrawn + pendingTotal));
    const effectiveLocked = Math.max(locked, pendingTotal);
    const fromWallet = Math.max(0, balance - effectiveLocked);
    const available = money(Math.max(computed, fromWallet));

    return {
        available,
        effectiveLocked: money(effectiveLocked),
        targetLedgerBalance: money(Math.max(balance, effectiveLocked + available)),
    };
}

/**
 * A batch's status from its lines: pending until one is decided, completed
 * when every line is paid, canceled when every line failed.
 * Line statuses are the withdrawal ones: pending, approved (paid), rejected (failed).
 */
export function batchStatusFor(statuses = []) {
    if (!statuses.length) return 'completed';
    if (statuses.every((s) => s === 'approved')) return 'completed';
    if (statuses.every((s) => s === 'rejected')) return 'canceled';
    if (statuses.every((s) => s === 'pending')) return 'pending';
    if (statuses.some((s) => s === 'pending')) return 'partially_completed';
    // Every line decided, some paid and some failed.
    return 'completed';
}

/**
 * Where a rider's payout goes, snapshotted onto the line so the admin pays the
 * details that were on file when the batch was made. Null when the rider has
 * neither a complete bank account nor a UPI id.
 */
export function resolveRiderPayee(partner = {}) {
    if (partner.bankAccountNumber && partner.bankIfscCode) {
        return {
            paymentMethod: 'bank_transfer',
            bankDetails: {
                accountHolderName: partner.bankAccountHolderName || '',
                accountNumber: partner.bankAccountNumber,
                ifscCode: partner.bankIfscCode,
                bankName: partner.bankName || '',
            },
        };
    }
    if (partner.upiId) {
        return { paymentMethod: 'upi', bankDetails: { upiId: partner.upiId } };
    }
    return null;
}

/** The last ten digits, which is how riders' phones are stored and logged in with. */
export function normalizeRiderPhone(phone) {
    const digits = String(phone ?? '').replace(/\D/g, '');
    return digits.length >= 10 ? digits.slice(-10) : null;
}

/** A vehicle category's coverage must make sense before it is stored. */
export function checkCoverage({ startingCoverageKm, maxCoverageKm }) {
    const start = num(startingCoverageKm);
    const max = num(maxCoverageKm);
    if (start < 0) return 'Starting coverage cannot be negative';
    if (!(max > 0)) return 'Maximum coverage must be more than 0 km';
    if (max < start) return 'Maximum coverage must be at least the starting coverage';
    return null;
}
