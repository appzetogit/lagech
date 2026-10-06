import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { ValidationError, NotFoundError } from '../../../../core/auth/errors.js';
import { invalidateChannelSettings, NOTIFICATION_EVENTS } from '../../../../core/notifications/notificationChannels.js';
import { invalidatePushMessages, PUSH_MESSAGE_CATALOG } from '../../../../core/notifications/pushMessages.js';
import {
    SETTINGS_AREAS,
    META_PAGES,
    APPS,
    PLATFORMS,
    LOGIN_OPTIONS,
    ANALYTICS_TOOLS,
    cleanSettings,
    readStoredSettings,
    cleanUrl,
} from './systemSettings.defaults.js';
import { BUSINESS_AREA_CATALOG } from './businessSettings.defaults.js';
import { invalidateBusinessSettings, getBusinessSettings, getMaintenanceState } from '../../shared/businessSettings.js';

/**
 * System settings stored one JSON document per area (page meta data, app
 * settings, login setup, notification channels, landing page, website), the
 * social media links, and what the public endpoints hand to the website and
 * the apps.
 */

// ─── Settings areas ──────────────────────────────────────────────────────────

/** What the admin page needs besides the values: the fixed lists it renders. */
const AREA_CATALOG = {
    page_meta: { pages: META_PAGES },
    app_settings: { apps: APPS, platforms: PLATFORMS },
    login_setup: { options: LOGIN_OPTIONS },
    notification_channels: {
        events: NOTIFICATION_EVENTS.map(({ key, label, audience }) => ({ key, label, audience })),
        wired: { push: true, sms: false, email: false },
    },
    landing_page: {},
    website: {},
    push_messages: {
        messages: PUSH_MESSAGE_CATALOG,
        events: NOTIFICATION_EVENTS.map(({ key, label }) => ({ key, label })),
    },
    offline_payment: { fieldTypes: ['text', 'number', 'email'] },
    analytics_scripts: { tools: ANALYTICS_TOOLS.map(({ key, label, idLabel, example }) => ({ key, label, idLabel, example })) },
    ...BUSINESS_AREA_CATALOG,
};

const assertArea = (area) => {
    if (!SETTINGS_AREAS[area]) throw new NotFoundError('Unknown settings area');
};

async function readArea(area) {
    const row = await prisma.foodSystemSetting.findUnique({ where: { key: area } });
    return { value: readStoredSettings(area, row?.value || {}), updatedAt: row?.updatedAt || null };
}

export async function getSystemSettings(area) {
    assertArea(area);
    const { value, updatedAt } = await readArea(area);
    return { area, value, updatedAt, catalog: AREA_CATALOG[area] };
}

export async function saveSystemSettings(area, body = {}, adminId = null) {
    assertArea(area);
    const value = cleanSettings(area, body.value ?? body);
    const row = await prisma.foodSystemSetting.upsert({
        where: { key: area },
        create: { key: area, value, updatedBy: adminId ? String(adminId) : null },
        update: { value, updatedBy: adminId ? String(adminId) : null },
    });
    if (area === 'notification_channels') invalidateChannelSettings();
    if (area === 'push_messages') invalidatePushMessages();
    if (area.startsWith('business_') || area === 'website') invalidateBusinessSettings(area);
    return { area, value, updatedAt: row.updatedAt, catalog: AREA_CATALOG[area] };
}

// ─── Social media ────────────────────────────────────────────────────────────

const serializeLink = (row) => ({
    id: row.id,
    platform: row.platform,
    url: row.url,
    isActive: row.isActive,
    sortOrder: row.sortOrder,
    updatedAt: row.updatedAt,
});

