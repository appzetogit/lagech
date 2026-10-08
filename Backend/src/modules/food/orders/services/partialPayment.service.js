import { prisma } from '../../../../config/prisma.js';
import { ValidationError } from '../../../../core/auth/errors.js';
import { recordTransaction } from '../../../../core/payments/transaction.service.js';
import { logger } from '../../../../utils/logger.js';
import { initiateRazorpayRefund } from '../helpers/razorpay.helper.js';

/**
 * Partial payment: the customer pays part of an order from their wallet and
 * the rest online (Razorpay) or in cash at the door (Business Settings >
 * Payment > Partial payment, and which of the two may pay the rest).
 *
 * How it is stored:
 *
 *   - `paymentMethod` is the method that pays the REST ('razorpay' or 'cash'),
 *     so every existing online / COD path (gateway order, verify, webhook,
 *     dispatch, rider collection, QR collect, switch-to-cash) runs unchanged;
 *   - `walletAmount` is the wallet part, debited from the wallet in the same
 *     database transaction that inserts the order (one idempotency key per
 *     order), so an order with a wallet part never exists without the debit,
 *     and the debit never happens without the order;
 *   - `paymentAmountDue` is what the gateway or the rider takes:
 *     total - walletAmount.
 *
 * The wallet part goes back to the wallet exactly once (one idempotency key
 * per order, shared by every path that can return it): when the online part is
 * never paid (abandoned, failed or expired pending_payment, gateway errors)
 * and when the order is cancelled or refunded. The online part of a cancelled
 * order is refunded through Razorpay as before; the rider only ever collects
 * the cash part.
 *
 * A full-wallet order (paymentMethod 'wallet') is not a partial payment and
 * is untouched by all of this.
 */

const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;

/** Methods that may pay the rest. 'card' is accepted as an alias of razorpay by createOrder. */
export const PARTIAL_REMAINDER_METHODS = ['razorpay', 'cash'];

export const walletDebitKey = (orderId) => `partial_wallet_debit:${orderId}`;
export const walletReturnKey = (orderId) => `partial_wallet_return:${orderId}`;

const methodOf = (order) => String(order?.paymentMethod || order?.payment?.method || '').toLowerCase();

/** The wallet part of an order; 0 for anything that is not a partial payment. */
export function orderWalletAmount(order) {
    if (methodOf(order) === 'wallet') return 0;
    const value = Number(order?.walletAmount ?? order?.payment?.walletAmount ?? 0);
    return Number.isFinite(value) && value > 0 ? round2(value) : 0;
}

export const isPartialPayment = (order) => orderWalletAmount(order) > 0;

/** What the gateway charges or the rider collects: the total less the wallet part. */
export function remainderAmount(order) {
    const total = Number(order?.total ?? order?.pricing?.total ?? 0);
    return round2(Math.max(0, total - orderWalletAmount(order)));
}

/** "Wallet + Razorpay" style label for reports. */
export function partialPaymentLabel(method, label = method) {
    return `Wallet + ${label}`;
}

/**
 * The split for an order the customer asked to pay partly by wallet. Pure.
 *
 * @param {object} p
 * @param {string} p.method          the method for the rest (already normalised: card -> razorpay)
 * @param {number} p.total           the order total
 * @param {number} p.balance         the wallet balance now
 * @param {number} [p.walletAmount]  the wallet part the customer was shown, if the app sent it
 * @param {object} p.payment         Business Settings > Payment (cleaned)
 * @param {object} p.customer        Business Settings > Customer (cleaned)
 * @returns {{ walletAmount: number, remainder: number }}
 */
