import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';

/**
 * Landing settings are a singleton.
 *
 * Mongo expressed that as `findOne({})` / `findOneAndUpdate({}, …, {upsert})`,
 * which is only a singleton by convention — two concurrent first-time reads
 * both insert, and every later read then picks one of the two rows
 * arbitrarily. Pinning the primary key makes it a singleton the database
 * enforces, at the cost of one constant.
 *
 * The value is 24 hex characters so it passes the same `isId` check as every
 * other id in the system.
 */
const SINGLETON_ID = '000000000000000000000001';

const BOOLEAN_KEYS = [
    'showHeroBanners', 'showUnder250', 'showDining',
    'showExploreIcons', 'showTop10', 'showGourmet',
];

/**
 * The controller forwards `req.body` untouched. Mongoose quietly dropped keys
 * the schema did not declare; Prisma rejects the whole call with "Unknown arg",
 * so an admin sending one extra field would get a 500 instead of a save.
 */
const pickSettings = (payload = {}) => {
    const data = {};

    if (payload.exploreMoreHeading !== undefined) {
        data.exploreMoreHeading = String(payload.exploreMoreHeading);
    }
    if (payload.recommendedRestaurantIds !== undefined) {
        data.recommendedRestaurantIds = (payload.recommendedRestaurantIds || [])
            .map(String)
            .filter(isId);
    }
    if (payload.recommendedOrderMode !== undefined) {
        const mode = String(payload.recommendedOrderMode);
        data.recommendedOrderMode = ['manual', 'nearest'].includes(mode) ? mode : 'manual';
    }
    for (const key of BOOLEAN_KEYS) {
        if (payload[key] !== undefined) data[key] = Boolean(payload[key]);
    }

    return data;
};

export const getLandingSettings = () =>
    prisma.foodLandingSettings.upsert({
        where: { id: SINGLETON_ID },
        create: { id: SINGLETON_ID },
        // Writing the key back to itself is a no-op that keeps `update`
        // non-empty, which is what makes Prisma compile this to
        // INSERT … ON CONFLICT. With `update: {}` it degrades to
        // SELECT-then-INSERT and loses the race. See prisma/README.md.
        update: { id: SINGLETON_ID },
    });

const ORDER_MODES = ['manual', 'nearest'];

/**
 * The rail configuration that applies in one zone.
 *
 * A zone row overrides the singleton; a zone without one inherits it, so
 * nothing changes until a zone is actually configured.
 *
 * An empty list on a zone row counts as "not overridden" rather than "show
 * nothing". A zone that wants no rail has no restaurants to list either way,
 * and reading empty as an override would mean an admin who opened a zone,
 * changed only the ordering and saved would silently empty that zone's rail.
 * The mode is taken from the zone row whenever one exists, since it is never
 * null and choosing it is the reason to create the row.
 */
export const resolveLandingSettingsForZone = async (zoneId) => {
    const global = await getLandingSettings();
    const zoned = isId(zoneId)
        ? await prisma.foodLandingZoneSettings.findUnique({ where: { zoneId: String(zoneId) } })
        : null;

    const ids =
        zoned && zoned.recommendedRestaurantIds?.length
            ? zoned.recommendedRestaurantIds
            : global.recommendedRestaurantIds;

    return {
        ...global,
        recommendedRestaurantIds: ids,
        recommendedOrderMode: zoned?.recommendedOrderMode || global.recommendedOrderMode || 'manual',
        /// So the admin screen can tell "overrides the default" from
        /// "inherits it" -- they render identically otherwise.
        resolvedFromZone: Boolean(zoned),
    };
};

/** Read one zone's own row, without inheriting. For the admin screen. */
export const getLandingZoneSettings = async (zoneId) => {
    if (!isId(zoneId)) return null;
    return prisma.foodLandingZoneSettings.findUnique({ where: { zoneId: String(zoneId) } });
};

export const updateLandingZoneSettings = async (zoneId, payload = {}) => {
    if (!isId(zoneId)) throw new Error('Invalid zone id');

    const data = {};
    if (payload.recommendedRestaurantIds !== undefined) {
        data.recommendedRestaurantIds = (payload.recommendedRestaurantIds || [])
            .map(String)
            .filter(isId);
    }
    if (payload.recommendedOrderMode !== undefined) {
        const mode = String(payload.recommendedOrderMode);
        // Fall back rather than throw: an unknown mode from an older client
        // should not block a save of the list alongside it.
        data.recommendedOrderMode = ORDER_MODES.includes(mode) ? mode : 'manual';
    }

    return prisma.foodLandingZoneSettings.upsert({
        where: { zoneId: String(zoneId) },
        create: { zoneId: String(zoneId), ...data },
        update: data,
    });
};

/** Drop a zone's overrides so it inherits the global settings again. */
export const clearLandingZoneSettings = async (zoneId) => {
    if (!isId(zoneId)) throw new Error('Invalid zone id');
    await prisma.foodLandingZoneSettings.deleteMany({ where: { zoneId: String(zoneId) } });
    return { zoneId: String(zoneId), cleared: true };
};

export const updateLandingSettings = (payload) => {
    const data = pickSettings(payload);
    return prisma.foodLandingSettings.upsert({
        where: { id: SINGLETON_ID },
        create: { id: SINGLETON_ID, ...data },
        update: { ...data, id: SINGLETON_ID },
    });
};
