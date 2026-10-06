import express from 'express';
import { upload } from '../../../../middleware/upload.js';
import * as extras from '../controllers/adminCatalogExtras.controller.js';
import * as campaigns from '../../campaigns/campaigns.controller.js';

/**
 * Catalog and promotion pages carried over from the previous admin panel:
 * dish reviews, food gallery, addon categories, recommended restaurants, bulk
 * import/export, and campaigns.
 *
 * Mounted by admin.routes.js before its own routes (so "/restaurants/bulk/..."
 * is never read as a restaurant id), and after its permission guard: the paths
 * sit under /foods, /addons, /categories and /restaurants so they inherit those
 * sections, and /campaigns is promotions management.
 */
const router = express.Router();

// ----- Dish reviews (Food Setup -> Review) -----
router.get('/foods/reviews', extras.listFoodReviews);
router.patch('/foods/reviews/:id/visibility', extras.setFoodReviewVisibility);

// ----- Food gallery -----
router.get('/foods/gallery', extras.listFoodGallery);

// ----- Addon categories -----
router.get('/addons/categories', extras.listAddonCategories);
router.post('/addons/categories', extras.createAddonCategory);
router.patch('/addons/categories/:id', extras.updateAddonCategory);
router.delete('/addons/categories/:id', extras.deleteAddonCategory);
router.patch('/addons/:id/category', extras.setAddonCategory);

// ----- Recommended restaurants -----
router.get('/restaurants/recommended', extras.listRecommendedRestaurants);
router.put('/restaurants/recommended', extras.saveRecommendedRestaurants);

// ----- Bulk import / export -----
for (const [base, entity] of [['/categories', 'categories'], ['/addons', 'addons'], ['/restaurants', 'restaurants']]) {
    router.get(`${base}/bulk/template`, extras.bulkTemplate(entity));
    router.post(`${base}/bulk/import`, upload.single('file'), extras.bulkImport(entity));
    router.get(`${base}/bulk/export`, extras.bulkExport(entity));
}

// ----- Campaigns -----
router.get('/campaigns/basic', campaigns.listBasic);
router.post('/campaigns/basic', campaigns.createBasic);
router.patch('/campaigns/basic/:id', campaigns.updateBasic);
router.delete('/campaigns/basic/:id', campaigns.deleteBasic);
router.get('/campaigns/basic/:id/restaurants', campaigns.listBasicRestaurants);
router.put('/campaigns/basic/:id/restaurants/:restaurantId', campaigns.joinBasic);
router.delete('/campaigns/basic/:id/restaurants/:restaurantId', campaigns.leaveBasic);
router.get('/campaigns/food', campaigns.listFood);
router.post('/campaigns/food', campaigns.createFood);
router.patch('/campaigns/food/:id', campaigns.updateFood);
router.delete('/campaigns/food/:id', campaigns.deleteFood);

export default router;
