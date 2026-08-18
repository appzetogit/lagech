import { prisma } from '../../config/prisma.js';
import { sendResponse } from '../../utils/response.js';
import { getPaymentsByOrder } from './payment.service.js';
import { getTransactionsByOrder } from './transaction.service.js';
import { getWalletBalance, getWalletWithTransactions, getUserWalletForFrontend } from './wallet.service.js';
import { getRefundsByOrder, listRefunds } from './refund.service.js';
import { createSettlement, processSettlement, listSettlements } from './settlement.service.js';
import { logger } from '../../utils/logger.js';
import { ForbiddenError, NotFoundError } from '../auth/errors.js';

/** The token subject is the entity id for every role — user, restaurant, rider, admin. */
const isAdmin = (req) => String(req.user?.role || '').toUpperCase() === 'ADMIN';

/**
 * The order the request may read: a customer's own, or any for an admin.
 *
 * Throws rather than filtering, so a customer probing another order's payment
 * trail gets the same 404 as for an order that does not exist — no signal that
 * the id was real.
 */
const assertOrderReadable = async (req, orderId) => {
    const order = await prisma.foodOrder.findUnique({
        where: { id: String(orderId) },
        select: { userId: true },
    });
    if (!order) throw new NotFoundError('Order not found');
    if (!isAdmin(req) && order.userId !== String(req.user?.userId)) {
        throw new NotFoundError('Order not found');
    }
};

/**
 * The wallet the request may read. A restaurant or rider reads its own; the
 * URL parameter is only honoured for an admin. It used to be honoured for
 * everyone, and req.user carries no restaurantId, so the fallback to the URL
 * was the only path there was.
 */
const ownWalletId = (req, paramName) => {
    if (isAdmin(req)) return String(req.params[paramName]);
    const own = String(req.user?.userId || '');
    if (req.params[paramName] && String(req.params[paramName]) !== own) {
        throw new ForbiddenError('Not your wallet');
    }
    return own;
};

// ─── User Endpoints ───

export const getPaymentHistoryController = async (req, res, next) => {
    try {
        const { orderId } = req.params;
        await assertOrderReadable(req, orderId);
        const payments = await getPaymentsByOrder(orderId);
        return sendResponse(res, 200, 'Payment history fetched', { payments });
    } catch (err) {
        next(err);
    }
};

export const getOrderTransactionsController = async (req, res, next) => {
    try {
        const { orderId } = req.params;
        await assertOrderReadable(req, orderId);
        const transactions = await getTransactionsByOrder(orderId);
        return sendResponse(res, 200, 'Transactions fetched', { transactions });
    } catch (err) {
        next(err);
    }
};

export const getUserWalletBalanceController = async (req, res, next) => {
    try {
        const userId = req.user?.userId;
        const data = await getWalletBalance('user', userId);
        return sendResponse(res, 200, 'Balance fetched', data);
    } catch (err) {
        next(err);
    }
};

export const getUserWalletTransactionsController = async (req, res, next) => {
    try {
        const userId = req.user?.userId;
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const data = await getWalletWithTransactions('user', userId, { page, limit });
        return sendResponse(res, 200, 'Wallet transactions fetched', data);
    } catch (err) {
        next(err);
    }
};

// ─── Restaurant Endpoints ───

export const getRestaurantWalletController = async (req, res, next) => {
    try {
        const restaurantId = ownWalletId(req, 'restaurantId');
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const data = await getWalletWithTransactions('restaurant', restaurantId, { page, limit });
        return sendResponse(res, 200, 'Restaurant wallet fetched', data);
    } catch (err) {
        next(err);
    }
};

// ─── Delivery Partner Endpoints ───

export const getDeliveryWalletController = async (req, res, next) => {
    try {
        const deliveryPartnerId = ownWalletId(req, 'deliveryPartnerId');
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const data = await getWalletWithTransactions('deliveryBoy', deliveryPartnerId, { page, limit });
        return sendResponse(res, 200, 'Delivery wallet fetched', data);
    } catch (err) {
        next(err);
    }
};

// ─── Admin Endpoints ───

export const getAdminWalletController = async (req, res, next) => {
    try {
        const data = await getWalletBalance('admin', 'platform');
        return sendResponse(res, 200, 'Admin wallet fetched', data);
    } catch (err) {
        next(err);
    }
};

export const getAdminFinanceSummaryController = async (req, res, next) => {
    try {
        const adminWallet = await prisma.wallet.findUnique({
            where: { entityType_entityId: { entityType: 'admin', entityId: 'platform' } },
        });
        const pendingSettlements = await listSettlements({ status: 'pending', limit: 100 });
        const pendingRefunds = await listRefunds({ status: 'pending', limit: 100 });

        return sendResponse(res, 200, 'Finance summary', {
            platform: {
                // Number(), not the raw column: these are Decimal now, and a
                // Decimal serializes to a JSON *string*, so the dashboard would
                // render "1234.00" and arithmetic on it would concatenate.
                balance: Number(adminWallet?.balance || 0),
                totalRevenue: Number(adminWallet?.totalRevenue || 0),
                totalPayouts: Number(adminWallet?.totalPayouts || 0),
                totalRefunds: Number(adminWallet?.totalRefunds || 0)
            },
            pendingSettlements: {
                count: pendingSettlements.total,
                totalAmount: pendingSettlements.settlements.reduce((s, v) => s + (v.amount || 0), 0)
            },
            pendingRefunds: {
                count: pendingRefunds.total,
                totalAmount: pendingRefunds.refunds.reduce((s, v) => s + (v.amount || 0), 0)
            }
        });
    } catch (err) {
        next(err);
    }
};

export const listSettlementsController = async (req, res, next) => {
    try {
        const { entityType, entityId, status } = req.query;
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const data = await listSettlements({ entityType, entityId, status, page, limit });
        return sendResponse(res, 200, 'Settlements fetched', data);
    } catch (err) {
        next(err);
    }
};

export const createSettlementController = async (req, res, next) => {
    try {
        const { entityType, entityId, amount, notes, periodStart, periodEnd } = req.body;
        const settlement = await createSettlement({ entityType, entityId, amount, notes, periodStart, periodEnd });
        return sendResponse(res, 201, 'Settlement created', { settlement });
    } catch (err) {
        next(err);
    }
};

export const processSettlementController = async (req, res, next) => {
    try {
        const { id } = req.params;
        const adminId = req.user?.userId;
        const { payoutRef } = req.body;
        const settlement = await processSettlement(id, { processedBy: adminId, payoutRef });
        return sendResponse(res, 200, 'Settlement processed', { settlement });
    } catch (err) {
        next(err);
    }
};

export const listRefundsController = async (req, res, next) => {
    try {
        const { status } = req.query;
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const data = await listRefunds({ status, page, limit });
        return sendResponse(res, 200, 'Refunds fetched', data);
    } catch (err) {
        next(err);
    }
};

export const getRefundsByOrderController = async (req, res, next) => {
    try {
        const { orderId } = req.params;
        await assertOrderReadable(req, orderId);
        const refunds = await getRefundsByOrder(orderId);
        return sendResponse(res, 200, 'Refunds fetched', { refunds });
    } catch (err) {
        next(err);
    }
};
