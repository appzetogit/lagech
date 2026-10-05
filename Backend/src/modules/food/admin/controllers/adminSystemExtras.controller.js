import { sendResponse, sendError } from '../../../../utils/response.js';
import { isId } from '../../../../utils/helpers.js';
import * as methods from '../services/withdrawalMethods.service.js';
import * as payments from '../services/adminRestaurantPayments.service.js';
import * as reports from '../services/adminMoneyReports.service.js';
import * as emailTemplates from '../services/emailTemplates.service.js';
import * as extras from '../services/adminSystemExtras.service.js';
import * as gallery from '../services/adminGallery.service.js';
import {
    validate,
    withdrawalMethodSchema,
    payoutDetailsSchema,
    restaurantPaymentSchema,
    socialLinkSchema,
    emailTemplateSchema,
    settingsSchema,
} from '../validators/systemExtras.validator.js';

/**
 * Controllers for withdrawal methods, restaurant payments, the money reports,
 * email templates, system settings, social media and the gallery -- plus the
 * restaurant-panel, rider-app and public endpoints that read them.
 */

const handle = (status, message, run) => async (req, res, next) => {
    try {
        return sendResponse(res, status, message, await run(req));
    } catch (error) {
        return next(error);
    }
};

const adminId = (req) => req.user?.userId || null;

// ─── Withdrawal methods (admin) ──────────────────────────────────────────────

export const listWithdrawalMethods = handle(200, 'Withdrawal methods', (req) => methods.listWithdrawalMethods(req.query || {}));
export const createWithdrawalMethod = handle(201, 'Withdrawal method added', (req) =>
    methods.createWithdrawalMethod(validate(withdrawalMethodSchema, req.body)));
export const updateWithdrawalMethod = handle(200, 'Withdrawal method saved', (req) =>
    methods.updateWithdrawalMethod(req.params.id, validate(withdrawalMethodSchema, req.body)));
export const deleteWithdrawalMethod = handle(200, 'Withdrawal method deleted', (req) => methods.deleteWithdrawalMethod(req.params.id));

// ─── Payout details (restaurant panel, rider app) ────────────────────────────

const payee = (ownerType) => ({
    listMethods: handle(200, 'Payout methods', async () => ({ methods: await methods.listActiveWithdrawalMethods() })),
    getDetails: async (req, res, next) => {
        if (!isId(req.user?.userId)) return sendError(res, 401, 'Sign in again');
        return handle(200, 'Payout details', () => methods.getPayoutDetails(ownerType, req.user.userId))(req, res, next);
    },
    saveDetails: async (req, res, next) => {
        if (!isId(req.user?.userId)) return sendError(res, 401, 'Sign in again');
        return handle(200, 'Payout details saved', () =>
            methods.savePayoutDetails(ownerType, req.user.userId, validate(payoutDetailsSchema, req.body)))(req, res, next);
    },
});

export const restaurantPayout = payee('restaurant');
export const riderPayout = payee('rider');

// ─── Restaurant payments (admin) ─────────────────────────────────────────────

export const listRestaurantPayments = handle(200, 'Restaurant payments', (req) => payments.listRestaurantPayments(req.query || {}));
export const getRestaurantPayable = handle(200, 'Restaurant balance', (req) => payments.getRestaurantPayable(req.params.restaurantId));
export const recordRestaurantPayment = handle(201, 'Payment recorded', (req) => {
    const body = validate(restaurantPaymentSchema, req.body);
    return payments.recordRestaurantPayment(body.restaurantId, body, adminId(req));
});

// ─── Reports (admin) ─────────────────────────────────────────────────────────

export const getDisbursementReport = handle(200, 'Disbursement report', (req) => reports.getDisbursementReport(req.query || {}));
export const getRestaurantEarningReport = handle(200, 'Restaurant earning report', (req) => reports.getRestaurantEarningReport(req.query || {}));
export const getRestaurantVatReport = handle(200, 'Restaurant VAT report', (req) => reports.getRestaurantVatReport(req.query || {}));

// ─── Email templates (admin) ─────────────────────────────────────────────────

export const listEmailTemplates = handle(200, 'Email templates', () => emailTemplates.listEmailTemplates());
export const getEmailTemplate = handle(200, 'Email template', (req) => emailTemplates.getEmailTemplate(req.params.key));
export const saveEmailTemplate = handle(200, 'Email template saved', (req) =>
    emailTemplates.saveEmailTemplate(req.params.key, validate(emailTemplateSchema, req.body), adminId(req)));
export const resetEmailTemplate = handle(200, 'Email template reset', (req) => emailTemplates.resetEmailTemplate(req.params.key));
export const previewEmailTemplate = handle(200, 'Email preview', (req) =>
    emailTemplates.previewEmailTemplate(req.params.key, validate(emailTemplateSchema, req.body)));

// ─── System settings (admin) ─────────────────────────────────────────────────

export const getSystemSettings = handle(200, 'Settings', (req) => extras.getSystemSettings(req.params.area));
export const saveSystemSettings = handle(200, 'Settings saved', (req) =>
    extras.saveSystemSettings(req.params.area, validate(settingsSchema, req.body), adminId(req)));

// ─── Social media (admin) ────────────────────────────────────────────────────

export const listSocialLinks = handle(200, 'Social media links', async () => ({ links: await extras.listSocialLinks() }));
export const createSocialLink = handle(201, 'Social media link added', (req) => extras.createSocialLink(validate(socialLinkSchema, req.body)));
export const updateSocialLink = handle(200, 'Social media link saved', (req) =>
    extras.updateSocialLink(req.params.id, validate(socialLinkSchema, req.body)));
export const deleteSocialLink = handle(200, 'Social media link deleted', (req) => extras.deleteSocialLink(req.params.id));

// ─── Gallery (admin) ─────────────────────────────────────────────────────────

export const listGalleryFiles = handle(200, 'Files', (req) => gallery.listGalleryFiles(req.query || {}));
export const getGalleryFileUsage = handle(200, 'File usage', async (req) => ({
    usage: await gallery.findFileUsage(req.query?.path),
}));
export const deleteGalleryFile = handle(200, 'File deleted', (req) => gallery.deleteGalleryFile(req.body?.path ?? req.query?.path));

// ─── Public ──────────────────────────────────────────────────────────────────

export const publicSocialMedia = handle(200, 'Social media', () => extras.getPublicSocialMedia());
export const publicAppSettings = handle(200, 'App settings', () => extras.getPublicAppSettings());
export const publicLanding = handle(200, 'Landing page', () => extras.getPublicLanding());
export const publicPageMeta = handle(200, 'Page meta data', () => extras.getPublicPageMeta());
