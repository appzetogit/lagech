import { PrismaClient } from '@prisma/client';
import { logger } from '../utils/logger.js';

/**
 * Adds `_id` alongside `id` on every result.
 *
 * The codebase carries 1,149 `_id` references and the frontend another 845, with
 * no DTO layer to rename at (only 3 files use src/dtos). Re-adding the field here
 * means none of those ~2,000 call sites change and the frontend needs no edits at
 * all — the alternative was a two-codebase rename with no user-visible benefit.
 *
 * Only plain objects are walked: Date, Decimal and Buffer all have their own
 * constructor, so they pass through untouched rather than being shredded into
 * their enumerable properties.
 */
const withMongoId = (value) => {
    if (Array.isArray(value)) return value.map(withMongoId);
    if (value?.constructor !== Object) return value;

    const mapped = Object.fromEntries(
        Object.entries(value).map(([key, inner]) => [key, withMongoId(inner)])
    );
    if (typeof value.id === 'string') mapped._id = value.id;
    return mapped;
};

/**
 * Explicit connection pool sizing.
 *
 * Prisma's default is `num_cpus * 2 + 1`, which is a guess about the machine
 * rather than about the workload — and it is silently wrong in both directions
 * here. recordTransaction holds a connection for the whole interactive
 * transaction, so a burst of concurrent wallet writes exhausts a small pool and
 * the surplus queues until pool_timeout fires; the failure surfaces as an opaque
 * timeout, not as "you are out of connections".
 *
 * Set it deliberately, and leave it overridable per environment: behind PgBouncer
 * this wants to be small, on a dedicated instance larger.
 */
function poolUrl(raw) {
    // Fail by name. Prisma's own message for a missing url talks about the
    // constructor signature, which reads as a bug in this file rather than as
    // "you forgot the env var" — and it fires on import, so it lands in the
    // middle of an unrelated stack trace.
    if (!raw) throw new Error('DATABASE_URL is not set. See Backend/prisma/README.md for local setup.');
    try {
        const url = new URL(raw);
        if (!url.searchParams.has('connection_limit')) {
            // One pool per process. `node --test` runs each file in its own
            // child, so the suite's total is this times the file concurrency —
            // which package.json caps at 3, keeping it under Postgres's
            // max_connections of 100. Shrinking the pool instead was the wrong
            // lever: it starved recordTransaction, which legitimately opens
            // twenty concurrent interactive transactions.
            url.searchParams.set('connection_limit', process.env.DATABASE_POOL_SIZE || '25');
        }
        if (!url.searchParams.has('pool_timeout')) {
            url.searchParams.set('pool_timeout', process.env.DATABASE_POOL_TIMEOUT || '20');
        }
        return url.toString();
    } catch {
        // A malformed URL is the datasource's problem to report, not ours.
        return raw;
    }
}

export const prisma = new PrismaClient({
    datasources: { db: { url: poolUrl(process.env.DATABASE_URL) } },
    /**
     * Prisma's default interactive-transaction timeout is 5s, measured from the
     * moment the transaction opens — which includes the time it spends waiting
     * for a free connection, not just the work inside it. Twenty concurrent
     * wallet writes against a 25-connection pool can therefore blow the budget
     * on queueing alone and fail with a message about doing "less work in the
     * transaction", which points at the wrong thing entirely.
     */
    transactionOptions: {
        timeout: Number(process.env.DATABASE_TRANSACTION_TIMEOUT_MS) || 20000,
        maxWait: Number(process.env.DATABASE_TRANSACTION_MAX_WAIT_MS) || 20000,
    },
}).$extends({
    query: {
        $allModels: {
            async $allOperations({ query, args }) {
                return withMongoId(await query(args));
            }
        }
    }
});
// ponytail: walks every result object on every query. Fine at this scale; if it
// ever shows up in profiling, narrow it to per-model result extensions on the
// hot models (FoodOrder, FoodRestaurant, FoodItem) instead of $allModels.

export const connectDB = async () => {
    try {
        await prisma.$connect();
        logger.info('Postgres connected');
    } catch (error) {
        logger.error(`Postgres connection error: ${error.message}`);
        process.exit(1);
    }
};

/**
 * Close the pool (e.g. graceful shutdown).
 * @returns {Promise<void>}
 */
export const disconnectDB = async () => {
    await prisma.$disconnect();
    logger.info('Postgres connection closed');
};
