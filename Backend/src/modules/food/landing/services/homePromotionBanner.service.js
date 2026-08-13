import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { saveImageFile } from '../../../../services/storage.service.js';
import { makeBannerService } from './bannerService.factory.js';

const BANNER_FOLDER = 'food/home-promotion-banners';
const banners = makeBannerService(prisma.homePromotionBanner, BANNER_FOLDER);

/** '' and undefined both mean "no bound"; anything else is a date. */
const toDate = (value) => (value && value !== '' ? new Date(value) : null);

const byOrder = [{ sortOrder: 'asc' }, { createdAt: 'desc' }];

export const listHomePromotionBanners = () =>
    prisma.homePromotionBanner.findMany({ orderBy: byOrder });

export const getPublicHomePromotionBanners = async (zoneId = null) => {
    const now = new Date();
    return prisma.homePromotionBanner.findMany({
        where: {
            isActive: true,
            // An open-ended window is the common case: most banners set neither
            // date and must still show. The Mongo filter also had to match
            // startDate: "" — a string sitting in a date field. The column is
            // typed now, so that case cannot exist.
            AND: [
                { OR: [{ startDate: null }, { startDate: { lte: now } }] },
                { OR: [{ endDate: null }, { endDate: { gte: now } }] },
            ],
            ...(isId(zoneId) ? { zoneId: String(zoneId) } : {}),
        },
        orderBy: byOrder,
    });
};

export const createHomePromotionBanner = async (file, meta = {}) => {
    if (!file) return null;

    try {
        const saved = await saveImageFile(file, BANNER_FOLDER);
        return await prisma.homePromotionBanner.create({
            data: {
                imageUrl: saved.url,
                publicId: saved.path,
                title: meta.title,
                ctaLink: meta.ctaLink,
                zoneId: isId(meta.zoneId) ? String(meta.zoneId) : null,
                startDate: toDate(meta.startDate),
                endDate: toDate(meta.endDate),
                sortOrder: Number(meta.sortOrder) || 0,
                isActive: true,
            },
        });
    } catch (error) {
        throw new Error(`Banner creation failed: ${error.message}`);
    }
};

export const updateHomePromotionBanner = async (id, data = {}) => {
    const { startDate, endDate, zoneId, ...rest } = data;
    const updates = { ...rest };

    // Only touch a field the caller actually sent — a PATCH that changes the
    // title must not clear the schedule.
    if (startDate !== undefined) updates.startDate = toDate(startDate);
    if (endDate !== undefined) updates.endDate = toDate(endDate);
    if (zoneId !== undefined) updates.zoneId = isId(zoneId) ? String(zoneId) : null;

    return prisma.homePromotionBanner
        .update({ where: { id }, data: updates })
        .catch((error) => {
            if (error?.code === 'P2025') return null;
            throw error;
        });
};

export const deleteHomePromotionBanner = banners.remove;
export const toggleHomePromotionBannerStatus = banners.setActive;
export const updateHomePromotionBannerOrder = banners.setOrder;
