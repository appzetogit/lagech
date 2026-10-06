import { ValidationError } from '../../../../core/auth/errors.js';
import crypto from 'crypto';
import { normalizeChannelSettings } from '../../../../core/notifications/notificationChannels.js';
import { normalizePushMessages } from '../../../../core/notifications/pushMessages.js';
import { normalizeMethodFields } from './payoutMethods.util.js';

/**
 * The settings areas stored in food_system_settings, one JSON document each:
 * their defaults, and the function that turns whatever the admin sent into a
 * clean document. Unknown keys are dropped, types are coerced, lengths are
 * capped and URLs and version numbers are checked, so what the public
 * endpoints hand to the apps is always the expected shape.
 *
 * Pure, so every rule is tested without a database.
 */

const str = (value, max = 500) => String(value ?? '').trim().slice(0, max);
const bool = (value, fallback = false) =>
    value === undefined || value === null ? fallback : value === true || value === 'true' || value === 1 || value === '1';

/** '' or an http(s) URL or a site path such as /uploads/... */
export function cleanUrl(value, label) {
    const url = str(value, 1000);
    if (!url) return '';
    if (url.startsWith('/') && !url.startsWith('//')) return url;
    try {
        const parsed = new URL(url);
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return url;
    } catch {
        /* falls through */
    }
    throw new ValidationError(`${label} must be a web address starting with https://`);
}

/** '' or a dotted version number such as 2.4.1. */
export function cleanVersion(value, label) {
    const version = str(value, 20);
    if (!version) return '';
    if (!/^\d+(\.\d+){0,3}$/.test(version)) throw new ValidationError(`${label} must be a version number such as 2.4.1`);
    return version;
}

/** -1, 0 or 1 as a < b, a == b, a > b, comparing dotted versions numerically. */
export function compareVersions(a, b) {
    const left = String(a || '0').split('.').map(Number);
    const right = String(b || '0').split('.').map(Number);
    for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
        const diff = (left[i] || 0) - (right[i] || 0);
        if (diff) return diff > 0 ? 1 : -1;
    }
    return 0;
}

const obj = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});

// ─── Page meta data ──────────────────────────────────────────────────────────

export const META_PAGES = [
    { key: 'home', label: 'Home' },
    { key: 'restaurants', label: 'Restaurants list' },
    { key: 'dining', label: 'Dining' },
    { key: 'offers', label: 'Offers' },
    { key: 'about', label: 'About us' },
    { key: 'terms', label: 'Terms and conditions' },
    { key: 'privacy', label: 'Privacy policy' },
    { key: 'refund', label: 'Refund policy' },
    { key: 'cancellation', label: 'Cancellation policy' },
    { key: 'shipping', label: 'Shipping policy' },
    { key: 'support', label: 'Support' },
];

const cleanPageMeta = (value) => {
    const pages = obj(obj(value).pages);
    return {
        pages: Object.fromEntries(META_PAGES.map(({ key, label }) => {
            const page = obj(pages[key]);
            return [key, {
                title: str(page.title, 70),
                description: str(page.description, 200),
                keywords: str(page.keywords, 300),
                image: cleanUrl(page.image, `${label} image`),
            }];
        })),
    };
};

// ─── App settings ────────────────────────────────────────────────────────────

export const APPS = [
    { key: 'customer', label: 'Customer app' },
    { key: 'restaurant', label: 'Restaurant app' },
    { key: 'rider', label: 'Rider app' },
];
export const PLATFORMS = [
    { key: 'android', label: 'Android' },
    { key: 'ios', label: 'iOS' },
];

const cleanAppSettings = (value) => {
    const input = obj(value);
    return Object.fromEntries(APPS.map((app) => [app.key, Object.fromEntries(PLATFORMS.map((platform) => {
        const entry = obj(obj(input[app.key])[platform.key]);
        const where = `${app.label} (${platform.label})`;
        const minVersion = cleanVersion(entry.minVersion, `${where} minimum version`);
        const latestVersion = cleanVersion(entry.latestVersion, `${where} latest version`);
        if (minVersion && latestVersion && compareVersions(minVersion, latestVersion) > 0) {
            throw new ValidationError(`${where}: the minimum version cannot be newer than the latest version`);
        }
        return [platform.key, {
            minVersion,
            latestVersion,
            storeUrl: cleanUrl(entry.storeUrl, `${where} store link`),
        }];
    }))]));
};

