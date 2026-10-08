import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { ValidationError } from '../../../../core/auth/errors.js';
import { saveImageFile, deleteStoredFile } from '../../../../services/storage.service.js';
import { makeBannerService } from './bannerService.factory.js';

const banners = makeBannerService(prisma.foodHeroBanner, 'food/hero-banners', (meta) => ({
    linkedRestaurantIds: meta.linkedRestaurantIds || [],
    // The bulk uploader has no picker: a banner it makes is a picture or a link.
    bannerType: (meta.linkedRestaurantIds || []).length ? 'restaurant' : 'link',
}));

export const createHeroBannersFromFiles = banners.createFromFiles;
export const deleteHeroBanner = banners.remove;
export const updateHeroBannerOrder = banners.setOrder;
export const toggleHeroBannerStatus = banners.setActive;

export const HERO_BANNER_TYPES = ['restaurant', 'food', 'link'];
const FOLDER = 'food/hero-banners';
const byOrder = [{ sortOrder: 'asc' }, { createdAt: 'desc' }];

const toFlag = (value) => value === true || value === 'true' || value === 1 || value === '1';
const clean = (value) => {
    const text = String(value ?? '').trim();
    return text || null;
};

/**
 * The admin list, with the names the table shows: zone, restaurant, dish.
 * Every field the old list returned is still there.
 */
export async function listHeroBanners() {
    const rows = await prisma.foodHeroBanner.findMany({
        orderBy: byOrder,
        include: { zone: { select: { id: true, name: true } } },
    });

    const restaurantIds = [...new Set(rows.flatMap((b) => b.linkedRestaurantIds || []).filter(isId))];
    const foodIds = [...new Set(rows.map((b) => b.linkedFoodId).filter(isId))];
    const [restaurants, foods] = await Promise.all([
        restaurantIds.length
            ? prisma.foodRestaurant.findMany({ where: { id: { in: restaurantIds } }, select: { id: true, restaurantName: true } })
            : [],
        foodIds.length
            ? prisma.foodItem.findMany({ where: { id: { in: foodIds } }, select: { id: true, name: true, restaurantId: true } })
            : [],
    ]);
    const restaurantName = new Map(restaurants.map((r) => [r.id, r.restaurantName]));
    const foodById = new Map(foods.map((f) => [f.id, f]));

    return rows.map(({ zone, ...banner }) => ({
        ...banner,
        zoneName: zone?.name || null,
        linkedRestaurantNames: (banner.linkedRestaurantIds || []).map((id) => restaurantName.get(id)).filter(Boolean),
        linkedFood: banner.linkedFoodId && foodById.get(banner.linkedFoodId)
            ? { id: banner.linkedFoodId, name: foodById.get(banner.linkedFoodId).name, restaurantId: foodById.get(banner.linkedFoodId).restaurantId }
            : null,
    }));
}

/**
 * Validate the form into columns. `existing` is the row being edited, so a
 * partial update keeps what it does not mention.
 */
