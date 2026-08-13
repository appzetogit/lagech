import { ValidationError } from '../../../../core/auth/errors.js';
import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { recordTransaction, ensureWallet } from '../../../../core/payments/transaction.service.js';
import { getUserWalletForFrontend } from '../../../../core/payments/wallet.service.js';
import {
    createRazorpayOrder,
    getRazorpayKeyId,
    isRazorpayConfigured,
    verifyPaymentSignature
} from '../../orders/helpers/razorpay.helper.js';

/**
 * User wallet operations.
 *
 * Every balance change here used to be a read-modify-write against an embedded
 * `transactions` array on FoodUserWallet — outside any transaction, and bypassing
 * the Transaction ledger that the rest of the money code treats as authoritative.
 * The user wallet therefore had two writers with different guarantees, and
 * concurrent writes could lose an update or leave the balance disagreeing with the
 * ledger. Everything now goes through recordTransaction().
 */

const requireUserId = (userId) => {
    const id = String(userId || '');
    if (!isId(id)) throw new ValidationError('User not found');
    return id;
};

export const getUserWallet = async (userId) => getUserWalletForFrontend(requireUserId(userId));

export const creditReferralReward = async (userId, amountInr, metadata = {}) => {
    const id = requireUserId(userId);
    const amount = Number(amountInr);
    if (!Number.isFinite(amount) || amount <= 0) return { wallet: await getUserWallet(id) };

    await recordTransaction({
        entityType: 'user',
        entityId: id,
        type: 'credit',
        amount,
        description: 'Referral reward',
        category: 'referral_reward',
        metadata: { source: 'referral_reward', ...(metadata || {}) }
    });

    // referralEarnings is a lifetime counter, not part of the ledger.
    await prisma.wallet.update({
        where: { entityType_entityId: { entityType: 'user', entityId: id } },
        data: { referralEarnings: { increment: amount } }
    });

    return { wallet: await getUserWallet(id) };
};

export const createWalletTopupOrder = async (userId, amountInr) => {
    const amount = Number(amountInr);
    if (!Number.isFinite(amount) || amount <= 0) {
        throw new ValidationError('Amount must be greater than 0');
    }
    if (amount > 50000) {
        throw new ValidationError('Maximum amount is 50,000');
    }

    const amountPaise = Math.round(amount * 100);

    if (!isRazorpayConfigured()) {
        // Dev fallback: return a compatible shape without writing to the DB.
        const orderId = `order_dev_${Date.now()}`;
        return {
            razorpay: {
                key: getRazorpayKeyId() || 'rzp_test_dummy',
                orderId,
                amount: amountPaise,
                currency: 'INR'
            }
        };
    }

    const receipt = `wallet_topup_${String(userId).slice(-8)}_${Date.now()}`;
    const order = await createRazorpayOrder(amountPaise, 'INR', receipt);

    return {
        razorpay: {
            key: getRazorpayKeyId(),
            orderId: String(order.id),
            amount: Number(order.amount) || amountPaise,
            currency: order.currency || 'INR'
        }
    };
};

export const verifyWalletTopupPayment = async (userId, payload) => {
    const id = requireUserId(userId);
    const orderId = String(payload?.razorpayOrderId || '').trim();
    const paymentId = String(payload?.razorpayPaymentId || '').trim();
    const signature = String(payload?.razorpaySignature || '').trim();
    const amount = Number(payload?.amount);

    if (!orderId) throw new ValidationError('razorpayOrderId is required');
    if (!paymentId) throw new ValidationError('razorpayPaymentId is required');
    if (!signature) throw new ValidationError('razorpaySignature is required');
    if (!Number.isFinite(amount) || amount <= 0) throw new ValidationError('amount is required');

    await ensureWallet('user', id);

    // If razorpay is not configured (dev), accept and credit.
    const ok = isRazorpayConfigured()
        ? verifyPaymentSignature(orderId, paymentId, signature)
        : true;
    if (!ok) throw new ValidationError('Payment verification failed');

    // Credit ONLY after verification. The gateway order id is the idempotency key,
    // which replaces the previous scan of the embedded array for a matching
    // razorpayOrderId — that scan raced with itself, so a double-submitted
    // callback could credit the top-up twice.
    await recordTransaction({
        entityType: 'user',
        entityId: id,
        type: 'credit',
        amount,
        description: isRazorpayConfigured() ? 'Wallet top-up' : 'Wallet top-up (dev)',
        category: 'wallet_topup',
        idempotencyKey: `wallet_topup:${orderId}`,
        metadata: {
            source: 'wallet_topup',
            mode: isRazorpayConfigured() ? 'razorpay' : 'dev',
            razorpayOrderId: orderId,
            razorpayPaymentId: paymentId
        }
    });

    return { wallet: await getUserWallet(id) };
};

export const deductWalletBalance = async (userId, amountInr, description = 'Order payment', metadata = {}) => {
    const id = requireUserId(userId);
    const amount = Number(amountInr);
    if (!Number.isFinite(amount) || amount <= 0) {
        throw new ValidationError('Invalid deduction amount');
    }

    try {
        await recordTransaction({
            entityType: 'user',
            entityId: id,
            type: 'debit',
            amount,
            description,
            category: 'order_payment',
            orderId: metadata?.orderId ? String(metadata.orderId) : null,
            metadata: { source: 'order_payment', ...(metadata || {}) }
        });
    } catch (err) {
        // recordTransaction rejects an overdraw at the database; surface it as the
        // validation error callers already handle.
        if (/Insufficient balance/i.test(err.message)) {
            throw new ValidationError('Insufficient wallet balance');
        }
        throw err;
    }

    return { wallet: await getUserWallet(id) };
};

export const refundWalletBalance = async (userId, amountInr, description = 'Order refund', metadata = {}) => {
    const id = requireUserId(userId);
    const amount = Number(amountInr);
    if (!Number.isFinite(amount) || amount <= 0) return { wallet: await getUserWallet(id) };

    await recordTransaction({
        entityType: 'user',
        entityId: id,
        type: 'credit',
        amount,
        description,
        category: 'order_refund',
        orderId: metadata?.orderId ? String(metadata.orderId) : null,
        metadata: { source: 'order_refund', ...(metadata || {}) }
    });

    return { wallet: await getUserWallet(id) };
};
