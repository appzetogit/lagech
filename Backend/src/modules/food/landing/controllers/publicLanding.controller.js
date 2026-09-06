import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { sendResponse } from '../../../../utils/response.js';
import { getPublicGourmetRestaurants } from '../services/gourmet.service.js';
import { resolveLandingSettingsForZone } from '../services/landingSettings.service.js';
import {
    haversineKm,
    isValidLatitude,
    isValidLongitude,
} from '../../shared/geo.utils.js';
import { getPublicHomePromotionBanners } from '../services/homePromotionBanner.service.js';

const ACTIVE_BY_ORDER = {
    where: { isActive: true },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
};

/** The card fields every restaurant rail on the landing page renders. */
const RESTAURANT_CARD = {
    id: true, restaurantName: true, area: true, city: true,
    // The slug is the normalised name — there is no separate column, and
    // getApprovedRestaurantByIdOrSlug resolves a slug against this one.
    restaurantNameNormalized: true,
    rating: true, cuisines: true, profileImage: true, pureVegRestaurant: true,
};

/**
 * Hydrate a list of restaurant ids, dropping unapproved ones.
 *
 * Mongo did this with `.populate()`, which silently kept unapproved and deleted
 * restaurants in the rail. The ids are a plain String[] column now, so the fetch
 * is explicit — and can apply the status filter the populate never did.
 */
const hydrateRestaurants = async (ids, select, extraWhere = {}) => {
    const wanted = [...new Set((ids || []).map(String).filter(isId))];
    if (!wanted.length) return [];

    const rows = await prisma.foodRestaurant.findMany({
        where: { id: { in: wanted }, status: 'approved', ...extraWhere },
        select,
    });

    // Back into the order the ids were given in.
    //
    // `WHERE id IN (...)` has no inherent order, so Postgres returned these in
    // whatever order it liked and the arrangement an admin set on the
    // Recommended For You rail was simply lost -- the rail came out shuffled
    // and reordering it in the admin changed nothing. The hero banner caller
    // re-sorted its own copy afterwards and so never saw this; the landing
    // settings caller used the rows as they came.
    const position = new Map(wanted.map((id, index) => [id, index]));
    return rows.sort(
        (a, b) => (position.get(String(a.id)) ?? 0) - (position.get(String(b.id)) ?? 0),
    );
};

export const getPublicHeroBannersController = async (req, res, next) => {
    try {
        const docs = await prisma.foodHeroBanner.findMany(ACTIVE_BY_ORDER);

        // One query for every banner's links, rather than one per banner.
        const linked = await hydrateRestaurants(
            docs.flatMap((b) => b.linkedRestaurantIds || []),
            RESTAURANT_CARD,
        );
        const byId = new Map(linked.map((r) => [r.id, r]));

        const banners = docs.map(({ linkedRestaurantIds, ...rest }) => ({
            ...rest,
            linkedRestaurants: (linkedRestaurantIds || [])
                .map((id) => byId.get(String(id)))
                .filter(Boolean),
        }));

        return sendResponse(res, 200, 'Hero banners fetched', { banners });
    } catch (error) {
        next(error);
    }
};

export const getPublicTopBannersController = async (req, res, next) => {
    try {
        const zoneId = req.query?.zoneId;
        const banners = await prisma.topBanner.findMany({
            where: {
                isActive: true,
                // Global banners (zoneId null) always show; a zone only ever
                // adds to them. Filtering to the zone alone would hide every
                // global banner the moment one zone-scoped banner existed.
                ...(isId(zoneId) ? { OR: [{ zoneId: null }, { zoneId: String(zoneId) }] } : {}),
            },
            orderBy: { order: 'asc' },
        });
        return sendResponse(res, 200, 'Top banners fetched', { banners });
    } catch (error) {
        next(error);
    }
};

export const getPublicUnder250BannersController = async (req, res, next) => {
    try {
        const banners = await prisma.foodUnder250Banner.findMany(ACTIVE_BY_ORDER);
        return sendResponse(res, 200, 'Under 250 banners fetched', { banners });
    } catch (error) {
        next(error);
    }
};

