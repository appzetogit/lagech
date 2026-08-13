import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { makeBannerService } from './bannerService.factory.js';

const banners = makeBannerService(prisma.foodUnder250Banner, 'food/under-250-banners', (meta) => ({
    // zoneId is a real column with a length limit now, so a stray '' or 'null'
    // from a multipart form has to become NULL rather than be stored.
    zoneId: isId(meta.zoneId) ? String(meta.zoneId) : null,
}));

export const listUnder250Banners = banners.list;
export const createUnder250BannersFromFiles = banners.createFromFiles;
export const deleteUnder250Banner = banners.remove;
export const updateUnder250BannerOrder = banners.setOrder;
export const toggleUnder250BannerStatus = banners.setActive;
