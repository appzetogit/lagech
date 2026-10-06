import { sendResponse } from '../../../../utils/response.js';
import { convertLoyaltyPoints, getMyLoyaltyPoints } from '../services/loyaltyPoint.service.js';
import { listRunningWalletBonuses } from '../services/walletBonus.service.js';
import { subscribeToNewsletter } from '../services/newsletter.service.js';

/** GET /v1/food/user/loyalty-points */
export const getMyLoyaltyPointsController = async (req, res, next) => {
    try {
        const data = await getMyLoyaltyPoints(req.user?.userId, req.query || {});
        return sendResponse(res, 200, 'Loyalty points fetched', data);
    } catch (error) {
        next(error);
    }
};

/** POST /v1/food/user/loyalty-points/convert */
export const convertLoyaltyPointsController = async (req, res, next) => {
    try {
        const data = await convertLoyaltyPoints(req.user?.userId, req.body || {});
        return sendResponse(res, 200, 'Points converted to wallet balance', data);
    } catch (error) {
        next(error);
    }
};

/** GET /v1/food/user/wallet/bonuses */
export const listWalletBonusesController = async (_req, res, next) => {
    try {
        const bonuses = await listRunningWalletBonuses();
        return sendResponse(res, 200, 'Wallet bonuses fetched', { bonuses });
    } catch (error) {
        next(error);
    }
};

/** POST /v1/food/public/newsletter/subscribe (no login) */
export const subscribeNewsletterController = async (req, res, next) => {
    try {
        const data = await subscribeToNewsletter(req.body?.email);
        return sendResponse(res, 200, 'Subscribed', data);
    } catch (error) {
        next(error);
    }
};
