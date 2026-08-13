import { prisma, connectDB } from '../../config/prisma.js';
import { logger } from '../../utils/logger.js';
import { getRedisClient } from '../../config/redis.js';

let isDBConnected = false;

const ensureDB = async () => {
    if (isDBConnected) return;
    await connectDB();
    isDBConnected = true;
};

/**
 * Flushes the latest rider location from hot Redis storage down to Postgres.
 */
export const processTrackingJob = async (job) => {
    await ensureDB();
    const { name, data } = job;

    if (name === 'sync-hot-locations') {
        return handleHotSync(data);
    }
    return null;
};

const handleHotSync = async ({ userId, orderId }) => {
    const redis = getRedisClient();
    if (!redis) return;

    try {
        const [riderRaw, orderRaw] = await Promise.all([
            redis.hGet('rider:locations:hot', String(userId)),
            redis.hGet('order:locations:hot', String(orderId)),
        ]);

        const riderData = riderRaw ? JSON.parse(riderRaw) : null;
        const orderData = orderRaw ? JSON.parse(orderRaw) : null;

        const updates = [];

        // Plain lat/lng columns; the PostGIS point beside them is maintained by
        // the sync_geography trigger, so there is still one thing to write.
        if (riderData && userId) {
            updates.push(
                prisma.foodDeliveryPartner.updateMany({
                    where: { id: String(userId) },
                    data: {
                        lastLat: riderData.lat,
                        lastLng: riderData.lng,
                        // Stamped so a stale fix is distinguishable from a rider
                        // parked at the same spot. The column existed and nothing
                        // was writing it.
                        lastLocationAt: new Date(),
                    },
                })
            );
        }

        if (orderData && orderId) {
            updates.push(
                prisma.foodOrder.updateMany({
                    where: { orderId: String(orderId) },
                    data: { riderLat: orderData.lat, riderLng: orderData.lng },
                })
            );
        }

        if (updates.length) {
            // updateMany rather than update: a job for a rider or order that has
            // since been deleted is a no-op instead of a thrown P2025 that would
            // retry the job forever.
            await Promise.all(updates);
            logger.info(`Synced hot location to Postgres for Order ${orderId} / Rider ${userId}`);
        }
    } catch (err) {
        logger.error(`Failed to handle hot sync for ${orderId}: ${err.message}`);
        throw err;
    }
};
