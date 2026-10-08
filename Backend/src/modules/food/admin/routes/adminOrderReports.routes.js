import express from 'express';
import * as c from '../controllers/adminOrderReports.controller.js';

/**
 * Transaction / Order report and Restaurant-wise report.
 *
 * Mounted from admin.routes.js after its admin and permission middleware;
 * every path is under /reports, so report_management applies.
 */
const router = express.Router();

router.get('/reports/order-money', c.getOrderMoneyReport);
router.get('/reports/order-money/export', c.exportOrderMoneyReport);
router.get('/reports/restaurant-wise', c.getRestaurantWiseReport);
router.get('/reports/restaurant-wise/export', c.exportRestaurantWiseReport);

export default router;
