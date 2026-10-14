import { ValidationError } from '../../../../core/auth/errors.js';

/**
 * The rules behind "Collect Cash From Store" and the money cards on the admin
 * restaurant details page, kept free of the database so they are tested on
 * their own (adminRestaurantCash.helpers.test.js).
 */

export const CASH_COLLECTION_METHODS = ['cash', 'bank_transfer', 'upi', 'cheque', 'other'];

const num = (value) => Number(value ?? 0) || 0;

/** Rupees rounded to paise, as every Decimal(14,2) column stores them. */
export const money = (value) => Math.round(num(value) * 100) / 100;

const rupees = (value) => `₹${money(value).toLocaleString('en-IN')}`;

/** Read and check what the admin entered on the collect-cash form. */
export function readCashCollectionBody(body = {}) {
    const amount = money(body.amount);
    if (!(amount > 0)) throw new ValidationError('Amount must be greater than zero');
    if (amount > 10000000) throw new ValidationError('Amount is too large');

    const method = String(body.method || 'cash').trim().toLowerCase();
    if (!CASH_COLLECTION_METHODS.includes(method)) {
        throw new ValidationError(`Method must be one of: ${CASH_COLLECTION_METHODS.join(', ')}`);
    }

    const reference = String(body.reference ?? '').trim().slice(0, 120);
    const note = String(body.note ?? '').trim().slice(0, 500);
    // One key per form submit, so a double click or a retried request
    // records the collection once.
    const requestKey = String(body.requestKey ?? '').trim().slice(0, 64);
    return { amount, method, reference, note, requestKey };
}

/**
 * A collection may settle what the restaurant owes and no more: collecting
 * past that would turn the restaurant's debt into money the platform owes it,
 * which is a payment, not a collection (Restaurant Payments records those).
 */
export function assertCollectable(amount, cashOwed) {
    const owed = money(cashOwed);
    if (!(owed > 0)) {
        throw new ValidationError('This restaurant holds no cash owed to the platform');
    }
    if (money(amount) > owed) {
        throw new ValidationError(`That is more than the restaurant owes. Cash owed now: ${rupees(owed)}`);
    }
}

/**
 * The money cards, in the old panel's order, from one wallet summary
 * (restaurantFinance.getWalletSummaries) plus the withdrawal totals by status.
 */
export function walletCards(summary = {}, { pendingAmount = 0, approvedAmount = 0 } = {}) {
    return {
        collectedCash: money(summary.cashOwed),
        pendingWithdraw: money(pendingAmount),
        totalWithdrawn: money(approvedAmount),
        withdrawableBalance: money(summary.netAvailable),
        totalEarning: money(summary.totalEarnings),
        walletBalance: money(summary.walletBalance),
        lockedAmount: money(summary.lockedAmount),
        totalCashCollected: money(summary.totalCashCollected),
    };
}
