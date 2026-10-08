import {
    listHeroBanners,
    createHeroBannersFromFiles,
    deleteHeroBanner,
    updateHeroBannerOrder,
    toggleHeroBannerStatus,
    createHeroBanner,
    updateHeroBanner,
    setHeroBannerFeatured
} from '../services/heroBanner.service.js';
import { sendResponse } from '../../../../utils/response.js';
import { ValidationError } from '../../../../core/auth/errors.js';

export const listHeroBannersController = async (req, res, next) => {
    try {
        const data = await listHeroBanners();
        // Wrap in { banners } to match LandingPageManagement.jsx expectations
        return sendResponse(res, 200, 'Hero banners fetched successfully', { banners: data });
    } catch (error) {
        next(error);
    }
};

export const uploadHeroBannersController = async (req, res, next) => {
    try {
        if (!req.files || !req.files.length) {
            throw new ValidationError('No files uploaded');
        }

        const meta = {
            title: req.body.title,
            ctaText: req.body.ctaText,
            ctaLink: req.body.ctaLink
        };

        const results = await createHeroBannersFromFiles(req.files, meta);
        return sendResponse(res, 201, 'Hero banners uploaded', { results });
    } catch (error) {
        next(error);
    }
};

export const deleteHeroBannerController = async (req, res, next) => {
    try {
        const { id } = req.params;
        if (!id) {
            throw new ValidationError('Banner id is required');
        }
        const result = await deleteHeroBanner(id);
        return sendResponse(res, 200, result.deleted ? 'Hero banner deleted' : 'Hero banner not found', result);
    } catch (error) {
        next(error);
    }
};

export const updateHeroBannerOrderController = async (req, res, next) => {
    try {
        const { id } = req.params;
        const { sortOrder } = req.body;
        if (!id || typeof sortOrder !== 'number') {
            throw new ValidationError('id and numeric sortOrder are required');
        }
        const updated = await updateHeroBannerOrder(id, sortOrder);
        return sendResponse(res, 200, 'Hero banner order updated', updated);
    } catch (error) {
        next(error);
    }
};

export const toggleHeroBannerStatusController = async (req, res, next) => {
    try {
        const { id } = req.params;
        const { isActive } = req.body;
        if (!id || typeof isActive !== 'boolean') {
            throw new ValidationError('id and boolean isActive are required');
        }
        const updated = await toggleHeroBannerStatus(id, isActive);
        return sendResponse(res, 200, 'Hero banner status updated', updated);
    } catch (error) {
        next(error);
    }
};


/** POST /hero-banners (multipart: file + title, zoneId, bannerType, linkedRestaurantIds|restaurantId, linkedFoodId, ctaLink, isFeatured) */
export const createHeroBannerController = async (req, res, next) => {
    try {
        const banner = await createHeroBanner(req.file, req.body || {});
        return sendResponse(res, 201, 'Banner created', { banner });
    } catch (error) {
        next(error);
    }
};

/** PATCH /hero-banners/:id (multipart; file optional) */
export const updateHeroBannerController = async (req, res, next) => {
    try {
        const banner = await updateHeroBanner(req.params.id, req.file, req.body || {});
        if (!banner) return res.status(404).json({ success: false, message: 'Banner not found' });
        return sendResponse(res, 200, 'Banner updated', { banner });
    } catch (error) {
        next(error);
    }
};

/** PATCH /hero-banners/:id/featured { isFeatured } */
export const toggleHeroBannerFeaturedController = async (req, res, next) => {
    try {
        const { isFeatured } = req.body || {};
        if (typeof isFeatured !== 'boolean') throw new ValidationError('boolean isFeatured is required');
        const banner = await setHeroBannerFeatured(req.params.id, isFeatured);
        if (!banner) return res.status(404).json({ success: false, message: 'Banner not found' });
        return sendResponse(res, 200, 'Banner updated', banner);
    } catch (error) {
        next(error);
    }
};