export const getPublicDiningBannersController = async (req, res, next) => {
    try {
        const banners = await prisma.foodDiningBanner.findMany(ACTIVE_BY_ORDER);
        return sendResponse(res, 200, 'Dining banners fetched', { banners });
    } catch (error) {
        next(error);
    }
};

export const getPublicExploreIconsController = async (req, res, next) => {
    try {
        const docs = await prisma.foodExploreIcon.findMany(ACTIVE_BY_ORDER);
        // The client reads `link`/`order`; the columns are targetPath/sortOrder.
        const items = docs.map(({ targetPath, sortOrder, ...rest }) => ({
            ...rest,
            link: targetPath,
            order: sortOrder,
        }));
        return sendResponse(res, 200, 'Explore icons fetched', { items });
    } catch (error) {
        next(error);
    }
};

export const getPublicHomePromotionBannersController = async (req, res, next) => {
    try {
        const banners = await getPublicHomePromotionBanners(req.query.zoneId);
        return sendResponse(res, 200, 'Home promotion banners fetched', { banners });
    } catch (error) {
        next(error);
    }
};

export const getPublicGourmetController = async (req, res, next) => {
    try {
        const docs = await getPublicGourmetRestaurants(req.query.zoneId);
        const restaurants = docs
            // Entries whose restaurant is unapproved or in another zone come back
            // with restaurant: null and are not part of the public rail.
            .filter((d) => d.restaurant)
            .map((d) => ({ ...d.restaurant, _id: d.restaurant._id, priority: d.priority }));

        return sendResponse(res, 200, 'Gourmet restaurants fetched', { restaurants });
    } catch (error) {
        next(error);
    }
};

/**
 * Closest first, for zones set to `nearest`.
 *
 * A restaurant with no coordinates sorts last rather than first: NaN and
 * Infinity both poison a comparator, and an unplaceable restaurant is the one
 * we are least able to claim is nearby.
 */
const byDistanceFrom = (lat, lng) => (a, b) => {
    const d = (r) =>
        Number.isFinite(r?.latitude) && Number.isFinite(r?.longitude)
            ? haversineKm(lat, lng, r.latitude, r.longitude)
            : Number.MAX_SAFE_INTEGER;
    return d(a) - d(b);
};

export const getPublicLandingSettingsController = async (req, res, next) => {
    try {
        const { zoneId } = req.query;
        const settings = await resolveLandingSettingsForZone(zoneId);

        const recommendedRestaurants = await hydrateRestaurants(
            settings?.recommendedRestaurantIds,
            {
                ...RESTAURANT_CARD,
                coverImages: true, menuImages: true, zoneId: true,
                latitude: true, longitude: true,
            },
            isId(zoneId) ? { zoneId: String(zoneId) } : {},
        );

        // hydrateRestaurants already returns them in the admin's order, which
        // is what `manual` means, so only `nearest` re-sorts.
        const lat = Number(req.query.lat);
        const lng = Number(req.query.lng);
        const hasCustomerLocation = isValidLatitude(lat) && isValidLongitude(lng);
        const orderMode = settings?.recommendedOrderMode === 'nearest' ? 'nearest' : 'manual';

        if (orderMode === 'nearest' && hasCustomerLocation) {
            recommendedRestaurants.sort(byDistanceFrom(lat, lng));
        }

        return sendResponse(res, 200, 'Landing settings fetched', {
            ...settings,
            recommendedRestaurantIds: undefined,
            recommendedRestaurants,
            /// What actually happened, not what was configured. `nearest` with
            /// no customer location falls back to the admin's order, and a
            /// client showing "Nearest first" over a manual list would be
            /// lying to the customer.
            recommendedOrderApplied:
                orderMode === 'nearest' && !hasCustomerLocation ? 'manual' : orderMode,
        });
    } catch (error) {
        next(error);
    }
};
