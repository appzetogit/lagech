import { sendResponse } from '../../../../utils/response.js';
import * as reports from '../services/adminOrderMoneyReport.service.js';

/**
 * The per-order money report (Transaction / Order report) and the
 * restaurant-wise report, plus their server-side CSV / Excel exports.
 */

const handle = (message, run) => async (req, res, next) => {
    try {
        return sendResponse(res, 200, message, await run(req));
    } catch (error) {
        return next(error);
    }
};

/** Exports stream; an error after the first byte can only end the response. */
const stream = (run) => async (req, res, next) => {
    try {
        await run(req.query || {}, res);
    } catch (error) {
        if (!res.headersSent) return next(error);
        res.destroy(error);
    }
    return undefined;
};

export const getOrderMoneyReport = handle('Order money report fetched', (req) => reports.getOrderMoneyReport(req.query || {}));
export const exportOrderMoneyReport = stream(reports.exportOrderMoneyReport);
export const getRestaurantWiseReport = handle('Restaurant-wise report fetched', (req) => reports.getRestaurantWiseReport(req.query || {}));
export const exportRestaurantWiseReport = stream(reports.exportRestaurantWiseReport);
