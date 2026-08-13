import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { sendResponse } from '../../../../utils/response.js';
import { getPublicGourmetRestaurants } from '../services/gourmet.service.js';
import { getLandingSettings } from '../services/landingSettings.service.js';
import { getPublicHomePromotionBanners } from '../services/homePromotionBanner.service.js';

const ACTIVE_BY_ORDER = {
    where: { isActive: true },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
};

/** The card fields every restaurant rail on the landing page renders. */
const RESTAURANT_CARD = {
    id: true, restaurantName: true, slug: true, area: true, city: true,
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

    return prisma.foodRestaurant.findMany({
        where: { id: { in: wanted }, status: 'approved', ...extraWhere },
        select,
    });
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
        const banners = await prisma.topBanner.findMany({
            where: { isActive: true },
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

export const getPublicLandingSettingsController = async (req, res, next) => {
    try {
        const { zoneId } = req.query;
        const settings = await getLandingSettings();

        const recommendedRestaurants = await hydrateRestaurants(
            settings?.recommendedRestaurantIds,
            {
                ...RESTAURANT_CARD,
                coverImages: true, menuImages: true, zoneId: true,
            },
            isId(zoneId) ? { zoneId: String(zoneId) } : {},
        );

        return sendResponse(res, 200, 'Landing settings fetched', {
            ...settings,
            recommendedRestaurantIds: undefined,
            recommendedRestaurants,
        });
    } catch (error) {
        next(error);
    }
};
