import { sendError, sendResponse } from '../../../../utils/response.js';
import { isId } from '../../../../utils/helpers.js';
import { listOwnRestaurantReviews, replyToRestaurantReview } from '../services/restaurantReviews.service.js';

export const listOwnReviewsController = async (req, res, next) => {
    try {
        const restaurantId = req.user?.userId;
        if (!isId(restaurantId)) return sendError(res, 401, 'Unauthorized');
        const data = await listOwnRestaurantReviews(restaurantId, req.query || {});
        return sendResponse(res, 200, 'Reviews fetched successfully', data);
    } catch (error) {
        next(error);
    }
};

export const replyToReviewController = async (req, res, next) => {
    try {
        const restaurantId = req.user?.userId;
        if (!isId(restaurantId)) return sendError(res, 401, 'Unauthorized');
        const data = await replyToRestaurantReview(restaurantId, req.params.orderId, req.body || {});
        return sendResponse(res, 200, data.reply ? 'Reply saved' : 'Reply removed', data);
    } catch (error) {
        next(error);
    }
};
