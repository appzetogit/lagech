import { prisma } from '../../../../config/prisma.js';
import { makeBannerService } from './bannerService.factory.js';

const banners = makeBannerService(prisma.foodDiningBanner, 'food/dining-banners', (meta) => ({
    diningType: meta.diningType,
}));

export const listDiningBanners = banners.list;
export const createDiningBannersFromFiles = banners.createFromFiles;
export const deleteDiningBanner = banners.remove;
export const updateDiningBannerOrder = banners.setOrder;
export const toggleDiningBannerStatus = banners.setActive;
