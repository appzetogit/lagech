import express from 'express';
import * as ctrl from '../controllers/adminRiderExtras.controller.js';

/**
 * Delivery man admin pages: Add Delivery Man, Vehicles Category, Delivery Man
 * Disbursement, Delivery Man Payments and the Deliveryman Earning Report.
 *
 * Mounted inside admin.routes.js after its permission guard, and before its
 * `/delivery/:id` routes so "vehicle-categories" is never read as a rider id.
 * The path prefixes pick the permission section there: /delivery is delivery
 * management, /withdrawals is transaction management (paying people out is
 * the same authority as approving a withdrawal), /reports is reports.
 */
const router = express.Router();

router.post('/delivery/partners', ctrl.createRider);

router.get('/delivery/vehicle-categories', ctrl.listVehicleCategories);
router.post('/delivery/vehicle-categories', ctrl.createVehicleCategory);
router.patch('/delivery/vehicle-categories/:id', ctrl.updateVehicleCategory);
router.delete('/delivery/vehicle-categories/:id', ctrl.deleteVehicleCategory);

// Generate before :batchId.
router.get('/withdrawals/delivery-disbursements', ctrl.listDisbursements);
router.post('/withdrawals/delivery-disbursements/generate', ctrl.generateDisbursement);
router.get('/withdrawals/delivery-disbursements/:batchId', ctrl.getDisbursement);
router.patch('/withdrawals/delivery-disbursements/:batchId/payouts', ctrl.decideDisbursementPayouts);

router.get('/withdrawals/delivery-payments', ctrl.listPayments);
router.get('/withdrawals/delivery-payments/riders', ctrl.listPayableRiders);
router.post('/withdrawals/delivery-payments', ctrl.recordPayment);

router.get('/reports/deliveryman-earnings', ctrl.getEarningReport);

export default router;
