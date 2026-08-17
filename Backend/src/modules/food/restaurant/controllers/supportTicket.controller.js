import { sendError, sendResponse } from '../../../../utils/response.js';
import { isId } from '../../../../utils/helpers.js';
import {
    createRestaurantSupportTicket,
    listRestaurantSupportTickets,
} from '../services/restaurantSupportTicket.service.js';

export const createRestaurantSupportTicketController = async (req, res, next) => {
    try {
        const restaurantId = req.user?.userId;
        if (!isId(restaurantId)) return sendError(res, 401, 'Unauthorized');

        const ticket = await createRestaurantSupportTicket(restaurantId, req.body || {});
        return sendResponse(res, 201, 'Support ticket created successfully', { ticket });
    } catch (error) {
        next(error);
    }
};

export const listRestaurantSupportTicketsController = async (req, res, next) => {
    try {
        const restaurantId = req.user?.userId;
        if (!isId(restaurantId)) return sendError(res, 401, 'Unauthorized');

        const data = await listRestaurantSupportTickets(restaurantId, req.query || {});
        return sendResponse(res, 200, 'Support tickets fetched successfully', data);
    } catch (error) {
        next(error);
    }
};
