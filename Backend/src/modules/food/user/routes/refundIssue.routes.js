import express from 'express';
import { upload } from '../../../../middleware/upload.js';
import { sendResponse } from '../../../../utils/response.js';
import {
    createRefundRequest,
    getOrderRefundStatus,
    listMyRefundRequests,
} from '../../orders/services/refundRequest.service.js';
import { createOrderIssue, listMyOrderIssues } from '../services/orderIssue.service.js';

/**
 * Refund requests and order issue reports (Bearer USER), mounted inside
 * user.routes.js at /v1/food/user. Photos are multipart field `images`
 * (up to 3); a JSON body without photos works too.
 */
const router = express.Router();

const handle = (status, message, fn) => async (req, res, next) => {
    try {
        return sendResponse(res, status, message, await fn(req));
    } catch (error) {
        return next(error);
    }
};

const photos = upload.array('images', 3);

router.get('/orders/:orderId/refund-request', handle(200, 'Refund status', (req) =>
    getOrderRefundStatus(req.user?.userId, req.params.orderId)));
router.post('/orders/:orderId/refund-request', photos, handle(201, 'Refund request sent', async (req) => ({
    request: await createRefundRequest(req.user?.userId, req.params.orderId, req.body || {}, req.files),
})));
router.get('/refund-requests', handle(200, 'Refund requests', (req) =>
    listMyRefundRequests(req.user?.userId, req.query || {})));

router.post('/orders/:orderId/issues', photos, handle(201, 'Issue reported', async (req) => ({
    issue: await createOrderIssue(req.user?.userId, req.params.orderId, req.body || {}, req.files),
})));
router.get('/orders/:orderId/issues', handle(200, 'Order issues', (req) =>
    listMyOrderIssues(req.user?.userId, { ...(req.query || {}), orderRef: req.params.orderId })));
router.get('/order-issues', handle(200, 'Order issues', (req) =>
    listMyOrderIssues(req.user?.userId, { page: req.query?.page, limit: req.query?.limit })));

export default router;
