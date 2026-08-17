/**
 * Marks every delivery partner offline.
 *
 * Used after a deploy or an outage: a rider whose app was killed stays flagged
 * online forever, and the dispatcher keeps offering them orders they will never
 * see. Dry by default.
 *
 * Usage:
 *   node scripts/mark-delivery-partners-offline.js            (report only)
 *   node scripts/mark-delivery-partners-offline.js --apply    (mark them offline)
 */
import 'dotenv/config';
import { prisma, connectDB, disconnectDB } from '../src/config/prisma.js';

const shouldApply = process.argv.slice(2).includes('--apply');

const main = async () => {
    await connectDB();
    try {
        const where = { availabilityStatus: 'online' };
        const onlineCount = await prisma.foodDeliveryPartner.count({ where });

        console.log(`[DeliveryOffline] Online delivery partners found: ${onlineCount}`);

        if (!shouldApply) {
            console.log('[DeliveryOffline] Dry run only. Re-run with --apply to mark them offline.');
            return;
        }
        if (onlineCount === 0) {
            console.log('[DeliveryOffline] Nothing to update.');
            return;
        }

        const { count } = await prisma.foodDeliveryPartner.updateMany({
            where,
            data: { availabilityStatus: 'offline' },
        });
        console.log(`[DeliveryOffline] Marked ${count} delivery partners offline.`);
    } finally {
        await disconnectDB();
    }
};

main().catch((err) => {
    console.error('[DeliveryOffline] Script failed:', err.message);
    process.exitCode = 1;
});
