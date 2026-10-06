import express from 'express';
import * as c from '../controllers/adminSystemExtras.controller.js';

/**
 * Public (no sign-in) reads for the website and the apps, mounted at
 * /v1/food/public from routes/index.js.
 */
const router = express.Router();

router.get('/social-media', c.publicSocialMedia);
router.get('/app-settings', c.publicAppSettings);
router.get('/landing', c.publicLanding);
router.get('/page-meta', c.publicPageMeta);
router.get('/analytics', c.publicAnalytics);
router.get('/offline-payment-methods', c.publicOfflinePaymentMethods);
router.get('/business-settings', c.publicBusinessSettings);
router.get('/refund-reasons', c.publicRefundReasons);
router.get('/order-issue-reasons', c.publicOrderIssueReasons);

export default router;