// ─── Login setup ─────────────────────────────────────────────────────────────

/**
 * Sign-in options per app. `locked` options cannot be switched: phone OTP is
 * the only way customers, restaurants and riders sign in today, so turning it
 * off would lock everyone out. The rest are saved for the apps to read; the
 * backend has no such sign-in yet, which the admin page says.
 */
export const LOGIN_OPTIONS = {
    customer: [
        { key: 'otpLogin', label: 'Phone number with OTP', default: true, locked: true },
        { key: 'googleLogin', label: 'Google sign-in', default: false },
        { key: 'appleLogin', label: 'Apple sign-in', default: false },
    ],
    restaurant: [
        { key: 'otpLogin', label: 'Phone number with OTP', default: true, locked: true },
        { key: 'emailPasswordLogin', label: 'Email and password', default: false },
    ],
    rider: [
        { key: 'otpLogin', label: 'Phone number with OTP', default: true, locked: true },
    ],
};

const cleanLoginSetup = (value) => {
    const input = obj(value);
    return Object.fromEntries(Object.entries(LOGIN_OPTIONS).map(([app, options]) => {
        const saved = obj(input[app]);
        return [app, Object.fromEntries(options.map((option) => [
            option.key,
            option.locked ? option.default : bool(saved[option.key], option.default),
        ]))];
    }));
};

// ─── Landing page ────────────────────────────────────────────────────────────

const list = (value, max, clean) => (Array.isArray(value) ? value : []).slice(0, max).map(clean).filter(Boolean);

const cleanLanding = (value) => {
    const input = obj(value);
    const hero = obj(input.hero);
    const links = obj(input.appLinks);
    const sections = obj(input.sections);
    return {
        hero: {
            title: str(hero.title, 120),
            subtitle: str(hero.subtitle, 300),
            image: cleanUrl(hero.image, 'Hero image'),
        },
        features: list(input.features, 12, (item, index) => {
            const feature = obj(item);
            const title = str(feature.title, 80);
            if (!title) return null;
            return {
                title,
                description: str(feature.description, 300),
                image: cleanUrl(feature.image, `Feature ${index + 1} image`),
            };
        }),
        appLinks: {
            customerAndroid: cleanUrl(links.customerAndroid, 'Customer app Play Store link'),
            customerIos: cleanUrl(links.customerIos, 'Customer app App Store link'),
            restaurantAndroid: cleanUrl(links.restaurantAndroid, 'Restaurant app Play Store link'),
            restaurantIos: cleanUrl(links.restaurantIos, 'Restaurant app App Store link'),
            riderAndroid: cleanUrl(links.riderAndroid, 'Rider app Play Store link'),
            riderIos: cleanUrl(links.riderIos, 'Rider app App Store link'),
        },
        testimonials: list(input.testimonials, 20, (item, index) => {
            const testimonial = obj(item);
            const quote = str(testimonial.quote, 600);
            const name = str(testimonial.name, 80);
            if (!quote || !name) return null;
            const rating = Math.round(Number(testimonial.rating));
            return {
                name,
                role: str(testimonial.role, 80),
                quote,
                image: cleanUrl(testimonial.image, `Testimonial ${index + 1} photo`),
                rating: rating >= 1 && rating <= 5 ? rating : null,
            };
        }),
        sections: {
            showFeatures: bool(sections.showFeatures, true),
            showAppLinks: bool(sections.showAppLinks, true),
            showTestimonials: bool(sections.showTestimonials, true),
        },
    };
};

// ─── Website ─────────────────────────────────────────────────────────────────

const cleanWebsite = (value) => {
    const input = obj(value);
    return {
        siteUrl: cleanUrl(input.siteUrl, 'Website address'),
        maintenanceMode: bool(input.maintenanceMode, false),
        maintenanceMessage: str(input.maintenanceMessage, 500),
    };
};

// ─── Offline payment ─────────────────────────────────────────────────────────

const MAX_OFFLINE_METHODS = 20;
const MAX_PAYMENT_INFO = 10;
const METHOD_ID = /^[a-f0-9]{16}$/;

/**
 * Offline payment methods (bank transfer, UPI, ...): what the customer is
 * shown to pay to (`paymentInfo`), and what they must fill in afterwards so
 * the admin can find the payment (`fields`, e.g. a transaction id). A method
 * keeps its id across edits, because orders record which method they used.
 */
