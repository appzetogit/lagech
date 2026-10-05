import express from 'express';
import * as extras from '../controllers/adminCustomerExtras.controller.js';

/**
 * Customer wallet, loyalty points, newsletter list and user overview.
 *
 * Mounted from admin.routes.js after its permission middleware, which maps
 * every path here to customer_management (view for GET, create/edit/delete for
 * the writes), so nothing here needs its own guard.
 */
const router = express.Router();

router.get('/customer-wallet/customers', extras.searchCustomers);
router.post('/customer-wallet/add-fund', extras.addFund);
router.get('/customer-wallet/transactions', extras.listWalletTransactions);
router.get('/customer-wallet/bonuses', extras.listWalletBonuses);
router.post('/customer-wallet/bonuses', extras.createWalletBonus);
router.patch('/customer-wallet/bonuses/:id', extras.updateWalletBonus);
router.delete('/customer-wallet/bonuses/:id', extras.deleteWalletBonus);

router.get('/loyalty-points/settings', extras.getLoyaltySettings);
router.put('/loyalty-points/settings', extras.saveLoyaltySettings);
router.get('/loyalty-points/transactions', extras.listLoyaltyTransactions);

router.get('/newsletter-subscribers', extras.listSubscribers);
router.get('/newsletter-subscribers/export', extras.exportSubscribers);
router.delete('/newsletter-subscribers/:id', extras.deleteSubscriber);

router.get('/user-overview', extras.getUserOverview);

export default router;