export function planPartialPayment({ method, total, balance, walletAmount, payment, customer }) {
    if (!payment?.partialPayment || !customer?.walletEnabled) {
        throw new ValidationError('Paying part of an order with the wallet is not available right now. Please choose another payment method.');
    }
    if (!PARTIAL_REMAINDER_METHODS.includes(method)) {
        throw new ValidationError('Pay the rest of a wallet payment online or with cash on delivery.');
    }
    const allowed = payment.partialPaymentMethod || 'both';
    if (allowed === 'cod' && method !== 'cash') {
        throw new ValidationError('The rest of a wallet payment can only be paid with cash on delivery.');
    }
    if (allowed === 'digital' && method !== 'razorpay') {
        throw new ValidationError('The rest of a wallet payment can only be paid online.');
    }

    const orderTotal = round2(total);
    const available = round2(balance);
    if (!(available > 0)) {
        throw new ValidationError('Your wallet balance is empty. Please choose another payment method.');
    }

    let wallet;
    if (walletAmount !== undefined && walletAmount !== null) {
        const shown = round2(walletAmount);
        if (!(shown > 0)) throw new ValidationError('Invalid wallet amount');
        // The balance dropped since checkout was shown: the rest would be more
        // than the customer agreed to, so stop and let them look again.
        if (shown > available) {
            throw new ValidationError(
                `Your wallet balance has changed (₹${available} now). Please review the payment and try again.`,
            );
        }
        wallet = Math.min(shown, orderTotal);
    } else {
        wallet = Math.min(available, orderTotal);
    }

    if (wallet >= orderTotal) {
        throw new ValidationError('Your wallet covers the whole order. Choose Wallet as the payment method.');
    }
    const remainder = round2(orderTotal - wallet);
    if (method === 'razorpay' && remainder < 1) {
        throw new ValidationError('The amount left to pay online is below ₹1. Please pay with the wallet or in cash.');
    }
    return { walletAmount: round2(wallet), remainder };
}

/**
 * Debit the wallet part inside the transaction that inserts the order. A
 * balance that no longer covers it (another order spent it a moment ago)
 * rolls the whole insert back.
 */
export async function debitPartialWallet(tx, { orderId, displayId, userId, amount }) {
    try {
        await recordTransaction(
            {
                entityType: 'user',
                entityId: String(userId),
                type: 'debit',
                amount: round2(amount),
                description: `Wallet part of order #${displayId || orderId}`,
                category: 'order_payment',
                orderId: String(orderId),
                metadata: { source: 'partial_payment', orderId: String(orderId) },
                idempotencyKey: walletDebitKey(orderId),
            },
            { client: tx },
        );
    } catch (err) {
        if (/Insufficient balance/i.test(err?.message || '')) {
            throw new ValidationError('Your wallet balance has changed. Please review the payment and try again.');
        }
        throw err;
    }
}

const isUniqueViolation = (err) => err?.code === 'P2002' || /Unique constraint/i.test(err?.message || '');

/**
 * Put the wallet part of an order back in the wallet. Idempotent: every path
 * shares one key per order, so it moves money at most once however many of
 * them run, or however often.
 *
 * @param {object} order  needs id, userId, paymentMethod, walletAmount
 * @param {object} [opts]
 * @param {string} [opts.reason]
 * @param {number} [opts.amount]  less than the whole wallet part (an admin's partial refund)
 * @param {object} [opts.client]  a transaction to post inside
 * @returns {Promise<{ returned: number, replayed: boolean }>}
 */
export async function returnPartialWallet(order, { reason = '', amount, client = null } = {}) {
    const wallet = orderWalletAmount(order);
    const value = round2(Math.min(wallet, amount ?? wallet));
    if (!(value > 0)) return { returned: 0, replayed: false };
    const orderId = String(order.id ?? order._id);
    const userId = String(order.userId?.id ?? order.userId?._id ?? order.userId);
    const key = walletReturnKey(orderId);
    const displayId = order.order_id || orderId;
    const db = client ?? prisma;
    if (await db.transaction.findUnique({ where: { idempotencyKey: key }, select: { id: true } })) {
        return { returned: 0, replayed: true };
    }
    try {
        await recordTransaction(
            {
                entityType: 'user',
                entityId: userId,
                type: 'credit',
                amount: value,
                description: `Wallet part of order #${displayId} returned${reason ? `: ${reason}` : ''}`,
                category: 'order_refund',
                orderId,
                metadata: { source: 'partial_payment_return', orderId, reason },
                idempotencyKey: key,
            },
            { client },
        );
        return { returned: value, replayed: false };
    } catch (err) {
        // A concurrent return won the key: the money is back already. (Inside a
        // caller's transaction the error has to propagate -- Postgres has
        // aborted that transaction.)
        if (!client && isUniqueViolation(err)) {
            logger.info(`Partial wallet return for ${orderId} already done by a concurrent call`);
            return { returned: 0, replayed: true };
        }
        throw err;
    }
}

