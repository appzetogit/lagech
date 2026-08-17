/**
 * Drop a restaurant's cached menu after its dishes change.
 *
 * Imported lazily because the cache module opens a Redis connection, and a
 * failure here must never fail the write that already succeeded — a stale menu
 * for one TTL beats a rejected approval.
 */
export const dropMenuCache = async (restaurantId) => {
    if (!restaurantId) return;
    try {
        const { invalidateCache } = await import('../../../middleware/cache.js');
        await invalidateCache(`restaurant_menu:${restaurantId}`);
    } catch (cacheErr) {
        console.error('Failed to invalidate menu cache:', cacheErr);
    }
};