async function buildBannerData(body = {}, existing = null) {
    const pick = (key, fallback) => (body[key] !== undefined ? body[key] : fallback);
    const bannerType = String(pick('bannerType', existing?.bannerType || 'restaurant')).trim();
    if (!HERO_BANNER_TYPES.includes(bannerType)) {
        throw new ValidationError('Banner type must be restaurant, food or link');
    }

    const zoneRaw = pick('zoneId', existing?.zoneId ?? null);
    const zoneId = zoneRaw && zoneRaw !== 'null' && zoneRaw !== 'all' ? String(zoneRaw) : null;
    if (zoneId) {
        if (!isId(zoneId) || !(await prisma.foodZone.count({ where: { id: zoneId } }))) {
            throw new ValidationError('The selected zone does not exist');
        }
    }

    let linkedRestaurantIds = [];
    let linkedFoodId = null;
    if (bannerType === 'restaurant') {
        let ids = pick('linkedRestaurantIds', undefined);
        if (ids === undefined && body.restaurantId !== undefined) ids = [body.restaurantId];
        if (ids === undefined) ids = existing?.linkedRestaurantIds || [];
        if (typeof ids === 'string') {
            try { ids = JSON.parse(ids); } catch { ids = ids.split(','); }
        }
        linkedRestaurantIds = [...new Set((Array.isArray(ids) ? ids : [ids]).map((v) => String(v || '').trim()).filter(isId))];
        if (!linkedRestaurantIds.length) throw new ValidationError('Select the restaurant this banner opens');
        const found = await prisma.foodRestaurant.count({ where: { id: { in: linkedRestaurantIds } } });
        if (found !== linkedRestaurantIds.length) throw new ValidationError('The selected restaurant does not exist');
    } else if (bannerType === 'food') {
        linkedFoodId = clean(pick('linkedFoodId', pick('foodId', existing?.linkedFoodId)));
        if (!isId(linkedFoodId)) throw new ValidationError('Select the dish this banner opens');
        if (!(await prisma.foodItem.count({ where: { id: linkedFoodId } }))) {
            throw new ValidationError('The selected dish does not exist');
        }
    }

    const ctaLink = clean(pick('ctaLink', existing?.ctaLink));
    if (bannerType === 'link' && ctaLink && !/^https?:\/\//i.test(ctaLink)) {
        throw new ValidationError('The link must start with http:// or https://');
    }

    return {
        title: clean(pick('title', existing?.title)),
        ctaText: clean(pick('ctaText', existing?.ctaText)),
        ctaLink,
        bannerType,
        zoneId,
        linkedRestaurantIds,
        linkedFoodId,
        isFeatured: toFlag(pick('isFeatured', existing?.isFeatured ?? false)),
        ...(body.isActive !== undefined ? { isActive: toFlag(body.isActive) } : {}),
        ...(body.sortOrder !== undefined ? { sortOrder: Number(body.sortOrder) || 0 } : {}),
    };
}

/** One banner from the Banners form: image plus its zone, type and target. */
export async function createHeroBanner(file, body = {}) {
    if (!file) throw new ValidationError('Banner image is required');
    const data = await buildBannerData(body);
    const saved = await saveImageFile(file, FOLDER);
    try {
        return await prisma.foodHeroBanner.create({
            data: { ...data, imageUrl: saved.url, publicId: saved.path, isActive: data.isActive ?? true },
        });
    } catch (error) {
        await deleteStoredFile(saved.path).catch(() => {});
        throw error;
    }
}

/** Edit; a new image replaces the old file once the row is saved. */
export async function updateHeroBanner(id, file, body = {}) {
    if (!isId(id)) return null;
    const existing = await prisma.foodHeroBanner.findUnique({ where: { id: String(id) } });
    if (!existing) return null;

    const data = await buildBannerData(body, existing);
    const saved = file ? await saveImageFile(file, FOLDER) : null;
    const updated = await prisma.foodHeroBanner.update({
        where: { id: existing.id },
        data: { ...data, ...(saved ? { imageUrl: saved.url, publicId: saved.path } : {}) },
    });
    if (saved && existing.publicId) await deleteStoredFile(existing.publicId).catch(() => {});
    return updated;
}

export async function setHeroBannerFeatured(id, isFeatured) {
    if (!isId(id)) return null;
    const { count } = await prisma.foodHeroBanner.updateMany({
        where: { id: String(id) },
        data: { isFeatured: Boolean(isFeatured) },
    });
    return count ? prisma.foodHeroBanner.findUnique({ where: { id: String(id) } }) : null;
}

/**
 * The customer's home banners for a zone: banners for every zone plus that
 * zone's own. No zone known means every banner, as before zones existed.
 */
export async function listPublicHeroBanners({ zoneId = null, featured = false } = {}) {
    return prisma.foodHeroBanner.findMany({
        where: {
            isActive: true,
            ...(zoneId ? { OR: [{ zoneId: null }, { zoneId: String(zoneId) }] } : {}),
            ...(featured ? { isFeatured: true } : {}),
        },
        orderBy: byOrder,
    });
}
