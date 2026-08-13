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

export const updateLandingSettings = (payload) => {
    const data = pickSettings(payload);
    return prisma.foodLandingSettings.upsert({
        where: { id: SINGLETON_ID },
        create: { id: SINGLETON_ID, ...data },
        update: { ...data, id: SINGLETON_ID },
    });
};
