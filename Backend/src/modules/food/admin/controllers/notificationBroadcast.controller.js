import { sendResponse, sendError } from '../../../../utils/response.js';
import {
    createBroadcastNotification,
    getBroadcastNotifications,
    deleteBroadcastNotification,
    getLapsedCustomers
} from '../services/notificationBroadcast.service.js';

export const createBroadcastNotificationController = async (req, res) => {
    try {
        const data = await createBroadcastNotification({
            body: req.body,
            adminId: req.user?.userId
        });
        return sendResponse(res, 201, 'Broadcast notification created successfully', data);
    } catch (error) {
        return sendError(res, error.statusCode || 500, error.message || 'Failed to create broadcast notification');
    }
};

export const getBroadcastNotificationsController = async (req, res) => {
    try {
        const data = await getBroadcastNotifications({
            page: req.query?.page,
            limit: req.query?.limit
        });
        return sendResponse(res, 200, 'Broadcast notifications fetched successfully', data);
    } catch (error) {
        return sendError(res, error.statusCode || 500, error.message || 'Failed to fetch broadcast notifications');
    }
};

export const deleteBroadcastNotificationController = async (req, res) => {
    try {
        const data = await deleteBroadcastNotification(req.params?.id);
        return sendResponse(res, 200, 'Broadcast notification deleted successfully', data);
    } catch (error) {
        return sendError(res, error.statusCode || 500, error.message || 'Failed to delete broadcast notification');
    }
};

/**
 * Who a win-back campaign would reach, before one is sent.
 *
 * The same query the LAPSED broadcast resolves at send time, exposed on its
 * own so an admin can see the list -- and how much of it can actually receive
 * a push -- rather than finding out by messaging real customers.
 */
export const getLapsedCustomersController = async (req, res) => {
    try {
        const data = await getLapsedCustomers({
            days: req.query?.days,
            includeNeverOrdered: String(req.query?.includeNeverOrdered || '') === 'true',
            limit: req.query?.limit,
        });
        return sendResponse(res, 200, 'Lapsed customers fetched', data);
    } catch (error) {
        return sendError(res, error.statusCode || 500, error.message || 'Failed to fetch lapsed customers');
    }
};
