import * as promotions from './promotions.service.js';

/** One JSON handler shape for every promotions endpoint. */
const handle = (fn, { status = 200, message = 'OK' } = {}) => async (req, res, next) => {
    try {
        res.status(status).json({ success: true, message, data: await fn(req) });
    } catch (error) {
        next(error);
    }
};

// Admin: advertisements
export const listAdsAdmin = handle((req) => promotions.listAdsAdmin(req.query || {}));
export const createAdAdmin = handle(async (req) => ({ ad: await promotions.createAdAdmin(req.body || {}) }), { status: 201, message: 'Advertisement created' });
export const updateAdAdmin = handle(async (req) => ({ ad: await promotions.updateAdAdmin(req.params.id, req.body || {}) }), { message: 'Advertisement saved' });
export const decideAd = handle(async (req) => ({ ad: await promotions.decideAd(req.params.id, req.body || {}) }), { message: 'Advertisement updated' });
export const deleteAd = handle((req) => promotions.deleteAd(req.params.id), { message: 'Advertisement deleted' });

// Admin: reels
export const listReelsAdmin = handle(async () => ({ reels: await promotions.listReelsAdmin() }));
export const createReel = handle(async (req) => ({ reel: await promotions.createReel(req.body || {}) }), { status: 201, message: 'Reel added' });
export const updateReel = handle(async (req) => ({ reel: await promotions.updateReel(req.params.id, req.body || {}) }), { message: 'Reel saved' });
export const deleteReel = handle((req) => promotions.deleteReel(req.params.id), { message: 'Reel deleted' });

// Restaurant: its own ad requests (the restaurant's id is its user id)
export const listMyAds = handle(async (req) => ({ ads: await promotions.listAdsForRestaurant(req.user.userId) }));
export const requestAd = handle(async (req) => ({ ad: await promotions.requestAd(req.user.userId, req.body || {}) }), { status: 201, message: 'Request sent for approval' });
export const withdrawAdRequest = handle((req) => promotions.withdrawAdRequest(req.user.userId, req.params.id), { message: 'Request withdrawn' });

// Public (customer apps)
export const listRunningAds = handle(async () => ({ ads: await promotions.listRunningAds() }));
export const listShowingReels = handle(async () => ({ reels: await promotions.listShowingReels() }));
export const countReelEvent = handle((req) => promotions.countReelEvent(req.params.id, req.params.event));
