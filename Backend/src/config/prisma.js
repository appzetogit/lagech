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

export const prisma = new PrismaClient().$extends({
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
