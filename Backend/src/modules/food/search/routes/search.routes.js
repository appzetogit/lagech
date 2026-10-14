import express from 'express';
import { searchController, listAdminCategoriesController } from '../controllers/search.controller.js';
import { cacheResponse } from '../../../../middleware/cache.js';

const router = express.Router();

/**
 * Unified Search Endpoint
 * GET /api/v1/food/search/unified
 */
// 60s: results put closed restaurants last, and opening hours pass by the clock
// without any write that could invalidate the cache.
router.get('/unified', cacheResponse(60,'search_unified', { browserTtlSeconds: 30 }), searchController);

/**
 * Admin Categories Only Endpoint (to avoid restaurant-created ones as requested)
 * GET /api/v1/food/search/categories/admin
 */
router.get('/categories/admin', cacheResponse(1800, 'search_categories_admin', { browserTtlSeconds: 300 }), listAdminCategoriesController);

export default router;
