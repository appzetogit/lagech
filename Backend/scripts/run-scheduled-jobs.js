import { validateConfig } from '../src/config/validateEnv.js';
import { connectDB, disconnectDB } from '../src/config/prisma.js';
import { connectRedis, closeRedis } from '../src/config/redis.js';
import { config } from '../src/config/env.js';
import { expireExpiredOffers } from '../src/modules/food/admin/services/admin.service.js';
import { syncExpiredFssaiNotifications } from '../src/modules/food/restaurant/services/fssaiExpiry.service.js';
import { runBillingCatchUp } from '../src/modules/food/restaurant/services/subscriptionBilling.service.js';
import { expireStalledOrders } from '../src/modules/food/orders/services/order-expiry.service.js';
import { logger } from '../src/utils/logger.js';

let expireOffersInterval = null;
let fssaiExpiryInterval = null;
let subscriptionBillingInterval = null;
let orderWatchdogInterval = null;

const shutdown = async (signal) => {
    logger.info(`${signal} received, stopping scheduled jobs`);
    if (expireOffersInterval) clearInterval(expireOffersInterval);
    if (fssaiExpiryInterval) clearInterval(fssaiExpiryInterval);
    if (subscriptionBillingInterval) clearInterval(subscriptionBillingInterval);
    if (orderWatchdogInterval) clearInterval(orderWatchdogInterval);

    try {
        await disconnectDB();
        await closeRedis();
        logger.info('Scheduled jobs stopped cleanly');
        process.exit(0);
    } catch (err) {
        logger.error(`Scheduled jobs shutdown error: ${err.message}`);
        process.exit(1);
    }
};

const start = async () => {
    try {
        validateConfig();
        await connectDB();
        if (config.redisEnabled) {
            await connectRedis();
        }

        // Both halves of the order watchdog. This used to be a single call here
        // and nowhere else, so it ran once when the scheduler booted and never
        // again -- an order that stalled an hour later stayed stalled.
        const runOrderWatchdog = async () => {
            try {
                const { recoverStuckOrders } = await import('../src/modules/food/orders/services/order.service.js');
                await recoverStuckOrders();
            } catch (err) {
                logger.error(`Scheduled jobs watchdog error: ${err.message}`);
            }
            try {
                // Anything the hunt above could not rescue is eventually closed
                // out rather than left open for days.
                const { expired, failed } = await expireStalledOrders();
                if (expired || failed) {
                    logger.warn(`Order expiry: ${expired} cancelled, ${failed} failed`);
                }
            } catch (err) {
                logger.error(`Order expiry error: ${err.message}`);
            }
        };

        const runExpire = async () => {
            try {
                await expireExpiredOffers();
            } catch (err) {
                logger.error(`Expire offers error: ${err.message}`);
            }
        };

        const runFssaiExpirySync = async () => {
            try {
                await syncExpiredFssaiNotifications();
            } catch (err) {
                logger.error(`FSSAI expiry sync error: ${err.message}`);
            }
        };

        const runSubscriptionBilling = async () => {
            try {
                // Idempotent: bills only closed, not-yet-invoiced calendar months.
                await runBillingCatchUp();
            } catch (err) {
                logger.error(`Monthly subscription billing error: ${err.message}`);
            }
        };

        await runExpire();
        await runFssaiExpirySync();
        await runSubscriptionBilling();
        await runOrderWatchdog();

        expireOffersInterval = setInterval(runExpire, 5 * 60 * 1000);
        fssaiExpiryInterval = setInterval(runFssaiExpirySync, 60 * 60 * 1000);
        subscriptionBillingInterval = setInterval(runSubscriptionBilling, 6 * 60 * 60 * 1000);
        orderWatchdogInterval = setInterval(runOrderWatchdog, 5 * 60 * 1000);

        logger.info('Scheduled jobs runner started');
    } catch (err) {
        logger.error(`Failed to start scheduled jobs runner: ${err.message}`);
        process.exit(1);
    }
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

await start();
