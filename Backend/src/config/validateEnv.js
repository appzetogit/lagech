import { config } from './env.js';
import { logger } from '../utils/logger.js';

/**
 * What the server needs before it will agree to serve traffic.
 *
 * Of roughly a hundred environment variables, most carry a sensible default —
 * pool sizes, rate limits, timeouts — and are left alone. Checked here are the
 * ones with no safe default, where the absence surfaces as a failed payment or
 * an OTP that never arrives rather than as a failed boot.
 *
 * Most are demanded only in production. A developer running the API against a
 * local database should not need a payment gateway to see a menu.
 */

/** Credentials with no default. Each note says what stops working without it. */
const PRODUCTION_SECRETS = [
    ['RAZORPAY_KEY_ID', (c) => c.razorpayKeyId, 'online payments cannot be created'],
    ['RAZORPAY_KEY_SECRET', (c) => c.razorpayKeySecret, 'online payments cannot be created'],
    ['RAZORPAY_WEBHOOK_SECRET', (c) => c.razorpayWebhookSecret,
        'every payment webhook is refused, so paid orders are never confirmed'],
    ['SMS_INDIA_HUB_API_KEY', (c) => c.smsApiKey, 'no OTP is delivered, so nobody can log in'],
    ['SMS_INDIA_HUB_SENDER_ID', (c) => c.smsSenderId, 'no OTP is delivered, so nobody can log in'],
    ['SMS_INDIA_HUB_DLT_TEMPLATE_ID', (c) => c.smsDltTemplateId,
        'the operator rejects the message, so no OTP is delivered'],
    ['FIREBASE_SERVICE_ACCOUNT or FIREBASE_SERVICE_ACCOUNT_PATH',
        (c) => c.firebaseServiceAccount || c.firebaseServiceAccountPath,
        'no push notification is sent — restaurants are not told about new orders'],
];

/**
 * Returns the reasons this configuration should not serve traffic, as
 * sentences. Empty means it is fit to run.
 *
 * Separate from validateConfig so a test can check a configuration without the
 * process exiting underneath it.
 */
export const findConfigProblems = (cfg = config) => {
    const problems = [];
    const isProduction = cfg.nodeEnv === 'production';

    if (!cfg.databaseUrl) problems.push('DATABASE_URL is not set.');
    if (!cfg.jwtAccessSecret) problems.push('JWT_ACCESS_SECRET (or JWT_SECRET) is not set.');
    if (!cfg.jwtRefreshSecret) problems.push('JWT_REFRESH_SECRET is not set.');

    if (cfg.redisEnabled && !cfg.redisUrl) {
        problems.push('REDIS_ENABLED is true but REDIS_URL is not set.');
    }
    if (cfg.bullmqEnabled && !cfg.redisEnabled) {
        problems.push('BULLMQ_ENABLED is true but REDIS_ENABLED is not.');
    }

    // USE_DEFAULT_OTP fixes every OTP at 1234 and returns it in the login
    // response, which hands any phone number to anyone who asks for it. It is a
    // convenience for local development and a full authentication bypass in
    // production, so production refuses to start rather than warning about it.
    if (isProduction && cfg.useDefaultOtp) {
        problems.push(
            'USE_DEFAULT_OTP is true in production. Every OTP would be 1234 and returned'
            + ' in the login response, letting anyone sign in as any phone number.',
        );
    }

    if (isProduction) {
        for (const [name, read, consequence] of PRODUCTION_SECRETS) {
            if (!read(cfg)) problems.push(`${name} is not set — ${consequence}.`);
        }
    }

    return problems;
};

/**
 * Validates configuration at startup, and refuses to serve traffic without it.
 *
 * Exiting is the point. A server that boots missing a payment secret looks
 * healthy to a load balancer and fails one customer at a time.
 */
export const validateConfig = () => {
    const problems = findConfigProblems();
    if (problems.length === 0) return;

    logger.error(`Refusing to start — ${problems.length} configuration problem(s):`);
    for (const problem of problems) logger.error(`  - ${problem}`);
    process.exit(1);
};