/** Social link input, checked. Pure. */
export function readSocialLink(body = {}, { partial = false } = {}) {
    const data = {};
    if (!partial || body.platform !== undefined) {
        const platform = String(body.platform ?? '').trim().slice(0, 40);
        if (!platform) throw new ValidationError('Platform name is required');
        data.platform = platform;
    }
    if (!partial || body.url !== undefined) {
        const url = cleanUrl(body.url, 'Link');
        if (!url || url.startsWith('/')) throw new ValidationError('Link must be a web address starting with https://');
        data.url = url;
    }
    if (body.isActive !== undefined) data.isActive = body.isActive === true || body.isActive === 'true';
    if (body.sortOrder !== undefined) {
        const order = Number(body.sortOrder);
        data.sortOrder = Number.isFinite(order) ? Math.trunc(order) : 0;
    }
    return data;
}

export async function listSocialLinks({ activeOnly = false } = {}) {
    const rows = await prisma.foodSocialMediaLink.findMany({
        where: activeOnly ? { isActive: true } : {},
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map(serializeLink);
}

export async function createSocialLink(body = {}) {
    return serializeLink(await prisma.foodSocialMediaLink.create({ data: readSocialLink(body) }));
}

export async function updateSocialLink(id, body = {}) {
    if (!isId(id)) throw new ValidationError('Invalid link');
    const data = readSocialLink(body, { partial: true });
    const { count } = await prisma.foodSocialMediaLink.updateMany({ where: { id: String(id) }, data });
    if (!count) throw new NotFoundError('Social media link not found');
    return serializeLink(await prisma.foodSocialMediaLink.findUnique({ where: { id: String(id) } }));
}

export async function deleteSocialLink(id) {
    if (!isId(id)) throw new ValidationError('Invalid link');
    const { count } = await prisma.foodSocialMediaLink.deleteMany({ where: { id: String(id) } });
    if (!count) throw new NotFoundError('Social media link not found');
    return { id: String(id), deleted: true };
}

// ─── Public ──────────────────────────────────────────────────────────────────

/** Active social links, for the website footer and the apps. */
export async function getPublicSocialMedia() {
    const links = await listSocialLinks({ activeOnly: true });
    return { links: links.map(({ platform, url }) => ({ platform, url })) };
}

/**
 * Minimum and latest versions and store links per app and platform, for
 * force-update checks, plus the sign-in options the apps should offer.
 * An app older than minVersion must update; older than latestVersion may.
 */
export async function getPublicAppSettings() {
    const [apps, login, analytics, business] = await Promise.all([
        readArea('app_settings'),
        readArea('login_setup'),
        getPublicAnalytics(),
        getPublicBusinessSettings(),
    ]);
    return { apps: apps.value, login: login.value, analytics, business, updatedAt: apps.updatedAt };
}

/**
 * The tracking ids switched on, for the customer website to load the standard
 * Google Analytics / Tag Manager / Meta Pixel snippets. Off or blank tools are
 * left out.
 */
export async function getPublicAnalytics() {
    const { value } = await readArea('analytics_scripts');
    return Object.fromEntries(
        ANALYTICS_TOOLS.filter((tool) => value[tool.key]?.enabled && value[tool.key]?.id).map((tool) => [tool.key, value[tool.key].id]),
    );
}

/** Offline payment as the admin set it up (orders read it at checkout). */
export async function getOfflinePaymentSettings() {
    return (await readArea('offline_payment')).value;
}

/**
 * What checkout offers: nothing when offline payment is switched off,
 * otherwise each active method with what to pay to and what to fill in.
 */
export async function getPublicOfflinePaymentMethods() {
    const settings = await getOfflinePaymentSettings();
    if (!settings.enabled) return { enabled: false, methods: [] };
    return {
        enabled: true,
        methods: settings.methods
            .filter((method) => method.isActive)
            .map(({ id, name, paymentInfo, fields }) => ({ id, name, paymentInfo, fields })),
    };
}

/** SEO title, description and image per public page. */
export async function getPublicPageMeta() {
    return (await readArea('page_meta')).value;
}

/**
 * Everything the public landing page shows. App links left blank on the
 * landing settings fall back to the store links on App Settings, so the two
 * pages cannot point at different stores by accident.
 */
export async function getPublicLanding() {
    const [landing, apps, website, social] = await Promise.all([
        readArea('landing_page'),
        readArea('app_settings'),
        readArea('website'),
        getPublicSocialMedia(),
    ]);
    const links = { ...landing.value.appLinks };
    for (const app of APPS) {
        for (const platform of PLATFORMS) {
            const key = `${app.key}${platform.key === 'ios' ? 'Ios' : 'Android'}`;
            if (!links[key]) links[key] = apps.value[app.key][platform.key].storeUrl;
        }
    }
    return {
        ...landing.value,
        appLinks: links,
        socialMedia: social.links,
        website: website.value,
        updatedAt: landing.updatedAt,
    };
}

/**
 * The Business Settings the apps act on (payment options, order types,
 * maintenance, rider limits, ...), for GET /food/public/app-settings
 * (`business`) and GET /food/public/business-settings. Admin-only values
 * such as commission rates are left out.
 */
export async function getPublicBusinessSettings() {
    const [info, order, payment, customer, deliveryman, vendor, refund, offline, maintenance] = await Promise.all([
        getBusinessSettings('business_info'),
        getBusinessSettings('business_order'),
        getBusinessSettings('business_payment'),
        getBusinessSettings('business_customer'),
        getBusinessSettings('business_deliveryman'),
        getBusinessSettings('business_vendor'),
        getBusinessSettings('business_refund'),
        getOfflinePaymentSettings(),
        getMaintenanceState(),
    ]);
    const nc = customer.newCustomerDiscount;
    return {
        maintenance,
        currency: { code: info.currency, decimals: info.currencyDecimals },
        payment: {
            cod: payment.cod,
            digital: payment.digital,
            offline: Boolean(offline.enabled && offline.methods.some((method) => method.isActive)),
            wallet: customer.walletEnabled,
            partialPayment: payment.partialPayment && customer.walletEnabled,
            partialPaymentMethod: payment.partialPaymentMethod,
        },
        order: {
            homeDelivery: order.homeDelivery,
            takeaway: order.takeaway,
            scheduledOrder: order.scheduledOrder,
            scheduleSlotMinutes: order.scheduleSlotMinutes,
            freeDeliveryOver: order.freeDelivery.enabled ? order.freeDelivery.minSubtotal : null,
        },
        customer: {
            wallet: customer.walletEnabled,
            addFund: customer.walletEnabled && customer.addFundEnabled,
            vegNonVegToggle: customer.vegNonVegToggle,
            guestCheckout: customer.guestCheckout,
            newCustomerDiscount: nc.enabled
                ? { type: nc.type, value: nc.value, maxDiscount: nc.maxDiscount || null, minOrderAmount: nc.minOrderAmount, validityDays: nc.validityDays }
                : null,
        },
        rider: {
            maxAssignedOrders: deliveryman.maxAssignedOrders,
            canCancelOrder: deliveryman.riderCanCancelOrder,
            showEarning: deliveryman.showEarningToRider,
            pictureUpload: deliveryman.riderPictureUpload,
            selfRegistration: deliveryman.riderSelfRegistration,
        },
        restaurant: {
            canCancelOrder: vendor.restaurantCanCancelOrder,
            canReplyToReviews: vendor.canReplyToReviews,
            dishApprovalRequired: vendor.dishApprovalRequired,
            selfRegistration: vendor.restaurantSelfRegistration,
        },
        refund: { requestEnabled: refund.refundRequestEnabled },
    };
}

/** Active reasons of a reason-list area, for the customer app. */
export async function getPublicReasons(area) {
    const value = await getBusinessSettings(area);
    return { reasons: value.reasons.filter((reason) => reason.isActive).map(({ id, text }) => ({ id, text })) };
}
