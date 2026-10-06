import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { NotFoundError, ValidationError } from '../../../../core/auth/errors.js';
import { approveRestaurant } from './adminRestaurantLifecycle.service.js';
import { invalidateCache } from '../../../../middleware/cache.js';

const dropCaches = (patterns) => Promise.all(patterns.map((p) => invalidateCache(p)));

/**
 * Restaurant list actions the old panel had: the Featured toggle and
 * "Verify all".
 */

const asBoolean = (raw) => {
    if (typeof raw === 'boolean') return raw;
    const text = String(raw ?? '').trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(text)) return true;
    if (['false', '0', 'no', 'off'].includes(text)) return false;
    throw new ValidationError('isFeatured must be true or false');
};

/** Mark a restaurant featured (or not) for the customer app. */
export async function setRestaurantFeatured(id, raw) {
    if (!isId(id)) throw new ValidationError('Invalid restaurant id');
    const isFeatured = asBoolean(raw);
    const { count } = await prisma.foodRestaurant.updateMany({ where: { id: String(id) }, data: { isFeatured } });
    if (!count) throw new NotFoundError('Restaurant not found');
    await dropCaches(['restaurants:*', 'restaurant_detail:*']).catch(() => {});
    return { id: String(id), isFeatured };
}

/**
 * "Verify all": approve every restaurant still waiting for its first approval
 * (status pending). Rejected ones and location-move requests stay in the
 * queue for a person to look at. Each goes through the single approval, so the
 * owner is notified exactly as when approved one by one.
 */
export async function approveAllPendingRestaurants() {
    const pending = await prisma.foodRestaurant.findMany({
        where: { status: 'pending' },
        select: { id: true },
        orderBy: { createdAt: 'asc' },
        take: 1000,
    });
    let approved = 0;
    const failed = [];
    for (const { id } of pending) {
        try {
            if (await approveRestaurant(id)) approved += 1;
        } catch (error) {
            failed.push({ id, message: error?.message || 'Could not be approved' });
        }
    }
    if (approved) await dropCaches(['restaurants:*', 'restaurant_detail:*']).catch(() => {});
    return { approved, failed };
}
