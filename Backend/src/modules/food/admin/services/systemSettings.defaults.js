import { ValidationError } from '../../../../core/auth/errors.js';
import { normalizeChannelSettings } from '../../../../core/notifications/notificationChannels.js';

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

/** key -> clean(value). Cleaning `{}` gives the area's defaults. */
export const SETTINGS_AREAS = {
    page_meta: cleanPageMeta,
    app_settings: cleanAppSettings,
    login_setup: cleanLoginSetup,
    notification_channels: (value) => normalizeChannelSettings(value),
    landing_page: cleanLanding,
    website: cleanWebsite,
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
