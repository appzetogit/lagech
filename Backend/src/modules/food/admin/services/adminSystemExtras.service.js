import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { ValidationError, NotFoundError } from '../../../../core/auth/errors.js';
import { invalidateChannelSettings, NOTIFICATION_EVENTS } from '../../../../core/notifications/notificationChannels.js';
import {
    SETTINGS_AREAS,
    META_PAGES,
    APPS,
    PLATFORMS,
    LOGIN_OPTIONS,
    cleanSettings,
    readStoredSettings,
    cleanUrl,
} from './systemSettings.defaults.js';

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
    const [apps, login] = await Promise.all([readArea('app_settings'), readArea('login_setup')]);
    return { apps: apps.value, login: login.value, updatedAt: apps.updatedAt };
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
