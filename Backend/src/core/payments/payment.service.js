import { prisma } from '../../config/prisma.js';
import { recordTransaction } from './transaction.service.js';
import { logger } from '../../utils/logger.js';

/**
 * Create a Payment record when an order is placed.
 * Does NOT move money — that happens on markPaymentSuccess().
 */
export async function createPayment({
    orderId, userId, amount, method, gateway = 'none',
    gatewayOrderId = '', module = 'food', metadata
}) {
    const status = method === 'cash' ? 'pending' : method === 'wallet' ? 'success' : 'created';

    const payment = await prisma.payment.create({
        data: {
            orderId: String(orderId),
            userId: String(userId),
            amount: Number(amount),
            currency: 'INR',
            method,
            gateway,
            gatewayOrderId,
            status,
            module,
            metadata
        }
    });

    logger.info(`Payment created: ${payment.id} method=${method} status=${status} amount=${amount}`);

    // Wallet payments settle immediately.
    if (method === 'wallet' && status === 'success') {
        try {
            await recordTransaction({
                entityType: 'user',
                entityId: String(userId),
                type: 'debit',
                amount: Number(amount),
                description: 'Order payment - wallet debit',
                category: 'order_payment',
                orderId: String(orderId),
                paymentId: payment.id,
                // One debit per payment, however many times this is retried.
                idempotencyKey: `order_payment:${payment.id}`,
                metadata: { method: 'wallet' }
            });
        } catch (err) {
            // Insufficient balance (or any other failure) leaves the payment failed.
            await prisma.payment.update({
                where: { id: payment.id },
                data: { status: 'failed', rawResponse: { error: err.message } }
            });
            throw err;
        }
    }

    return payment;
}

/**
 * Mark a payment successful after gateway verification.
 */
export async function markPaymentSuccess(paymentId, { gatewayPaymentId, rawResponse } = {}) {
    const payment = await prisma.payment.findUnique({ where: { id: String(paymentId) } });
    if (!payment) throw new Error('Payment not found');
    if (payment.status === 'success') return payment;

    const updated = await prisma.payment.update({
        where: { id: payment.id },
        data: {
            status: 'success',
            ...(gatewayPaymentId ? { gatewayPaymentId } : {}),
            ...(rawResponse ? { rawResponse } : {})
        }
    });

    logger.info(`Payment marked success: ${paymentId}`);
    return updated;
}

/**
 * Mark a payment failed.
 */
export async function markPaymentFailed(paymentId, rawResponse) {
    const payment = await prisma.payment.findUnique({ where: { id: String(paymentId) } });
    if (!payment) throw new Error('Payment not found');

    const updated = await prisma.payment.update({
        where: { id: payment.id },
        data: { status: 'failed', ...(rawResponse ? { rawResponse } : {}) }
    });

    logger.info(`Payment marked failed: ${paymentId}`);
    return updated;
}

/**
 * Get all payments for an order.
 */
export async function getPaymentsByOrder(orderId) {
    return prisma.payment.findMany({
        where: { orderId: String(orderId) },
        orderBy: { createdAt: 'desc' }
    });
}

/**
 * Get a payment by its gateway payment id.
 */
export async function getPaymentByGatewayId(gatewayPaymentId) {
    return prisma.payment.findFirst({ where: { gatewayPaymentId } });
}

/**
 * Find or create the payment for an order (idempotent).
 */
export async function findOrCreatePayment({
    orderId, userId, amount, method, gateway = 'none',
    gatewayOrderId = '', module = 'food'
}) {
    const existing = await prisma.payment.findFirst({
        where: { orderId: String(orderId), status: { not: 'failed' } }
    });
    if (existing) return existing;

    return createPayment({ orderId, userId, amount, method, gateway, gatewayOrderId, module });
}
