import express from 'express';

import { requireRoles } from '../roles/role.middleware.js';
import {
    getPaymentHistoryController,
    getOrderTransactionsController,
    getUserWalletBalanceController,
    getUserWalletTransactionsController,
    getRestaurantWalletController,
    getDeliveryWalletController,
    getAdminWalletController,
    getAdminFinanceSummaryController,
    listSettlementsController,
    createSettlementController,
    processSettlementController,
    listRefundsController,
    getRefundsByOrderController
} from './payment.controller.js';

/**
 * Mounted under /v1/food/payments behind authMiddleware alone. Every route
 * here therefore states which role it is for; the mount cannot, because the
 * router serves customers, restaurants, riders and admins from one path.
 *
 * It used to state nothing. Any signed-in customer could create and process
 * settlements — debit a restaurant's wallet and mark it paid out — read the
 * platform's finance summary, and read any restaurant's or rider's wallet by
 * putting its id in the URL.
 */
const router = express.Router();

const admin = requireRoles('ADMIN');

// ─── Payment history for an order. The controller checks the order is theirs. ───
router.get('/orders/:orderId/payments', requireRoles('USER', 'ADMIN'), getPaymentHistoryController);
router.get('/orders/:orderId/transactions', requireRoles('USER', 'ADMIN'), getOrderTransactionsController);
router.get('/orders/:orderId/refunds', requireRoles('USER', 'ADMIN'), getRefundsByOrderController);

// ─── The customer's own wallet ───
router.get('/wallet/balance', requireRoles('USER'), getUserWalletBalanceController);
router.get('/wallet/transactions', requireRoles('USER'), getUserWalletTransactionsController);

// ─── A restaurant's wallet: its own, or any for an admin. The controller scopes it. ───
router.get('/restaurant/:restaurantId/wallet', requireRoles('RESTAURANT', 'ADMIN'), getRestaurantWalletController);

// ─── A rider's wallet, likewise ───
router.get('/delivery/:deliveryPartnerId/wallet', requireRoles('DELIVERY_PARTNER', 'ADMIN'), getDeliveryWalletController);

// ─── Admin / Finance ───
router.get('/admin/wallet', admin, getAdminWalletController);
router.get('/admin/finance/summary', admin, getAdminFinanceSummaryController);
router.get('/admin/settlements', admin, listSettlementsController);
router.post('/admin/settlements', admin, createSettlementController);
router.post('/admin/settlements/:id/process', admin, processSettlementController);
router.get('/admin/refunds', admin, listRefundsController);

export default router;
