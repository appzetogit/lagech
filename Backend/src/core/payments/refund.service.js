import { prisma } from '../../config/prisma.js';
import { creditWallet } from './wallet.service.js';
import { getRazorpayInstance, isRazorpayConfigured } from '../../modules/food/orders/helpers/razorpay.helper.js';
import { logger } from '../../utils/logger.js';

/**
 * Initiate a refund for a payment.
 * - wallet refunds credit the customer immediately
 * - gateway refunds create a pending record for processGatewayRefund()
 */
/**
 * Pay a pending refund into the customer's wallet and close it out.
 *
 * Shared by both entry points. The gateway fallback used to call
 * initiateRefund() instead, which opens a *new* refund row — so one refund
 * request became two rows, and the one the admin was looking at stayed pending
 * for ever while the money went out against its replacement.
 *
 * The refund row id is the idempotency key. Mongo credited the ledger here AND
 * again through a legacy embedded-wallet writer, so every wallet refund paid
 * out twice; there is now exactly one credit path.
 */
async function settleToWallet(refund, payment) {
    try {
        await creditWallet({
            entityType: 'user',
            entityId: refund.userId,
            amount: Number(refund.amount),
            description: 'Refund for order',
            category: 'order_refund',
            orderId: refund.orderId,
            paymentId: payment.id,
            idempotencyKey: `order_refund:${refund.id}`,
            metadata: { refundId: refund.id, reason: refund.reason }
        });

        const [processed] = await prisma.$transaction([
            prisma.refund.update({
                where: { id: refund.id },
                // refundTo as well as status: a request that fell back to the
                // wallet should not still read as a gateway refund.
                data: { status: 'processed', refundTo: 'wallet', processedAt: new Date() }
            }),
            prisma.payment.update({ where: { id: payment.id }, data: { status: 'refunded' } })
        ]);

        logger.info(`Refund processed (wallet): ${refund.id} amount=${refund.amount}`);
        return processed;
    } catch (err) {
        await prisma.refund.update({
            where: { id: refund.id },
            data: { status: 'failed', metadata: { error: err.message } }
        });
        throw err;
    }
}

export async function initiateRefund({ paymentId, orderId, userId, amount, reason = '', refundTo }) {
    const payment = await prisma.payment.findUnique({ where: { id: String(paymentId) } });
    if (!payment) throw new Error('Payment not found');
    if (payment.status !== 'success') throw new Error('Can only refund successful payments');

    // Wallet is the default path for every method — safer and faster. Admin can
    // override to gateway.
    const to = refundTo || 'wallet';

    // Only an absent amount means "refund it all". This used to be
    // `Number(amount) || Number(payment.amount)`, so a caller that worked out a
    // refund of zero hit the falsy branch and paid the whole payment back.
    const requested = amount == null || amount === '' ? Number(payment.amount) : Number(amount);
    if (!Number.isFinite(requested) || requested <= 0) {
        throw new Error('Refund amount must be greater than zero');
    }
    // Nothing else bounds this, and the refund row is written before the ledger
    // ever sees the figure.
    if (requested > Number(payment.amount)) {
        throw new Error(`Refund of ${requested} exceeds the payment of ${payment.amount}`);
    }

    const refund = await prisma.refund.create({
        data: {
            paymentId: payment.id,
            orderId: orderId ? String(orderId) : payment.orderId,
            userId: userId ? String(userId) : payment.userId,
            amount: requested,
            currency: payment.currency || 'INR',
            reason,
            status: 'pending',
            refundTo: to
        }
    });

    if (to !== 'wallet') return refund;

    return settleToWallet(refund, payment);
}

/**
 * Process a gateway (Razorpay) refund for a pending refund record.
 */
export async function processGatewayRefund(refundId) {
    const refund = await prisma.refund.findUnique({ where: { id: String(refundId) } });
    if (!refund) throw new Error('Refund not found');
    if (refund.status === 'processed') return refund;

    const payment = await prisma.payment.findUnique({ where: { id: refund.paymentId } });
    if (!payment) throw new Error('Payment not found');

    const viaGateway =
        payment.gateway === 'razorpay' && payment.gatewayPaymentId && isRazorpayConfigured();

    // No gateway to refund through — settle this request against the wallet
    // rather than opening a second one for the same money.
    if (!viaGateway) return settleToWallet(refund, payment);

    try {
        const instance = getRazorpayInstance();
        const rzRefund = await instance.payments.refund(payment.gatewayPaymentId, {
            amount: Math.round(Number(refund.amount) * 100), // paise
            speed: 'normal'
        });

        const [processed] = await prisma.$transaction([
            prisma.refund.update({
                where: { id: refund.id },
                data: {
                    gatewayRefundId: rzRefund.id,
                    status: 'processed',
                    processedAt: new Date()
                }
            }),
            prisma.payment.update({ where: { id: payment.id }, data: { status: 'refunded' } })
        ]);

        logger.info(`Gateway refund processed: ${refundId} gatewayRefundId=${rzRefund.id}`);
        return processed;
    } catch (err) {
        await prisma.refund.update({
            where: { id: refund.id },
            data: { status: 'failed', metadata: { error: err.message } }
        });
        throw err;
    }
}

/**
 * Get refunds for an order.
 */
export async function getRefundsByOrder(orderId) {
    return prisma.refund.findMany({
        where: { orderId: String(orderId) },
        orderBy: { createdAt: 'desc' }
    });
}

/**
 * List refunds with filters.
 */
export async function listRefunds({ status, page = 1, limit = 20 } = {}) {
    const currentPage = Math.max(1, page);
    const where = status ? { status } : {};

    const [refunds, total] = await Promise.all([
        prisma.refund.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            skip: (currentPage - 1) * limit,
            take: limit
        }),
        prisma.refund.count({ where })
    ]);

    return { refunds, total, page: currentPage, limit, totalPages: Math.ceil(total / limit) };
}
