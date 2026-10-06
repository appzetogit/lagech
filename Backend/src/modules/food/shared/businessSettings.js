import { prisma } from '../../../config/prisma.js';
import { logger } from '../../../utils/logger.js';
import { BUSINESS_SETTINGS_AREAS } from '../admin/services/businessSettings.defaults.js';

/**
 * Runtime reads of the Business Settings areas (see businessSettings.defaults.js),
 * for the order, delivery and restaurant code paths that obey them.
 *
 * Read at most every 30 seconds per process, like notification channels: these
 * sit on order placement and dispatch. Saving an area from the admin page
 * invalidates this process's copy at once; other processes catch up within
 * the TTL.
 *
 * A stored document that no longer passes a newer rule, or a database error,
 * reads as the area's defaults -- the old panel's values -- rather than
 * failing an order.
 */

const TTL_MS = 30 * 1000;
const cache = new Map();

export function invalidateBusinessSettings(area) {
    if (area) cache.delete(area);
    else cache.clear();
}

const defaultsOf = (area) => BUSINESS_SETTINGS_AREAS[area]({});

export async function getBusinessSettings(area) {
    const clean = BUSINESS_SETTINGS_AREAS[area];
    if (!clean) throw new Error(`Unknown business settings area ${area}`);
    const hit = cache.get(area);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
    let value;
    try {
        const row = await prisma.foodSystemSetting.findUnique({ where: { key: area } });
        try {
            value = clean(row?.value || {});
        } catch {
            value = defaultsOf(area);
        }
    } catch (error) {
        logger.warn(`Business settings ${area} unreadable, using defaults: ${error?.message || error}`);
        return defaultsOf(area);
    }
    cache.set(area, { at: Date.now(), value });
    return value;
}

/** Customer ordering paused (the website area's maintenance switch). */
export async function getMaintenanceState() {
    const hit = cache.get('website');
    if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
    let value = { maintenanceMode: false, maintenanceMessage: '' };
    try {
        const row = await prisma.foodSystemSetting.findUnique({ where: { key: 'website' } });
        const stored = row?.value && typeof row.value === 'object' ? row.value : {};
        value = {
            maintenanceMode: stored.maintenanceMode === true,
            maintenanceMessage: typeof stored.maintenanceMessage === 'string' ? stored.maintenanceMessage.slice(0, 500) : '',
        };
    } catch (error) {
        logger.warn(`Maintenance setting unreadable, treating as off: ${error?.message || error}`);
        return value;
    }
    cache.set('website', { at: Date.now(), value });
    return value;
}

/**
 * The sort an admin chose for a home or search section (Business Settings >
 * Priority setup), or null when the section uses its default order. Never
 * throws: a list must not fail because of its ordering setting.
 */
export async function getPrioritySort(section) {
    try {
        const { sections } = await getBusinessSettings('business_priority');
        const entry = sections?.[section];
        return entry?.mode === 'custom' ? entry.sort : null;
    } catch {
        return null;
    }
}
