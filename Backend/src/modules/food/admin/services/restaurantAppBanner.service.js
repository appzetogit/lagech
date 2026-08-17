import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { ValidationError } from '../../../../core/auth/errors.js';
import { uploadImageBuffer } from '../../../../services/cloudinary.service.js';

/** Design dimensions — single source of truth for both the admin UI and the app. */
export const RESTAURANT_APP_BANNER_SIZE = { width: 350, height: 100 };

const ORDER = [{ sortOrder: 'asc' }, { createdAt: 'desc' }];

const serialize = (b) => ({
    id: b.id,
    imageUrl: b.imageUrl,
    title: b.title || '',
    ctaLink: b.ctaLink || '',
    sortOrder: b.sortOrder,
    isActive: b.isActive,
    createdAt: b.createdAt,
    updatedAt: b.updatedAt,
});

const assertId = (id) => {
    if (!isId(id)) throw new ValidationError('Invalid banner id');
};

// The admin form posts multipart, so booleans arrive as the strings 'true' and
// 'false'. Anything that is not an explicit false means visible.
const toActive = (value) => !(value === false || value === 'false');

/** Admin: every banner, active or not. */
export const listBannersAdmin = async () => {
    const banners = await prisma.foodRestaurantAppBanner.findMany({ orderBy: ORDER });
    return {
        banners: banners.map(serialize),
        recommendedSize: RESTAURANT_APP_BANNER_SIZE,
    };
};

/** Restaurant app: active banners only, in display order. */
export const listBannersForRestaurantApp = async () => {
    const banners = await prisma.foodRestaurantAppBanner.findMany({
        where: { isActive: true },
        orderBy: ORDER,
    });
    return {
        banners: banners.map(serialize),
        recommendedSize: RESTAURANT_APP_BANNER_SIZE,
        aspectRatio: Number(
            (RESTAURANT_APP_BANNER_SIZE.width / RESTAURANT_APP_BANNER_SIZE.height).toFixed(2)
        ),
    };
};

export const createBanner = async (file, body = {}) => {
    if (!file?.buffer) throw new ValidationError('Banner image file is required');

    const imageUrl = await uploadImageBuffer(file.buffer, 'food/restaurant-app-banners');
    if (!imageUrl) throw new ValidationError('Image upload failed');

    // Append to the end unless an explicit position was given.
    const last = await prisma.foodRestaurantAppBanner.findFirst({
        orderBy: { sortOrder: 'desc' },
        select: { sortOrder: true },
    });

    const banner = await prisma.foodRestaurantAppBanner.create({
        data: {
            imageUrl,
            title: String(body.title || '').trim(),
            ctaLink: String(body.ctaLink || '').trim(),
            sortOrder: body.sortOrder !== undefined
                ? Number(body.sortOrder) || 0
                : (last?.sortOrder || 0) + 1,
            isActive: body.isActive === undefined ? true : toActive(body.isActive),
        },
    });
    return serialize(banner);
};

export const updateBanner = async (id, body = {}, file = null) => {
    assertId(id);

    const data = {};
    if (file?.buffer) {
        const imageUrl = await uploadImageBuffer(file.buffer, 'food/restaurant-app-banners');
        // A failed upload leaves the existing image alone rather than blanking it.
        if (imageUrl) data.imageUrl = imageUrl;
    }
    if (body.title !== undefined) data.title = String(body.title || '').trim();
    if (body.ctaLink !== undefined) data.ctaLink = String(body.ctaLink || '').trim();
    if (body.sortOrder !== undefined) data.sortOrder = Number(body.sortOrder) || 0;
    if (body.isActive !== undefined) data.isActive = toActive(body.isActive);

    const banner = await prisma.foodRestaurantAppBanner
        .update({ where: { id }, data })
        .catch(() => null);
    if (!banner) throw new ValidationError('Banner not found');
    return serialize(banner);
};

export const deleteBanner = async (id) => {
    assertId(id);
    const { count } = await prisma.foodRestaurantAppBanner.deleteMany({ where: { id } });
    if (!count) throw new ValidationError('Banner not found');
    return { deleted: true, id };
};

/** Toggle visibility without deleting the asset. */
export const toggleBannerStatus = async (id, isActive) => {
    assertId(id);
    const banner = await prisma.foodRestaurantAppBanner
        .update({ where: { id }, data: { isActive: toActive(isActive) } })
        .catch(() => null);
    if (!banner) throw new ValidationError('Banner not found');
    return serialize(banner);
};

/** Reorder by id list; index in the array becomes sortOrder. */
export const reorderBanners = async (ids) => {
    const list = Array.isArray(ids) ? ids.map(String) : [];
    if (list.length === 0) throw new ValidationError('banners must be a non-empty array of ids');
    list.forEach(assertId);

    // One transaction: a half-applied reorder would leave duplicate positions.
    await prisma.$transaction(
        list.map((id, index) =>
            prisma.foodRestaurantAppBanner.updateMany({ where: { id }, data: { sortOrder: index } })
        )
    );
    return listBannersAdmin();
};
