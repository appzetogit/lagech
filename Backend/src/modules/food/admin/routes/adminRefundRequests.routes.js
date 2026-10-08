import express from 'express';
import { sendResponse } from '../../../../utils/response.js';
import {
    approveRefundRequest,
    getRefundRequestAdmin,
    listRefundRequestsAdmin,
    rejectRefundRequest,
} from '../../orders/services/refundRequest.service.js';

/**
 * Customer refund requests (Order Refunds > Refund Requests).
 *
 * Mounted from admin.routes.js after its admin and permission middleware, and
 * before /orders/:orderId. Every path is under /orders, so order_management
 * applies: view to list, edit (PATCH) to approve or reject.
 */
const router = express.Router();

const handle = (message, fn) => async (req, res, next) => {
    try {
        return sendResponse(res, 200, message, await fn(req));
    } catch (error) {
        return next(error);
    }
};

router.get('/orders/refund-requests', handle('Refund requests', (req) => listRefundRequestsAdmin(req.query || {})));
router.get('/orders/refund-requests/:id', handle('Refund request', (req) => getRefundRequestAdmin(req.params.id)));
router.patch('/orders/refund-requests/:id/approve', handle('Refund approved', async (req) => ({
    request: await approveRefundRequest(req.params.id, req.user?.userId, req.body || {}),
})));
router.patch('/orders/refund-requests/:id/reject', handle('Refund request rejected', async (req) => ({
    request: await rejectRefundRequest(req.params.id, req.user?.userId, req.body || {}),
})));

export default router;
