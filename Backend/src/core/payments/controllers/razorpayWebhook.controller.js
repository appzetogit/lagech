import crypto from 'crypto';
import { prisma } from '../../../config/prisma.js';
import * as foodTransactionService from '../../../modules/food/orders/services/foodTransaction.service.js';
import { config } from '../../../config/env.js';
import { logger } from '../../../utils/logger.js';

/**
 * Razorpay webhook handler.
 *
 * Razorpay retries a webhook until it gets a 2xx, so every branch here has to be
 * idempotent. Mongo got that from findOneAndUpdate with the "not already paid"
 * clause in the filter — one atomic statement that both claims the transition
 * and reports whether this call was the one that made it.
 *
 * Prisma has no returning-update, so it is updateMany with the same condition
 * (which compiles to one conditional UPDATE) followed by a read. `count` is what
 * decides whether to run the follow-up work, so a duplicate delivery updates
 * nothing and posts nothing to the ledger.
 */
export const handleRazorpayWebhook = async (req, res) => {
    const signature = req.headers['x-razorpay-signature'];
    const secret = config.razorpayWebhookSecret;

    // 1. Verify the signature against the raw body buffer.
    if (!signature || !secret || !req.rawBody) {
        logger.warn('Razorpay Webhook: Missing signature or rawBody buffer.');
        return res.status(400).send('Invalid signature');
    }

    const expected = crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex');

    // timingSafeEqual, not !==: a plain string compare returns as soon as it
    // finds a differing byte, which leaks how much of a forged signature was
    // right. Length is checked first because timingSafeEqual throws on a mismatch.
    const expectedBuf = Buffer.from(expected, 'utf8');
    const actualBuf = Buffer.from(String(signature), 'utf8');
    const signatureValid =
        expectedBuf.length === actualBuf.length && crypto.timingSafeEqual(expectedBuf, actualBuf);

    if (!signatureValid) {
        logger.warn('Razorpay Webhook: Signature verification failed.');
        return res.status(400).send('Invalid signature');
    }

    const { event, payload } = req.body;
    logger.info(`Razorpay Webhook Received: ${event}`);

    try {
        // --- Payment captured ---
        if (event === 'payment.captured') {
            const paymentObj = payload.payment.entity;
            const rzOrderId = paymentObj.order_id;
            const rzPaymentId = paymentObj.id;

            const existingOrder = await prisma.foodOrder.findFirst({
                where: { razorpayOrderId: rzOrderId },
                select: { id: true, orderId: true, total: true, paymentStatus: true },
            });

            // Cross-check the captured amount before marking anything paid: a
            // gateway callback is not proof of the right amount.
            if (existingOrder) {
                const expectedPaise = Math.round(Number(existingOrder.total || 0) * 100);
                const paidPaise = Number(paymentObj.amount);

                if (!Number.isFinite(paidPaise) || paidPaise !== expectedPaise) {
                    logger.error(
                        `Webhook [payment.captured]: AMOUNT MISMATCH for RZ-Order ${rzOrderId} — paid ${paidPaise} paise, expected ${expectedPaise} paise. Order NOT marked paid.`,
                    );
                    await prisma.foodOrder.updateMany({
                        where: { id: existingOrder.id, paymentStatus: { not: 'paid' } },
                        data: { paymentStatus: 'failed', razorpayPaymentId: rzPaymentId },
                    });
                    return res.status(200).json({ status: 'ok' });
                }
            }

            // Claim the transition. count is 1 only for the delivery that won.
            const { count } = await prisma.foodOrder.updateMany({
                where: { razorpayOrderId: rzOrderId, paymentStatus: { not: 'paid' } },
                data: { paymentStatus: 'paid', razorpayPaymentId: rzPaymentId },
            });

            if (count) {
                const order = await prisma.foodOrder.findFirst({
                    where: { razorpayOrderId: rzOrderId },
                    select: { id: true, orderId: true },
                });

                // The ledger write must not fail the webhook — Razorpay would
                // retry, and the retry would find the order already paid and
                // never reach this line again.
                try {
                    await foodTransactionService.updateTransactionStatus(order.id, 'captured', {
                        status: 'captured',
                        razorpayPaymentId: rzPaymentId,
                        note: 'Payment status synced via Webhook (payment.captured)',
                    });
                } catch (ledgerErr) {
                    logger.error(`Webhook Ledger Error (Order ${order.orderId}): ${ledgerErr.message}`);
                }
                logger.info(`Webhook [payment.captured]: Synced Order ${order.orderId} (Status=paid)`);
            } else {
                logger.warn(
                    `Webhook [payment.captured]: Order not found or already paid for RZ-Order: ${rzOrderId}`,
                );
            }
        }

        // --- Refund processed ---
        if (event === 'refund.processed') {
            const refundObj = payload.refund.entity;
            const rzPaymentId = refundObj.payment_id;
            const rzRefundId = refundObj.id;
            const refundAmount = refundObj.amount / 100; // paise → rupees

            const { count } = await prisma.foodOrder.updateMany({
                where: { razorpayPaymentId: rzPaymentId, refundStatus: { not: 'processed' } },
                data: {
                    paymentStatus: 'refunded',
                    refundStatus: 'processed',
                    refundAmount,
                    refundId: rzRefundId,
                    refundProcessedAt: new Date(),
                },
            });

            if (count) {
                const order = await prisma.foodOrder.findFirst({
                    where: { razorpayPaymentId: rzPaymentId },
                    select: { orderId: true },
                });
                logger.info(`Webhook [refund.processed]: Synced Order ${order?.orderId} (Refunded)`);
            } else {
                logger.warn(
                    `Webhook [refund.processed]: Order not found or already refunded for RZ-Payment: ${rzPaymentId}`,
                );
            }
        }

        res.status(200).json({ status: 'ok' });
    } catch (err) {
        logger.error(`Razorpay Webhook Logic Error: ${err.message}`);
        res.status(500).json({ message: 'Internal Server Error' });
    }
};
