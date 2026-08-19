import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

/**
 * Confirming a payment with Razorpay.
 *
 * The signature Razorpay hands the client covers `orderId|paymentId` and
 * nothing else — not the amount. Three places in this codebase verified that
 * signature and then credited whatever amount arrived alongside it, so a
 * customer could top up ₹1, resend the genuine signature with a larger figure,
 * and be credited the larger figure. Rider cash deposits had the same hole and
 * were fixed; wallet top-up and the restaurant onboarding fee were not.
 *
 * These cover the checks that run before any network call. The rest —
 * order linkage, capture status, amount match — needs a live Razorpay account
 * and is exercised against the sandbox, not here.
 */
const SECRET = 'test-secret-for-signature-checks';

/**
 * The helper reads the key and secret once at import, so the environment has to
 * be set before it is loaded.
 *
 * Only the configured case is covered. config/env.js caches what it read on
 * first load, and the helper prefers that over the environment, so a second
 * load cannot be made to see absent credentials — the unconfigured branch is
 * not reachable from a test once this one has run.
 */
const loadHelper = async () => {
    process.env.RAZORPAY_KEY_ID = 'rzp_test_key';
    process.env.RAZORPAY_KEY_SECRET = SECRET;
    return import('./razorpay.helper.js');
};

const signatureFor = (orderId, paymentId, secret = SECRET) =>
    crypto.createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex');

test('a payment whose signature does not verify is refused before anything else', async () => {
    const { confirmRazorpayPayment } = await loadHelper();

    await assert.rejects(
        () => confirmRazorpayPayment({
            orderId: 'order_abc',
            paymentId: 'pay_abc',
            signature: 'not-the-real-signature',
        }),
        /signature verification failed/i,
        'a forged signature must not reach the fetch',
    );

    // A signature that is genuine for a *different* payment is just as forged
    // for this one — the payment id is inside the signed string.
    await assert.rejects(
        () => confirmRazorpayPayment({
            orderId: 'order_abc',
            paymentId: 'pay_abc',
            signature: signatureFor('order_abc', 'pay_SOMEONE_ELSE'),
        }),
        /signature verification failed/i,
    );

    // And one signed with a different secret.
    await assert.rejects(
        () => confirmRazorpayPayment({
            orderId: 'order_abc',
            paymentId: 'pay_abc',
            signature: signatureFor('order_abc', 'pay_abc', 'the-wrong-secret'),
        }),
        /signature verification failed/i,
    );
});
