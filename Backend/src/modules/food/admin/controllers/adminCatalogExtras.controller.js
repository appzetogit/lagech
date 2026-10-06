import * as reviews from '../services/adminFoodReviews.service.js';
import * as addonCategories from '../services/adminAddonCategory.service.js';
import * as gallery from '../services/adminFoodGallery.service.js';
import * as recommended from '../services/adminRecommendedRestaurants.service.js';
import * as bulk from '../services/adminBulkCatalog.service.js';
import {
    validateAddonCategoryCreate,
    validateAddonCategoryUpdate,
    validateRecommendedList,
    validateDisplayPosition,
    validateReviewVisibility,
    validateSetAddonCategory,
} from '../validators/catalogExtras.validator.js';

/** One JSON handler shape for every endpoint here. */
const handle = (fn, { status = 200, message = 'OK' } = {}) => async (req, res, next) => {
    try {
        res.status(status).json({ success: true, message, data: await fn(req) });
    } catch (error) {
        next(error);
    }
};

/** Send a generated sheet as a download. */
const download = (fn) => async (req, res, next) => {
    try {
        const { buffer, contentType, filename } = await fn(req);
        res.setHeader('Content-Type', contentType);
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Cache-Control', 'no-store');
        res.status(200).send(buffer);
    } catch (error) {
        next(error);
    }
};

// Dish reviews
export const listFoodReviews = handle((req) => reviews.listFoodReviews(req.query || {}));
export const setFoodReviewVisibility = handle(
    (req) => reviews.setFoodReviewHidden(req.params.id, validateReviewVisibility(req.body)),
    { message: 'Review updated' },
);

// Food gallery
export const listFoodGallery = handle((req) => gallery.listFoodGallery(req.query || {}));

// Addon categories
export const listAddonCategories = handle((req) => addonCategories.listAddonCategories(req.query || {}));
export const createAddonCategory = handle(
    async (req) => ({ category: await addonCategories.createAddonCategory(validateAddonCategoryCreate(req.body)) }),
    { status: 201, message: 'Addon category created' },
);
export const updateAddonCategory = handle(
    async (req) => ({ category: await addonCategories.updateAddonCategory(req.params.id, validateAddonCategoryUpdate(req.body)) }),
    { message: 'Addon category saved' },
);
export const deleteAddonCategory = handle((req) => addonCategories.deleteAddonCategory(req.params.id), { message: 'Addon category deleted' });
export const setAddonCategory = handle(
    (req) => addonCategories.setAddonCategory(req.params.id, validateSetAddonCategory(req.body)),
    { message: 'Add-on category saved' },
);

// Recommended restaurants
export const listRecommendedRestaurants = handle(() => recommended.listRecommendedRestaurants());
export const saveRecommendedRestaurants = handle(
    (req) => recommended.saveRecommendedRestaurants(validateRecommendedList(req.body)),
    { message: 'Recommended restaurants saved' },
);

export const setRestaurantDisplayPosition = handle(
    (req) => recommended.setRestaurantDisplayPosition(String(req.params.id), validateDisplayPosition(req.body)),
    { message: 'Position saved' },
);

// Bulk import / export: categories, addons, restaurants
export const bulkTemplate = (entity) => download((req) => bulk.buildTemplate(entity, req.query?.format));
export const bulkImport = (entity) =>
    handle(
        (req) => ({ categories: bulk.importCategories, addons: bulk.importAddons, restaurants: bulk.importRestaurants }[entity])(req.file),
        { message: 'Import finished' },
    );
export const bulkExport = (entity) =>
    download((req) => ({ categories: bulk.exportCategories, addons: bulk.exportAddons, restaurants: bulk.exportRestaurants }[entity])(req.query || {}));
