import crypto from 'crypto';

let Razorpay;
try {
    const mod = await import('razorpay');
    Razorpay = mod.default;
} catch {
    Razorpay = null;
}

import { config } from '../../../../config/env.js';
import { logger } from '../../../../utils/logger.js';
import { getThirdPartySettingsSync } from '../../../../core/thirdParty/thirdParty.runtime.js';

/**
 * The keys in use: the pair an admin saved under 3rd Party > Payment Setup,
 * otherwise the server's RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET. The catalog
 * only lets the id and secret be saved together, so the pair never mixes.
 */
const serverKeyId = () => config.razorpayKeyId || process.env.RAZORPAY_KEY_ID || '';
const serverKeySecret = () => config.razorpayKeySecret || process.env.RAZORPAY_KEY_SECRET || '';

export function getRazorpaySettings() {
    const saved = getThirdPartySettingsSync('payment');
    return {
        keyId: saved.keyId || serverKeyId(),
        keySecret: saved.keySecret || serverKeySecret(),
        // Off stops new payments only; verification and refunds keep working.
        enabled: saved.enabled !== false,
    };
}

export function isRazorpayConfigured() {
    const { keyId, keySecret } = getRazorpaySettings();
    return Boolean(keyId && keySecret && Razorpay);
}

export function getRazorpayKeyId() {
    return getRazorpaySettings().keyId;
}

export function getRazorpayInstance() {
    if (!isRazorpayConfigured()) return null;
    const { keyId, keySecret } = getRazorpaySettings();
    return new Razorpay({ key_id: keyId, key_secret: keySecret });
}

const assertNewPaymentsAllowed = () => {
    if (!getRazorpaySettings().enabled) return Promise.reject(new Error('Online payments are switched off'));
    return null;
};

export function createRazorpayOrder(amountPaise, currency = 'INR', receipt = '') {
    const blocked = assertNewPaymentsAllowed();
    if (blocked) return blocked;
    const instance = getRazorpayInstance();
    if (!instance) return Promise.reject(new Error('Razorpay not configured'));
    return instance.orders.create({
        amount: Math.round(amountPaise),
        currency,
        receipt: receipt || undefined
    });
}

export function createPaymentLink({ amountPaise, currency = 'INR', description, orderId, customerName, customerEmail, customerPhone }) {
    const blocked = assertNewPaymentsAllowed();
    if (blocked) return blocked;
    const instance = getRazorpayInstance();
    if (!instance) return Promise.reject(new Error('Razorpay not configured'));
    return instance.paymentLink.create({
        amount: Math.round(amountPaise),
        currency,
        description: description || `Order ${orderId}`,
        customer: {
            name: customerName || 'Customer',
            email: customerEmail || 'customer@example.com',
            contact: customerPhone ? String(customerPhone).replace(/\D/g, '').slice(-10) : '9999999999'
        }
    });
}

/**
 * Checks the signature against the secret in use and, when an admin has saved
 * a different one, against the server's secret too: a payment started just
 * before the keys were changed was signed with the old secret and must still
 * verify. Both secrets are ours, so accepting either proves the same thing.
 */
export function verifyPaymentSignature(orderId, paymentId, signature) {
    const secrets = [...new Set([getRazorpaySettings().keySecret, serverKeySecret()].filter(Boolean))];
    if (!secrets.length || typeof signature !== 'string' || !signature) return false;
    const body = `${orderId}|${paymentId}`;
    return secrets.some((secret) => {
        const expected = Buffer.from(crypto.createHmac('sha256', secret).update(body).digest('hex'), 'utf8');
        const actual = Buffer.from(signature, 'utf8');
        return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
    });
}

/**
 * Fetch Razorpay payment (server-side) for additional validation (amount/status/order match).
 * @param {string} paymentId
 */
export async function fetchRazorpayPayment(paymentId) {
    const instance = getRazorpayInstance();
    if (!instance) throw new Error('Razorpay not configured');
    if (!paymentId) throw new Error('paymentId is required');
    return instance.payments.fetch(String(paymentId));
}

/**
 * Confirm a client-reported payment with Razorpay itself, and report what was
 * actually captured, in paise.
 *
 * The signature covers `orderId|paymentId` and nothing else — in particular not
 * the amount. So a caller that verifies the signature and then trusts the
 * amount sent alongside it will credit whatever the client says: pay ₹1, claim
 * ₹50,000, and the signature is genuine either way. The amount has to come from
 * Razorpay, which is what this is for.
 *
 * Throws on any mismatch rather than returning a flag, because every caller
 * treats failure the same way and a returned false is easy to forget to check.
 *
 * @param {object}  args
 * @param {number} [args.expectedPaise] when the caller knows what it charged,
 *   the payment must match it exactly. Omit to accept whatever was captured and
 *   use the return value.
 * @returns {Promise<number>} amount captured, in paise
 */
export async function confirmRazorpayPayment({ orderId, paymentId, signature, expectedPaise = null }) {
    if (!verifyPaymentSignature(orderId, paymentId, signature)) {
        throw new Error('Payment signature verification failed');
    }

    const payment = await fetchRazorpayPayment(paymentId);

    if (String(payment?.order_id || '') !== String(orderId)) {
        throw new Error('Payment does not belong to this order');
    }

    // 'authorized' means the funds are held but not captured. Accepted here for
    // the same reason order verification accepts it: capture follows, and
    // rejecting it strands a customer who has genuinely paid.
    const status = String(payment?.status || '').toLowerCase();
    if (!['captured', 'authorized'].includes(status)) {
        throw new Error(`Payment is ${status || 'in an unknown state'}, not captured`);
    }

    const paidPaise = Number(payment?.amount);
    if (!Number.isFinite(paidPaise) || paidPaise <= 0) {
        throw new Error('Payment amount could not be read');
    }
    if (expectedPaise != null && paidPaise !== Math.round(Number(expectedPaise))) {
        throw new Error(
            `Payment of ${paidPaise} paise does not match the expected ${Math.round(Number(expectedPaise))}`,
        );
    }

    return paidPaise;
}

/**
 * Fetch Razorpay payment-link to check status (used for Razorpay QR auto verification).
 * @param {string} paymentLinkId
 */
export async function fetchRazorpayPaymentLink(paymentLinkId) {
    const instance = getRazorpayInstance();
    if (!instance) throw new Error('Razorpay not configured');
    if (!paymentLinkId) throw new Error('paymentLinkId is required');
    return instance.paymentLink.fetch(String(paymentLinkId));
}

/**
 * ✅ NEW: Initiate a refund for a successful payment.
 * NON-BREAKING Extension for automated cancellation refunds.
 * @param {string} paymentId - Original Razorpay payment_id (captured)
 * @param {number} amount - Amount to refund (in major unit, e.g., INR 123.45)
 */
export async function initiateRazorpayRefund(paymentId, amount) {
    if (!isRazorpayConfigured()) {
        throw new Error('Razorpay is not configured on this server');
    }
    const instance = getRazorpayInstance();
    try {
        const refund = await instance.payments.refund(paymentId, {
            amount: Math.round(Number(amount) * 100), // convert to paise
            notes: {
                reason: 'Order cancelled by system flow',
                at: new Date().toISOString()
            }
        });
        return {
            success: true,
            refundId: refund.id,
            status: refund.status || 'processed',
            raw: refund
        };
    } catch (err) {
        // Log locally but pass the error to the service to handle status update
        logger.error(`Razorpay Refund API Failure [PaymentId: ${paymentId}]:`, err?.message || err);
        return {
            success: false,
            error: err?.message || 'Razorpay refund API error',
            status: 'failed'
        };
    }
}
