import { sendResponse, sendError } from '../../../../utils/response.js';
import { isId } from '../../../../utils/helpers.js';
import {
    createWithdrawalRequest,
    listMyWithdrawals,
} from '../services/restaurantWithdrawal.service.js';

export const createWithdrawalRequestController = async (req, res, next) => {
    try {
        const restaurantId = req.user?.userId;
        if (!isId(restaurantId)) return sendError(res, 401, 'Restaurant authentication required');

        const withdrawal = await createWithdrawalRequest(restaurantId, req.body || {});
        return sendResponse(res, 201, 'Withdrawal request submitted successfully', withdrawal);
    } catch (error) {
        next(error);
    }
};

export const listMyWithdrawalsController = async (req, res, next) => {
    try {
        const restaurantId = req.user?.userId;
        if (!isId(restaurantId)) return sendError(res, 401, 'Restaurant authentication required');

        const withdrawals = await listMyWithdrawals(restaurantId);
        return sendResponse(res, 200, 'Withdrawals fetched successfully', withdrawals);
    } catch (error) {
        next(error);
    }
};
