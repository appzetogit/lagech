import express from 'express';
import * as c from '../controllers/adminSystemExtras.controller.js';
import thirdPartyRoutes from './adminThirdParty.routes.js';

/**
 * Admin routes for withdrawal methods, restaurant payments, the money
 * reports, email templates, system settings, social media and the gallery.
 *
 * Mounted from admin.routes.js after its admin and permission middleware, so
 * every path here is already checked against the section resolveSectionFromRequest
 * maps it to: /withdrawals -> transaction_management, /reports ->
 * report_management, /email-templates, /system-settings and /gallery ->
 * system_settings, /social-media -> pages_social_media.
 */
const router = express.Router();

// Withdrawal methods.
router.get('/withdrawals/methods', c.listWithdrawalMethods);
router.post('/withdrawals/methods', c.createWithdrawalMethod);
router.patch('/withdrawals/methods/:id', c.updateWithdrawalMethod);
router.delete('/withdrawals/methods/:id', c.deleteWithdrawalMethod);

// Restaurant payments ("provide payment").
router.get('/withdrawals/restaurant-payments', c.listRestaurantPayments);
router.get('/withdrawals/restaurant-payments/payable/:restaurantId', c.getRestaurantPayable);
router.post('/withdrawals/restaurant-payments', c.recordRestaurantPayment);

// Reports.
router.get('/reports/disbursements', c.getDisbursementReport);
router.get('/reports/restaurant-earnings', c.getRestaurantEarningReport);
router.get('/reports/restaurant-vat', c.getRestaurantVatReport);

// Email templates.
router.get('/email-templates', c.listEmailTemplates);
router.get('/email-templates/:key', c.getEmailTemplate);
router.put('/email-templates/:key', c.saveEmailTemplate);
router.delete('/email-templates/:key', c.resetEmailTemplate);
router.post('/email-templates/:key/preview', c.previewEmailTemplate);

// Settings areas: page_meta, app_settings, login_setup, notification_channels,
// landing_page, website, push_messages, offline_payment, analytics_scripts.
// 3rd Party credentials (super admin only, secrets masked) -- adminThirdParty.routes.js.
router.use('/system-settings/third-party', thirdPartyRoutes);
router.get('/system-settings/:area', c.getSystemSettings);
router.put('/system-settings/:area', c.saveSystemSettings);

// Social media links.
router.get('/social-media', c.listSocialLinks);
router.post('/social-media', c.createSocialLink);
router.patch('/social-media/:id', c.updateSocialLink);
router.delete('/social-media/:id', c.deleteSocialLink);

// Gallery.
router.get('/gallery', c.listGalleryFiles);
router.get('/gallery/usage', c.getGalleryFileUsage);
router.delete('/gallery', c.deleteGalleryFile);

export default router;
