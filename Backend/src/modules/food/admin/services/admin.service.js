/**
 * The admin service barrel.
 *
 * This file was 6,258 lines and 121 exports. Everything in it now lives in a
 * module named for what it does; the re-exports below exist so the twelve
 * callers that import from `admin.service.js` did not each have to change, and
 * so a route can keep asking for one thing without knowing which file it moved
 * to. Nothing should be added here — put it in the module it belongs to and add
 * a line below.
 */

export * from './adminZone.service.js';
export * from './adminSubAdmin.service.js';
export * from './adminCommission.service.js';
export * from './adminPlatformSettings.service.js';
export * from './adminCustomer.service.js';
export * from './adminSupportTicket.service.js';
export * from './adminWithdrawal.service.js';
export * from './adminEarningAddon.service.js';
export * from './adminDeliveryPartner.service.js';
export * from './adminDeliveryWallet.service.js';
export * from './adminCategory.service.js';
export * from './adminOffer.service.js';
export * from './adminAddon.service.js';
export * from './adminFood.service.js';
export * from './adminRestaurantLifecycle.service.js';
export * from './adminRestaurantDirectory.service.js';
export * from './adminFeedback.service.js';
export * from './adminRestaurantWrite.service.js';
export * from './adminDeliverySupport.service.js';
export * from './adminDashboard.service.js';
export * from './adminFinanceReport.service.js';
export * from './adminTaxReport.service.js';
export * from './adminRestaurantAnalytics.service.js';
export * from './adminDeliveryEarnings.service.js';

/**
 * Platform settings live in adminSettings.service.js — they are read by the
 * delivery, restaurant and referral modules, and had no business sitting inside
 * this file. Named rather than star-exported: the settings module has a wider
 * surface than the admin panel needs.
 */
export {
    getDeliveryCashLimitSettings,
    upsertDeliveryCashLimitSettings,
    getDeliveryEmergencyHelp,
    upsertDeliveryEmergencyHelp,
    getRestaurantSubscriptionSettings,
    addDeliveryPartnerBonus,
} from './adminSettings.service.js';
