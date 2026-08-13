import { prisma } from '../../../../config/prisma.js';

/**
 * Re-enable foods whose scheduled out-of-stock window has expired.
 * Manual off (no stockResumeAt) is left unchanged until the restaurant turns it
 * back on.
 *
 * @param {object} where a Prisma where fragment, e.g. { restaurantId } or
 *                       { restaurantId: { in: ids } }
 */
export async function restoreExpiredFoodAvailability(where = {}) {
    const { count } = await prisma.foodItem.updateMany({
        where: {
            ...where,
            isAvailable: false,
            stockResumeAt: { not: null, lte: new Date() },
        },
        data: { isAvailable: true, stockResumeAt: null, stockOffMode: null },
    });

    return count || 0;
}
