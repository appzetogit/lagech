import { Prisma } from '@prisma/client';
import { prisma } from '../../../../config/prisma.js';
import { logger } from '../../../../utils/logger.js';
import { getBusinessSettings } from '../../shared/businessSettings.js';
import { istClock } from '../../restaurant/services/restaurantPayout.service.js';
import { generateRiderDisbursement } from './adminRiderExtras.service.js';

/**
 * The automated daily rider disbursement (Business Settings > Disbursement).
 *
 * The scheduler calls this every few minutes; once the Indian clock passes
 * the configured time it claims the day and runs the same
 * generateRiderDisbursement the admin's "Generate disbursement" button runs,
 * holding back the waiting days' earnings. The admin button keeps working.
 *
 * Once per day: the claim is a row in food_system_settings keyed by the date,
 * and the key is unique, so a second scheduler, a restart or an overlapping
 * tick loses the insert instead of paying twice. (A second batch would find
 * nothing owed anyway -- pending lines reserve the balance -- but the claim
 * keeps the batch list clean.) A run that fails releases the claim so the
 * next tick retries.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
export const RUN_KEY_PREFIX = 'rider_disbursement_run:';

/** Whether today's run is due at `now`. Pure. */
export function isRiderDisbursementDue(rider, now = new Date()) {
    if (!rider?.enabled) return false;
    const [hours, minutes] = String(rider.runTime || '01:01').split(':').map(Number);
    return istClock(now).minutes >= hours * 60 + minutes;
}

/** Orders placed from this moment on are held back. Pure. */
export function riderHoldBackSince(rider, now = new Date()) {
    return new Date(istClock(now).startOfDay.getTime() - Math.max(0, Number(rider?.waitingDays) || 0) * DAY_MS);
}

export async function runScheduledRiderDisbursement({ now = new Date() } = {}) {
    const { rider } = await getBusinessSettings('business_disbursement');
    if (!isRiderDisbursementDue(rider, now)) return { created: false, reason: 'not due' };

    const { runDate } = istClock(now);
    const key = `${RUN_KEY_PREFIX}${runDate}`;
    try {
        await prisma.foodSystemSetting.create({ data: { key, value: { startedAt: now.toISOString() } } });
    } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
            return { created: false, reason: `the rider disbursement for ${runDate} already ran` };
        }
        throw error;
    }

    try {
        const result = await generateRiderDisbursement(
            { minAmount: rider.minAmount },
            null,
            { holdBackSince: riderHoldBackSince(rider, now) },
        );
        await prisma.foodSystemSetting.update({
            where: { key },
            data: {
                value: {
                    startedAt: now.toISOString(),
                    finishedAt: new Date().toISOString(),
                    created: Boolean(result.created),
                    batchId: result.batch?.id || null,
                    reason: result.reason || null,
                },
            },
        });
        if (result.created) logger.info(`[RIDER PAYOUTS] scheduled run for ${runDate} done`);
        return result;
    } catch (error) {
        await prisma.foodSystemSetting.deleteMany({ where: { key } }).catch(() => {});
        throw error;
    }
}
