/**
 * Migrates the food_otps TTL index from `expiresAt` to `purgeAt`.
 *
 * Why this is required: Mongo will NOT replace a TTL index just because the
 * Mongoose schema changed. Until the old `expiresAt_1` index is dropped, the
 * reaper keeps deleting OTP documents at OTP expiry (300s) — taking the
 * per-phone `requestCount` with it, well before the 600s rate window closes.
 * The per-phone OTP quota then silently never enforces.
 *
 * Also backfills `purgeAt`/`windowStartedAt` on existing documents so they are
 * not immediately reaped (a missing TTL field means "never expire", which would
 * instead leak documents forever).
 *
 * Usage:  node scripts/migrate-otp-ttl.js
 */
import mongoose from 'mongoose';
import { config } from '../src/config/env.js';

const COLLECTION = 'food_otps';

const run = async () => {
    await mongoose.connect(config.mongodbUri);
    const collection = mongoose.connection.db.collection(COLLECTION);

    const indexes = await collection.indexes();
    const hasOldIndex = indexes.some((index) => index.name === 'expiresAt_1');
    const hasNewIndex = indexes.some((index) => index.name === 'purgeAt_1');

    // Backfill BEFORE creating the new TTL index, so no document is reaped for
    // having a null purgeAt mid-migration.
    const windowMs = (Number(config.otpRateWindow) || 600) * 1000;
    const backfilled = await collection.updateMany(
        { purgeAt: { $exists: false } },
        [
            {
                $set: {
                    windowStartedAt: { $ifNull: ['$windowStartedAt', '$lastRequestAt', '$createdAt'] },
                    purgeAt: {
                        $max: [
                            { $ifNull: ['$expiresAt', new Date()] },
                            { $add: [{ $ifNull: ['$lastRequestAt', new Date()] }, windowMs] },
                        ],
                    },
                },
            },
        ],
    );
    console.log(`Backfilled purgeAt/windowStartedAt on ${backfilled.modifiedCount} document(s).`);

    if (hasOldIndex) {
        await collection.dropIndex('expiresAt_1');
        console.log('Dropped stale TTL index expiresAt_1.');
    } else {
        console.log('No expiresAt_1 index present — nothing to drop.');
    }

    if (!hasNewIndex) {
        await collection.createIndex({ purgeAt: 1 }, { expireAfterSeconds: 0 });
        console.log('Created TTL index purgeAt_1.');
    } else {
        console.log('TTL index purgeAt_1 already present.');
    }

    await mongoose.disconnect();
    console.log('OTP TTL migration complete.');
};

run().catch(async (error) => {
    console.error('OTP TTL migration failed:', error);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
});
