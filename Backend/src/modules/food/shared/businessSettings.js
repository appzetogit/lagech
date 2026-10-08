import { prisma } from '../../../config/prisma.js';
import { logger } from '../../../utils/logger.js';
import { ForbiddenError } from '../../../core/auth/errors.js';
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

/**
 * Business Settings > Business info "subscription business model". The switch
 * is the existing Restaurant Subscription feature flag (food_feature_settings
 * 'restaurant_subscription', on by default), not a second copy of it: the
 * admin page reads and writes that flag, so the Feature settings page and
 * this switch can never disagree. Cached like the areas.
 */
export const SUBSCRIPTION_FEATURE_KEY = 'restaurant_subscription';

export async function isSubscriptionModelOn() {
    const hit = cache.get(SUBSCRIPTION_FEATURE_KEY);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
    let value = true;
    try {
        const row = await prisma.foodFeatureSetting.findUnique({
            where: { key: SUBSCRIPTION_FEATURE_KEY },
            select: { isEnabled: true },
        });
        value = row ? Boolean(row.isEnabled) : true;
    } catch (error) {
        logger.warn(`Subscription model flag unreadable, treating as on: ${error?.message || error}`);
        return true;
    }
    cache.set(SUBSCRIPTION_FEATURE_KEY, { at: Date.now(), value });
    return value;
}

/** Which business models are on: { commissionModel, subscriptionModel }. */
export async function getBusinessModels() {
    const [info, subscriptionModel] = await Promise.all([getBusinessSettings('business_info'), isSubscriptionModelOn()]);
    return { commissionModel: info.commissionModel, subscriptionModel };
}

const SELF_REGISTRATION = {
    restaurant: {
        area: 'business_vendor',
        key: 'restaurantSelfRegistration',
        message: 'Restaurant sign-up is closed right now. Please contact Lagech to list your restaurant.',
    },
    rider: {
        area: 'business_deliveryman',
        key: 'riderSelfRegistration',
        message: 'Delivery partner sign-up is closed right now. Please contact Lagech to join as a delivery partner.',
    },
};

/**
 * Business Settings "restaurant / deliveryman self registration": refuses the
 * public sign-up with a message for the app when it is off. Accounts an admin
 * creates do not go through here.
 */
export async function assertSelfRegistrationOpen(kind) {
    const rule = SELF_REGISTRATION[kind];
    if (!rule) throw new Error(`Unknown self registration ${kind}`);
    const settings = await getBusinessSettings(rule.area);
    if (settings[rule.key] === false) throw new ForbiddenError(rule.message);
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
