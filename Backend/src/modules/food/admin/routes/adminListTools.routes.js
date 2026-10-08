import express from 'express';
import { streamAdminOrdersExport } from '../../orders/services/adminOrderExport.service.js';
import { approveAllPendingRestaurants, setRestaurantFeatured } from '../services/adminListTools.service.js';

/**
 * List tools carried over from the previous admin panel: the order lists'
 * server-side Export, and the restaurant list's Featured toggle and Verify all.
 *
 * Mounted by admin.routes.js before its own routes (so "/orders/export" is not
 * read as an order id), and after its permission guard: /orders/export is
 * order management (view), /restaurants/... restaurant management.
 */
const router = express.Router();

const handle = (fn, message = 'OK') => async (req, res, next) => {
    try {
        res.status(200).json({ success: true, message, data: await fn(req) });
    } catch (error) {
        next(error);
    }
};

router.get('/orders/export', async (req, res, next) => {
    try {
        res.setHeader('Cache-Control', 'no-store');
        await streamAdminOrdersExport(req.query || {}, res);
    } catch (error) {
        // Once rows are on the wire the status is sent; just cut the file.
        if (res.headersSent) res.destroy(error);
        else next(error);
    }
});

router.patch(
    '/restaurants/:id/featured',
    handle((req) => setRestaurantFeatured(req.params.id, req.body?.isFeatured), 'Featured updated'),
);
router.post('/restaurants/approve-pending', handle(() => approveAllPendingRestaurants(), 'Pending restaurants approved'));

export default router;
