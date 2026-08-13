import { prisma } from '../../../../config/prisma.js';
import { makeBannerService } from './bannerService.factory.js';

const banners = makeBannerService(prisma.foodHeroBanner, 'food/hero-banners', (meta) => ({
    linkedRestaurantIds: meta.linkedRestaurantIds || [],
}));

export const listHeroBanners = banners.list;
export const createHeroBannersFromFiles = banners.createFromFiles;
export const deleteHeroBanner = banners.remove;
export const updateHeroBannerOrder = banners.setOrder;
export const toggleHeroBannerStatus = banners.setActive;