const cleanOfflinePayment = (value) => {
    const input = obj(value);
    const raw = Array.isArray(input.methods) ? input.methods : [];
    if (raw.length > MAX_OFFLINE_METHODS) throw new ValidationError(`At most ${MAX_OFFLINE_METHODS} offline payment methods`);
    const ids = new Set();
    const methods = raw.map((item, index) => {
        const method = obj(item);
        const name = str(method.name, 80);
        if (!name) throw new ValidationError(`Offline payment method ${index + 1} needs a name`);
        let id = METHOD_ID.test(String(method.id || '')) ? String(method.id) : '';
        if (!id || ids.has(id)) id = crypto.randomBytes(8).toString('hex');
        ids.add(id);

        const info = Array.isArray(method.paymentInfo) ? method.paymentInfo : [];
        if (info.length > MAX_PAYMENT_INFO) throw new ValidationError(`"${name}" can show at most ${MAX_PAYMENT_INFO} payment details`);
        const paymentInfo = info
            .map((entry) => ({ label: str(obj(entry).label, 80), value: str(obj(entry).value, 300) }))
            .filter((entry) => entry.label || entry.value);
        for (const entry of paymentInfo) {
            if (!entry.label || !entry.value) throw new ValidationError(`"${name}": every payment detail needs a title and a value`);
        }
        if (!paymentInfo.length) throw new ValidationError(`"${name}": add the details the customer pays to, such as the account number or UPI id`);

        let fields;
        try {
            fields = normalizeMethodFields(method.fields);
        } catch (error) {
            throw new ValidationError(`"${name}": ${error.message}`);
        }
        return { id, name, isActive: bool(method.isActive, true), paymentInfo, fields };
    });
    return { enabled: bool(input.enabled, false), methods };
};

// ─── Analytics scripts ───────────────────────────────────────────────────────

/**
 * Tracking ids for the customer website. Only ids are stored, never script
 * text, and each is checked against its format, so nothing an admin types can
 * end up as code on the site: the website builds the standard snippet itself.
 */
export const ANALYTICS_TOOLS = [
    { key: 'googleAnalytics', label: 'Google Analytics', idLabel: 'Measurement ID', example: 'G-XXXXXXXXXX', pattern: /^G-[A-Z0-9]{4,20}$/ },
    { key: 'googleTagManager', label: 'Google Tag Manager', idLabel: 'Container ID', example: 'GTM-XXXXXXX', pattern: /^GTM-[A-Z0-9]{4,12}$/ },
    { key: 'metaPixel', label: 'Meta Pixel', idLabel: 'Pixel ID', example: '123456789012345', pattern: /^\d{6,20}$/ },
];

const cleanAnalytics = (value) => {
    const input = obj(value);
    return Object.fromEntries(ANALYTICS_TOOLS.map((tool) => {
        const entry = obj(input[tool.key]);
        const id = str(entry.id, 40).toUpperCase();
        const enabled = bool(entry.enabled, false);
        if (id && !tool.pattern.test(id)) throw new ValidationError(`${tool.label} ${tool.idLabel} should look like ${tool.example}`);
        if (enabled && !id) throw new ValidationError(`Enter the ${tool.label} ${tool.idLabel} before switching it on`);
        return [tool.key, { enabled, id }];
    }));
};

/** key -> clean(value). Cleaning `{}` gives the area's defaults. */
export const SETTINGS_AREAS = {
    page_meta: cleanPageMeta,
    app_settings: cleanAppSettings,
    login_setup: cleanLoginSetup,
    notification_channels: (value) => normalizeChannelSettings(value),
    landing_page: cleanLanding,
    website: cleanWebsite,
    push_messages: (value) => normalizePushMessages(value),
    offline_payment: cleanOfflinePayment,
    analytics_scripts: cleanAnalytics,
};

export function cleanSettings(area, value) {
    const clean = SETTINGS_AREAS[area];
    if (!clean) throw new ValidationError('Unknown settings area');
    return clean(value);
}

/**
 * Cleaning stored JSON must not fail a public read because an old document
 * no longer passes a newer rule; the area reads as its defaults instead, and
 * the admin page shows that until it is saved again.
 */
export function readStoredSettings(area, stored) {
    try {
        return cleanSettings(area, stored);
    } catch {
        return cleanSettings(area, {});
    }
}