/**
 * The refund for a cancelled (or admin-refunded) partial-payment order.
 * Same contract as applyCancellationRefund in order.service.js: returns a
 * `paymentPatch` for the caller to write with the status change.
 *
 * The wallet part goes back first (it cannot fail for want of a gateway);
 * then the online part, if it was paid, through Razorpay. A requested amount
 * smaller than the total comes off the online part first. Cash the rider
 * collected is not refundable through the app, as for any COD order.
 * A retry after a failed gateway refund does not return the wallet twice.
 */
export async function refundPartialPayment(order, { refundAmount, reason = '' } = {}) {
    const method = methodOf(order);
    const paymentStatus = String(order.paymentStatus || order.payment?.status || '').toLowerCase();
    const refundStatus = String(order.refundStatus || order.payment?.refund?.status || 'none').toLowerCase();
    const result = (extra) => ({ attempted: false, processed: false, paymentPatch: {}, method, ...extra });

    if (paymentStatus === 'refunded' || refundStatus === 'processed') {
        return result({ processed: true, reason: 'already_refunded' });
    }
    const requested = round2(refundAmount ?? order.total ?? order.pricing?.total);
    if (!(requested > 0)) return result({ reason: 'invalid_amount' });

    const wallet = orderWalletAmount(order);
    const onlinePaid = method === 'razorpay' && paymentStatus === 'paid' ? remainderAmount(order) : 0;
    const onlinePart = round2(Math.min(requested, onlinePaid));
    const walletPart = round2(Math.min(Math.max(0, requested - onlinePart), wallet));

    if (walletPart > 0) await returnPartialWallet(order, { reason, amount: walletPart });

    const refunded = round2(walletPart + onlinePart);
    if (onlinePart > 0) {
        const paymentId = String(order.razorpayPaymentId || order.payment?.razorpay?.paymentId || '').trim();
        let gateway = { success: false, error: 'missing_razorpay_payment_id' };
        if (paymentId) {
            try {
                gateway = await initiateRazorpayRefund(paymentId, onlinePart);
            } catch (err) {
                gateway = { success: false, error: err?.message || 'razorpay_refund_failed' };
            }
        }
        if (!gateway.success) {
            return result({
                attempted: true,
                reason: gateway.error || 'razorpay_refund_failed',
                walletReturned: walletPart,
                paymentPatch: { refundStatus: 'failed', refundAmount: refunded },
            });
        }
        return result({
            attempted: true,
            processed: true,
            refundId: gateway.refundId,
            walletReturned: walletPart,
            paymentPatch: {
                paymentStatus: 'refunded',
                refundStatus: 'processed',
                refundAmount: refunded,
                refundId: gateway.refundId,
                refundProcessedAt: new Date(),
            },
        });
    }

    if (!(walletPart > 0)) return result({ reason: 'nothing_refundable' });
    return result({
        attempted: true,
        processed: true,
        walletReturned: walletPart,
        paymentPatch: {
            // An unpaid cash remainder stays cod_pending: nothing was collected.
            ...(paymentStatus === 'paid' ? { paymentStatus: 'refunded' } : {}),
            refundStatus: 'processed',
            refundAmount: refunded,
            refundProcessedAt: new Date(),
        },
    });
}
