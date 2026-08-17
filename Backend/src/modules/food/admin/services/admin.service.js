import mongoose from 'mongoose';
// NotFoundError was already used further down this file (deleteDeliveryPartner)
// without ever being imported — that path threw a ReferenceError instead of a 404
// whenever the partner was missing.
import { NotFoundError, ValidationError } from '../../../../core/auth/errors.js';
import {
    DAY_NAMES,
    normalizeDayName,
    normalizeRestaurantTime,
    parseBooleanLike,
    timeToMinutes,
    toFiniteNumber,
    validateOpeningClosingTimes,
} from './adminRestaurantWrite.helpers.js';
import { normalizeFoodImages } from './foodImages.util.js';
import { FoodRestaurant } from '../../restaurant/models/restaurant.model.js';
import { FoodRestaurantOutletTimings } from '../../restaurant/models/outletTimings.model.js';
import { FoodDeliveryPartner } from '../../delivery/models/deliveryPartner.model.js';
import { DeliverySupportTicket } from '../../delivery/models/supportTicket.model.js';
import { FoodNotification } from '../../../../core/notifications/models/notification.model.js';
import { sendNotificationToOwner } from '../../../../core/notifications/firebase.service.js';
import { FoodRestaurantSubscriptionSettings } from '../models/restaurantSubscriptionSettings.model.js';
import { FoodZone } from '../models/zone.model.js';
import { invalidateActiveZonesCache } from '../../landing/controllers/zonePublic.controller.js';
import { FoodCategory } from '../models/category.model.js';
import { FoodItem } from '../models/food.model.js';
import { FoodOffer } from '../models/offer.model.js';
import { FoodOfferUsage } from '../models/offerUsage.model.js';
import { DeliveryBonusTransaction } from '../models/deliveryBonusTransaction.model.js';
import { FoodEarningAddon } from '../models/earningAddon.model.js';
import { FoodEarningAddonHistory } from '../models/earningAddonHistory.model.js';
import { FoodRestaurantCommission } from '../models/restaurantCommission.model.js';
import { FoodDeliveryCommissionRule } from '../models/deliveryCommissionRule.model.js';
import { FoodFeeSettings } from '../models/feeSettings.model.js';
import { FeedbackExperience } from '../models/feedbackExperience.model.js';
import { FoodUser } from '../../../../core/users/user.model.js';
import { FoodRefreshToken } from '../../../../core/refreshTokens/refreshToken.model.js';
import { FoodDeliveryCashLimit } from '../models/deliveryCashLimit.model.js';
import { FoodDeliveryEmergencyHelp } from '../models/deliveryEmergencyHelp.model.js';
import { FoodReferralSettings } from '../models/referralSettings.model.js';
import { FoodReferralLog } from '../models/referralLog.model.js';
import { FoodSafetyEmergencyReport } from '../models/safetyEmergencyReport.model.js';
import { FoodAddon } from '../../restaurant/models/foodAddon.model.js';
import { FoodSupportTicket } from '../../user/models/supportTicket.model.js';
import { FoodRestaurantSupportTicket } from '../../restaurant/models/supportTicket.model.js';
import { FoodOrder } from '../../orders/models/order.model.js';
import { isCancelledOrder, CANCELLED_ORDER_STATUSES } from '../../orders/services/order.helpers.js';
import { FoodTransaction } from '../../orders/models/foodTransaction.model.js';
import { FoodRestaurantWithdrawal } from '../../restaurant/models/foodRestaurantWithdrawal.model.js';
import { FoodDeliveryWithdrawal } from '../../delivery/models/foodDeliveryWithdrawal.model.js';
import { FoodDeliveryWallet } from '../../delivery/models/deliveryWallet.model.js';
import { FoodDeliveryCashDeposit } from '../../delivery/models/foodDeliveryCashDeposit.model.js';
import { FoodUnregisteredRestaurant } from '../../restaurant/models/unregisteredRestaurant.model.js';
import { FoodAdmin } from '../../../../core/admin/admin.model.js';
import { getAdminRestaurantSubscriptionHistory as getAdminRestaurantSubscriptionHistoryFromRestaurant } from '../../restaurant/services/subscriptionHistory.service.js';
import { FoodRestaurantSubscriptionHistory } from '../../restaurant/models/subscriptionHistory.model.js';
import { ADMIN_FULL_PERMISSIONS, isValidPermissionPayload, sanitizeAdminPermissions } from '../../../../constants/permissions.js';

// Extracted into their own files. Re-exported here so the twelve modules
// that import from admin.service.js do not each need their paths changed.
export * from './adminZone.service.js';
export * from './adminSubAdmin.service.js';
export * from './adminCommission.service.js';
export * from './adminPlatformSettings.service.js';
export * from './adminCustomer.service.js';
export * from './adminSupportTicket.service.js';
export * from './adminWithdrawal.service.js';
export * from './adminEarningAddon.service.js';
export * from './adminDeliveryPartner.service.js';
export * from './adminDeliveryWallet.service.js';
export * from './adminCategory.service.js';
export * from './adminOffer.service.js';
export * from './adminAddon.service.js';
export * from './adminFood.service.js';
export * from './adminRestaurantLifecycle.service.js';
export * from './adminRestaurantDirectory.service.js';
export * from './adminFeedback.service.js';
export * from './adminRestaurantWrite.service.js';
export * from './adminDeliverySupport.service.js';
export * from './adminDashboard.service.js';
export * from './adminFinanceReport.service.js';

import {
    getCategoryStats,
    categoryAllowsFoodType,
    normalizeCategoryFoodTypeScope,
    serializeCategoryForResponse
} from '../../shared/categoryWorkflow.js';
import {
    extractRawFoodVariants,
    getFoodDisplayOtherPrice,
    getFoodDisplayPrice,
    hasFoodVariants,
    normalizeFoodVariantsInput,
    serializeFoodVariants
} from './foodVariant.service.js';
import { resolveDiscountSplit } from '../../shared/discountSplit.util.js';
import {
    isRestaurantEarnedOrder,
    computeRestaurantOrderShare,
    orderMoney,
} from '../../shared/restaurantPayout.util.js';

/**
 * Platform settings live in adminSettings.service.js — they are read by the
 * delivery, restaurant and referral modules, and had no business sitting inside
 * this file. Re-exported so existing imports keep working.
 */
export {
    getDeliveryCashLimitSettings,
    upsertDeliveryCashLimitSettings,
    getDeliveryEmergencyHelp,
    upsertDeliveryEmergencyHelp,
    getRestaurantSubscriptionSettings,
    addDeliveryPartnerBonus,
} from './adminSettings.service.js';


function buildTaxReportDateMatch(fromDate, toDate) {
    const createdAt = {};
    if (fromDate) {
        createdAt.$gte = new Date(fromDate);
    }
    if (toDate) {
        const end = new Date(toDate);
        if (!Number.isNaN(end.getTime())) {
            end.setHours(23, 59, 59, 999);
            createdAt.$lte = end;
        }
    }
    return Object.keys(createdAt).length > 0 ? createdAt : null;
}

function normalizeTaxReportCalculateTax(value) {
    return String(value || 'percentage').toLowerCase().replace(/\s+/g, '_');
}

function shouldRecalculateTaxAtRate(taxRate, calculateTax) {
    const rate = Number(taxRate);
    return (
        Number.isFinite(rate) &&
        rate > 0 &&
        normalizeTaxReportCalculateTax(calculateTax) === 'percentage'
    );
}

function buildOrderTaxAmountExpression(taxRate, calculateTax) {
    if (shouldRecalculateTaxAtRate(taxRate, calculateTax)) {
        const rate = Number(taxRate) / 100;
        return {
            $round: [
                {
                    $multiply: [
                        {
                            $max: [
                                0,
                                {
                                    $subtract: [
                                        { $ifNull: ['$pricing.subtotal', 0] },
                                        { $ifNull: ['$pricing.discount', 0] }
                                    ]
                                }
                            ]
                        },
                        rate
                    ]
                },
                0
            ]
        };
    }
    return { $ifNull: ['$pricing.tax', 0] };
}

function computeOrderTaxAmount(pricing = {}, taxRate, calculateTax) {
    if (shouldRecalculateTaxAtRate(taxRate, calculateTax)) {
        const rate = Number(taxRate) / 100;
        const taxableBase = Math.max(
            0,
            (Number(pricing.subtotal) || 0) - (Number(pricing.discount) || 0)
        );
        return Math.round(taxableBase * rate);
    }
    return Number(pricing.tax) || 0;
}

async function loadOffersByRestaurantIds(restaurantIds = []) {
    const uniqueIds = [...new Set(
        (restaurantIds || [])
            .map((id) => String(id || '').trim())
            .filter((id) => mongoose.Types.ObjectId.isValid(id)),
    )];
    if (!uniqueIds.length) return new Map();

    const objectIds = uniqueIds.map((id) => new mongoose.Types.ObjectId(id));
    const offers = await FoodOffer.find({
        $or: [
            { restaurantScope: { $ne: 'selected' } },
            { restaurantId: { $in: objectIds } },
            { restaurantIds: { $in: objectIds } },
        ],
    }).lean();

    const offersByRestaurantId = new Map();
    for (const restaurantId of uniqueIds) {
        const scopedOffers = offers.filter((offer) => {
            if (offer?.restaurantScope !== 'selected') return true;
            const selectedIds = Array.isArray(offer.restaurantIds) && offer.restaurantIds.length > 0
                ? offer.restaurantIds
                : [offer.restaurantId].filter(Boolean);
            return selectedIds.some((id) => String(id) === restaurantId);
        });
        offersByRestaurantId.set(restaurantId, scopedOffers);
    }
    return offersByRestaurantId;
}

async function summarizeRestaurantEarningsForTaxReport(orders = [], { taxRate, calculateTax } = {}) {
    const earnedOrders = (orders || []).filter(isRestaurantEarnedOrder);
    if (!earnedOrders.length) {
        return { grouped: new Map(), totalEarnings: 0, totalTax: 0 };
    }

    const orderIds = earnedOrders.map((order) => order._id);
    const restaurantIds = earnedOrders.map((order) => order.restaurantId);
    const [transactions, offersByRestaurantId] = await Promise.all([
        FoodTransaction.find({ orderId: { $in: orderIds } })
            .select('orderId pricing amounts')
            .lean(),
        loadOffersByRestaurantIds(restaurantIds),
    ]);
    const txByOrderId = new Map(transactions.map((tx) => [String(tx.orderId), tx]));

    const grouped = new Map();
    let totalEarnings = 0;
    let totalTax = 0;

    for (const order of earnedOrders) {
        const restaurantId = String(order.restaurantId);
        const tx = txByOrderId.get(String(order._id));
        const pricing = tx?.pricing || order.pricing || {};
        const offers = offersByRestaurantId.get(restaurantId) || [];
        const earnings = computeRestaurantOrderShare(orderMoney(order, tx), offers, restaurantId);
        const taxAmount = computeOrderTaxAmount(pricing, taxRate, calculateTax);

        if (!grouped.has(restaurantId)) {
            grouped.set(restaurantId, { totalEarnings: 0, totalTax: 0, orderCount: 0 });
        }
        const bucket = grouped.get(restaurantId);
        bucket.totalEarnings += earnings;
        bucket.totalTax += taxAmount;
        bucket.orderCount += 1;
        totalEarnings += earnings;
        totalTax += taxAmount;
    }

    return { grouped, totalEarnings, totalTax };
}

export async function getTaxReport(query = {}) {
    const { fromDate, toDate, search, taxRate, calculateTax } = query;
    const match = {
        orderStatus: { $nin: ['pending_payment'] },
    };

    const createdAt = buildTaxReportDateMatch(fromDate, toDate);
    if (createdAt) {
        match.createdAt = createdAt;
    }

    if (search) {
        match.orderId = { $regex: search, $options: 'i' };
    }

    const orders = await FoodOrder.find(match)
        .select('restaurantId orderStatus status deliveryState pricing createdAt orderId')
        .lean();

    const { grouped, totalEarnings, totalTax } = await summarizeRestaurantEarningsForTaxReport(
        orders,
        { taxRate, calculateTax },
    );

    const restaurantObjectIds = [...grouped.keys()]
        .filter((id) => mongoose.Types.ObjectId.isValid(id))
        .map((id) => new mongoose.Types.ObjectId(id));
    const restaurants = restaurantObjectIds.length
        ? await FoodRestaurant.find({ _id: { $in: restaurantObjectIds } })
            .select('restaurantName')
            .lean()
        : [];
    const restaurantNameById = new Map(restaurants.map((row) => [String(row._id), row.restaurantName]));

    const taxData = [...grouped.entries()]
        .map(([restaurantId, item]) => ({
            _id: restaurantId,
            incomeSource: restaurantNameById.get(restaurantId) || 'Unknown Restaurant',
            totalIncome: item.totalEarnings,
            totalTax: item.totalTax,
            orderCount: item.orderCount,
        }))
        .sort((a, b) => b.totalTax - a.totalTax);

    const reports = taxData.map((item, index) => ({
        sl: index + 1,
        id: item._id,
        incomeSource: item.incomeSource,
        totalIncome: `\u20B9${item.totalIncome.toFixed(2)}`,
        totalTax: `\u20B9${item.totalTax.toFixed(2)}`,
        orderCount: item.orderCount,
    }));

    return {
        reports,
        stats: {
            totalIncome: `\u20B9${totalEarnings.toFixed(2)}`,
            totalTax: `\u20B9${totalTax.toFixed(2)}`,
        },
    };
}

export async function getTaxReportDetail(restaurantId, query = {}) {
    if (!restaurantId || !mongoose.Types.ObjectId.isValid(restaurantId)) {
        throw new ValidationError('Invalid restaurant ID');
    }

    const { fromDate, toDate, taxRate, calculateTax } = query;
    const match = {
        restaurantId: new mongoose.Types.ObjectId(restaurantId),
        orderStatus: { $nin: ['pending_payment'] },
    };

    const createdAt = buildTaxReportDateMatch(fromDate, toDate);
    if (createdAt) {
        match.createdAt = createdAt;
    }

    const orders = await FoodOrder.find(match)
        .select('orderId orderStatus status deliveryState pricing createdAt restaurantId')
        .sort({ createdAt: -1 })
        .lean();

    const earnedOrders = orders.filter(isRestaurantEarnedOrder);
    const orderIds = earnedOrders.map((order) => order._id);
    const [transactions, offers] = await Promise.all([
        orderIds.length
            ? FoodTransaction.find({ orderId: { $in: orderIds } })
                .select('orderId pricing amounts')
                .lean()
            : [],
        loadOffersByRestaurantIds([restaurantId]).then((map) => map.get(String(restaurantId)) || []),
    ]);
    const txByOrderId = new Map(transactions.map((tx) => [String(tx.orderId), tx]));

    const restaurant = await FoodRestaurant.findById(restaurantId).select('restaurantName').lean();

    return {
        restaurantName: restaurant?.restaurantName || 'Unknown Restaurant',
        orders: earnedOrders.map((order) => {
            const tx = txByOrderId.get(String(order._id));
            const pricing = tx?.pricing || order.pricing || {};
            const earnings = computeRestaurantOrderShare(orderMoney(order, tx), offers, restaurantId);
            const taxAmount = computeOrderTaxAmount(pricing, taxRate, calculateTax);
            return {
                id: order._id,
                orderId: order.orderId,
                totalAmount: `\u20B9${earnings.toFixed(2)}`,
                taxAmount: `\u20B9${taxAmount.toFixed(2)}`,
                date: order.createdAt,
            };
        }),
    };
}

// ----- Customers / Users (admin) -----


// ----- Restaurant Commission (admin) -----


// ----- Delivery Cash Limit (admin) -----
// ----- Delivery Emergency Help (admin) -----


function formatSubscriptionPlanLabel(plan) {
    const key = String(plan || '').trim().toLowerCase();
    if (key === 'starter') return 'Starter';
    if (key === 'growth') return 'Growth';
    if (key === 'premium') return 'Premium';
    if (!key) return 'Not assigned';
    return key.charAt(0).toUpperCase() + key.slice(1);
}

/**
 * Invoice-based subscription summary for the admin POS analytics view
 * (calendar-month postpaid billing).
 */
async function buildRestaurantSubscriptionSummary(restaurantId) {
    const rId = new mongoose.Types.ObjectId(String(restaurantId));

    const [
        { FoodSubscriptionInvoice },
        { FoodSubscriptionTransaction },
        billingService,
    ] = await Promise.all([
        import('../../restaurant/models/subscriptionInvoice.model.js'),
        import('../../restaurant/models/subscriptionTransaction.model.js'),
        import('../../restaurant/services/subscriptionBilling.service.js'),
    ]);

    const currentMonth = billingService.formatBillingMonth(new Date());
    const { start: monthStart } = billingService.getMonthWindow(currentMonth);

    const [invoiceAgg, latestInvoice, lastPaymentTx, currentGmv, invoices] = await Promise.all([
        FoodSubscriptionInvoice.aggregate([
            { $match: { restaurantId: rId } },
            {
                $group: {
                    _id: null,
                    totalBilled: { $sum: { $ifNull: ['$totalAmount', 0] } },
                    totalPaid: { $sum: { $ifNull: ['$paidAmount', 0] } },
                    totalWaived: { $sum: { $ifNull: ['$waivedAmount', 0] } },
                    totalOutstanding: { $sum: { $ifNull: ['$outstandingAmount', 0] } },
                    invoiceCount: { $sum: 1 },
                },
            },
        ]),
        FoodSubscriptionInvoice.findOne({ restaurantId: rId, billingMonth: { $ne: 'legacy' } })
            .sort({ billingMonth: -1 })
            .lean(),
        FoodSubscriptionTransaction.findOne({
            restaurantId: rId,
            type: { $in: ['wallet_deduction', 'manual_payment'] },
        })
            .sort({ createdAt: -1 })
            .lean(),
        billingService.computeMonthlyGmv(rId, monthStart, new Date()),
        FoodSubscriptionInvoice.find({ restaurantId: rId })
            .sort({ billingMonth: -1 })
            .limit(12)
            .lean(),
    ]);

    const walletDeductionAgg = await FoodSubscriptionTransaction.aggregate([
        { $match: { restaurantId: rId, type: 'wallet_deduction' } },
        { $group: { _id: null, total: { $sum: { $ifNull: ['$amount', 0] } }, count: { $sum: 1 } } },
    ]);

    const agg = invoiceAgg?.[0] || {};
    const dueAmount = Math.max(0, Number(agg.totalOutstanding) || 0);
    const planKey = String(latestInvoice?.planName || '').trim().toLowerCase();

    return {
        billingModel: 'calendar_month_postpaid',
        currentBillingMonth: currentMonth,
        currentMonthGmv: Number(currentGmv?.gmv) || 0,
        plan: planKey,
        planLabel: latestInvoice ? formatSubscriptionPlanLabel(planKey) : 'Not billed yet',
        cycleFee: Math.max(0, Number(latestInvoice?.totalAmount) || 0),
        lastBilledMonth: latestInvoice?.billingMonth || null,
        status: dueAmount > 0 ? 'due' : 'paid',
        statusLabel: dueAmount > 0 ? 'Outstanding dues pending' : 'No outstanding dues',
        dueAmount,
        paidAmount: Math.max(0, Number(agg.totalPaid) || 0),
        totalBilled: Math.max(0, Number(agg.totalBilled) || 0),
        totalWaived: Math.max(0, Number(agg.totalWaived) || 0),
        totalCollected: Math.max(0, Number(agg.totalPaid) || 0),
        walletDeductionsTotal: Math.max(0, Number(walletDeductionAgg?.[0]?.total) || 0),
        invoiceCount: Math.max(0, Number(agg.invoiceCount) || 0),
        invoices: invoices.map((inv) => ({
            billingMonth: inv.billingMonth,
            billingMonthLabel: billingService.billingMonthLabel(inv.billingMonth),
            gmv: inv.gmv,
            planName: inv.planName,
            totalAmount: inv.totalAmount,
            paidAmount: inv.paidAmount,
            waivedAmount: inv.waivedAmount,
            outstandingAmount: inv.outstandingAmount,
            status: inv.status,
        })),
        lastPayment: lastPaymentTx
            ? {
                amount: Math.max(0, Number(lastPaymentTx.amount) || 0),
                eventType: String(lastPaymentTx.type || ''),
                paymentType: lastPaymentTx.type === 'wallet_deduction' ? 'wallet' : 'manual',
                date: lastPaymentTx.createdAt || null,
                note: String(lastPaymentTx.remarks || '').trim(),
            }
            : null,
    };
}

export async function getRestaurantAnalytics(restaurantId) {
    if (!restaurantId || !mongoose.Types.ObjectId.isValid(restaurantId)) return null;
    const rId = new mongoose.Types.ObjectId(restaurantId);
    const restaurantOrderMatch = {
        $or: [
            { restaurantId: rId },
            { restaurantId: String(restaurantId) },
        ],
    };

    const [restaurant, commissionDoc, orders, txRows, orderStatsRows, relevantOffers] = await Promise.all([
        FoodRestaurant.findById(rId).lean(),
        FoodRestaurantCommission.findOne({ restaurantId: rId, status: { $ne: false } }).lean(),
        FoodOrder.find(restaurantOrderMatch).lean(),
        FoodTransaction.find({ restaurantId: rId })
            .populate('orderId', 'orderStatus deliveryState createdAt pricing')
            .sort({ createdAt: -1 })
            .lean(),
        FoodOrder.aggregate([
            { $match: restaurantOrderMatch },
            {
                $addFields: {
                    statusNormalized: {
                        $toLower: {
                            $trim: {
                                input: { $ifNull: ['$orderStatus', '$status', ''] },
                            },
                        },
                    },
                },
            },
            {
                $group: {
                    _id: null,
                    totalOrders: { $sum: 1 },
                    completedOrders: {
                        $sum: {
                            $cond: [{ $eq: ['$statusNormalized', 'delivered'] }, 1, 0],
                        },
                    },
                    notDeliveredOrders: {
                        $sum: {
                            $cond: [{ $ne: ['$statusNormalized', 'delivered'] }, 1, 0],
                        },
                    },
                    explicitlyCancelledOrders: {
                        $sum: {
                            $cond: [
                                { $in: ['$statusNormalized', CANCELLED_ORDER_STATUSES] },
                                1,
                                0,
                            ],
                        },
                    },
                    cancelledByRestaurant: {
                        $sum: {
                            $cond: [{ $eq: ['$statusNormalized', 'cancelled_by_restaurant'] }, 1, 0],
                        },
                    },
                    cancelledByAdmin: {
                        $sum: {
                            $cond: [{ $eq: ['$statusNormalized', 'cancelled_by_admin'] }, 1, 0],
                        },
                    },
                    cancelledByUser: {
                        $sum: {
                            $cond: [{ $eq: ['$statusNormalized', 'cancelled_by_user'] }, 1, 0],
                        },
                    },
                    inProgressOrders: {
                        $sum: {
                            $cond: [
                                {
                                    $in: [
                                        '$statusNormalized',
                                        [
                                            'created',
                                            'confirmed',
                                            'preparing',
                                            'ready_for_pickup',
                                            'reached_pickup',
                                            'picked_up',
                                            'reached_drop',
                                        ],
                                    ],
                                },
                                1,
                                0,
                            ],
                        },
                    },
                },
            },
        ]),
        FoodOffer.find({
            $or: [
                { restaurantScope: { $ne: 'selected' } },
                { restaurantId: rId },
                { restaurantIds: rId },
            ],
        }).lean(),
    ]);

    if (!restaurant) return null;

    const now = new Date();
    const currentMonth = now.getMonth();
    const currentYear = now.getFullYear();

    const toStatus = (value) => String(value || '').trim().toLowerCase();
    const isCompletedOrder = (order) => {
        if (isCancelledOrder(order)) return false;
        const orderStatus = toStatus(order?.orderStatus || order?.status);
        const deliveryPhase = toStatus(order?.deliveryState?.currentPhase);
        return orderStatus === 'delivered' || deliveryPhase === 'delivered' || deliveryPhase === 'completed';
    };
    const getPricing = (row) => row?.pricing || row?.orderId?.pricing || {};
    const getAmount = (row, key) => {
        const value = row?.amounts?.[key];
        return value === undefined || value === null ? null : Number(value);
    };
    const getRestaurantShare = (row) => {
        const explicitShare = getAmount(row, 'restaurantShare');
        if (Number.isFinite(explicitShare)) return explicitShare;
        const pricing = getPricing(row);
        const subtotal = Number(pricing?.subtotal) || 0;
        const packagingFee = Number(pricing?.packagingFee) || 0;
        const commission = Number(pricing?.restaurantCommission) || 0;
        return Math.max(0, subtotal + packagingFee - commission);
    };
    const getDiscountShares = (row) => resolveDiscountSplit({
        money: { ...getPricing(row), ...(row?.amounts || {}) },
        offers: relevantOffers,
        restaurantId: rId,
    });

    const completedOrders = orders.filter(isCompletedOrder);
    const orderStats = orderStatsRows?.[0] || {};
    const totalOrdersCount = Number(orderStats.totalOrders) || orders.length;
    const completedOrdersCount = Number(orderStats.completedOrders) || 0;
    const notDeliveredOrdersCount = Number(orderStats.notDeliveredOrders) || 0;
    const explicitlyCancelledOrdersCount = Number(orderStats.explicitlyCancelledOrders) || 0;
    const inProgressOrdersCount = Number(orderStats.inProgressOrders) || 0;

    // Money metrics should come from the ledger (FoodTransaction), not FoodOrder.
    const completedTxByOrderId = new Map(
        (txRows || [])
            .filter((tx) => tx?.orderId && isCompletedOrder(tx.orderId))
            .map((tx) => [String(tx.orderId?._id || tx.orderId), tx])
    );
    // Prefer the ledger snapshot per order, but do not drop a completed order
    // just because its transaction row is missing.
    const completedMoneyRows = completedOrders.map(
        (order) => completedTxByOrderId.get(String(order._id)) || order
    );

    const sum = (arr, pick) => (arr || []).reduce((s, it) => s + (Number(pick(it)) || 0), 0);

    // 1) Total order value (gross customer paid)
    const totalRevenue = sum(completedMoneyRows, (row) => getAmount(row, 'totalCustomerPaid') ?? getPricing(row)?.total);

    // 2) Restaurant share (payout to restaurant)
    const restaurantEarning = sum(completedMoneyRows, getRestaurantShare);

    // 3) Restaurant commission paid to admin
    const totalCommission = sum(completedMoneyRows, (row) => getAmount(row, 'restaurantCommission') ?? getPricing(row)?.restaurantCommission);

    // 4) Restaurant profit (in this system, equals restaurant share)
    const restaurantProfit = restaurantEarning;

    const monthlyOrdersList = orders.filter(o => {
        const d = new Date(o.createdAt);
        return d.getMonth() === currentMonth && d.getFullYear() === currentYear;
    });
    const monthlyCompletedMoneyRows = completedMoneyRows.filter((row) => {
        const d = new Date(row?.createdAt || row?.orderId?.createdAt || 0);
        return d.getMonth() === currentMonth && d.getFullYear() === currentYear;
    });
    const monthlyProfit = sum(monthlyCompletedMoneyRows, getRestaurantShare);

    const yearlyOrdersList = orders.filter(o => {
        const d = new Date(o.createdAt);
        return d.getFullYear() === currentYear;
    });
    const yearlyCompletedMoneyRows = completedMoneyRows.filter((row) => {
        const d = new Date(row?.createdAt || row?.orderId?.createdAt || 0);
        return d.getFullYear() === currentYear;
    });
    const yearlyProfit = sum(yearlyCompletedMoneyRows, getRestaurantShare);

    const avgOrderValue = completedMoneyRows.length > 0 ? totalRevenue / completedMoneyRows.length : 0;

    const uniqueCustomers = new Set(orders.map(o => String(o.userId))).size;
    const customerOrderCounts = orders.reduce((acc, o) => {
        const uid = String(o.userId);
        acc[uid] = (acc[uid] || 0) + 1;
        return acc;
    }, {});
    const repeatCustomers = Object.values(customerOrderCounts).filter(count => count > 1).length;

    // 5) Restaurant commission percent
    const commissionType = commissionDoc?.defaultCommission?.type || 'percentage';
    const commissionValue = Number(commissionDoc?.defaultCommission?.value || 0) || 0;
    const completedSubtotal = sum(completedMoneyRows, (row) => getPricing(row)?.subtotal);
    const computedCommissionPercent =
        commissionType === 'percentage'
            ? commissionValue
            : (completedSubtotal > 0 ? (totalCommission / completedSubtotal) * 100 : 0);

    const analytics = {
        totalOrders: totalOrdersCount,
        cancelledOrders: explicitlyCancelledOrdersCount,
        explicitlyCancelledOrders: explicitlyCancelledOrdersCount,
        inProgressOrders: inProgressOrdersCount,
        notDeliveredOrders: notDeliveredOrdersCount,
        completedOrders: completedOrdersCount,
        cancelledByRestaurant: Number(orderStats.cancelledByRestaurant) || 0,
        cancelledByAdmin: Number(orderStats.cancelledByAdmin) || 0,
        cancelledByUser: Number(orderStats.cancelledByUser) || 0,
        averageRating: Number(restaurant.rating || 0),
        totalRatings: Number(restaurant.totalRatings || 0),
        commissionPercentage: computedCommissionPercent,
        monthlyProfit,
        yearlyProfit,
        averageOrderValue: avgOrderValue,
        totalRevenue,
        totalCommission,
        restaurantEarning, // restaurant share
        restaurantProfit,
        monthlyOrders: monthlyOrdersList.length,
        yearlyOrders: yearlyOrdersList.length,
        averageMonthlyProfit: monthlyProfit, // Placeholder: can be improved if historical data exists
        averageYearlyProfit: yearlyProfit,   // Placeholder: can be improved if historical data exists
        status: restaurant.status === 'approved' ? 'active' : 'inactive',
        joinDate: restaurant.createdAt,
        totalCustomers: uniqueCustomers,
        repeatCustomers,
        cancellationRate: totalOrdersCount > 0 ? (explicitlyCancelledOrdersCount / totalOrdersCount) * 100 : 0,
        completionRate: totalOrdersCount > 0 ? (completedOrdersCount / totalOrdersCount) * 100 : 0,
        inProgressRate: totalOrdersCount > 0 ? (inProgressOrdersCount / totalOrdersCount) * 100 : 0,
    };

    const paymentSummary = {
        // Pricing (what customer paid components)
        subtotal: sum(completedMoneyRows, (row) => getPricing(row)?.subtotal),
        tax: sum(completedMoneyRows, (row) => getPricing(row)?.tax ?? getAmount(row, 'taxAmount')),
        packagingFee: sum(completedMoneyRows, (row) => getPricing(row)?.packagingFee),
        deliveryFee: sum(completedMoneyRows, (row) => getPricing(row)?.deliveryFee),
        platformFee: sum(completedMoneyRows, (row) => getPricing(row)?.platformFee),
        discount: sum(completedMoneyRows, (row) => getPricing(row)?.discount),
        adminDiscountShare: sum(completedMoneyRows, (row) => getDiscountShares(row).adminDiscountShare),
        restaurantDiscountShare: sum(completedMoneyRows, (row) => getDiscountShares(row).restaurantDiscountShare),
        total: totalRevenue,
        currency: 'INR',

        // Split (who got what)
        restaurantShare: restaurantEarning,
        restaurantCommission: totalCommission,
        riderShare: sum(completedMoneyRows, (row) => getAmount(row, 'riderShare') ?? row?.riderEarning),
        platformNetProfit: sum(completedMoneyRows, (row) => getAmount(row, 'platformNetProfit') ?? row?.platformProfit),
    };

    const subscriptionSummary = await buildRestaurantSubscriptionSummary(rId);

    return { restaurant, analytics, paymentSummary, subscriptionSummary };
}


// ----- Categories -----


// ----- Delivery join requests -----




// ----- Delivery partners (approved list) -----
/**
 * Private helper to get financial stats for multiple delivery partners in bulk.
 */


// ----- Delivery partner bonus (admin) -----


export async function getDeliveryEarnings(query = {}) {
    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    const limit = Math.max(1, Math.min(1000, parseInt(query.limit, 10) || 50));
    const skip = (page - 1) * limit;

    const filter = {
        'dispatch.deliveryPartnerId': { $ne: null }
    };

    // Date range filters
    const createdAtFilter = {};
    if (query.fromDate) {
        const from = new Date(query.fromDate);
        if (!Number.isNaN(from.getTime())) {
            from.setHours(0, 0, 0, 0);
            createdAtFilter.$gte = from;
        }
    }
    if (query.toDate) {
        const to = new Date(query.toDate);
        if (!Number.isNaN(to.getTime())) {
            to.setHours(23, 59, 59, 999);
            createdAtFilter.$lte = to;
        }
    }

    // Period filters (only when explicit date range is not provided)
    if (!createdAtFilter.$gte && !createdAtFilter.$lte) {
        const period = String(query.period || 'all').trim().toLowerCase();
        const now = new Date();
        if (period === 'today') {
            const start = new Date(now);
            start.setHours(0, 0, 0, 0);
            const end = new Date(now);
            end.setHours(23, 59, 59, 999);
            createdAtFilter.$gte = start;
            createdAtFilter.$lte = end;
        } else if (period === 'week') {
            const start = new Date(now);
            start.setHours(0, 0, 0, 0);
            start.setDate(start.getDate() - start.getDay()); // Sunday
            const end = new Date(start);
            end.setDate(start.getDate() + 6);
            end.setHours(23, 59, 59, 999);
            createdAtFilter.$gte = start;
            createdAtFilter.$lte = end;
        } else if (period === 'month') {
            const start = new Date(now.getFullYear(), now.getMonth(), 1);
            start.setHours(0, 0, 0, 0);
            const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
            end.setHours(23, 59, 59, 999);
            createdAtFilter.$gte = start;
            createdAtFilter.$lte = end;
        }
    }

    if (createdAtFilter.$gte || createdAtFilter.$lte) {
        filter.createdAt = createdAtFilter;
    }

    if (query.deliveryPartnerId && mongoose.Types.ObjectId.isValid(query.deliveryPartnerId)) {
        filter['dispatch.deliveryPartnerId'] = new mongoose.Types.ObjectId(query.deliveryPartnerId);
    }

    const search = String(query.search || '').trim();
    if (search) {
        const regex = new RegExp(search, 'i');

        const [partners, restaurants] = await Promise.all([
            FoodDeliveryPartner.find({
                $or: [{ name: regex }, { phone: regex }, { email: regex }]
            }).select('_id').lean(),
            FoodRestaurant.find({
                $or: [{ restaurantName: regex }, { name: regex }]
            }).select('_id').lean()
        ]);

        const partnerIds = partners.map((p) => p._id);
        const restaurantIds = restaurants.map((r) => r._id);

        filter.$or = [
            { orderId: regex },
            { 'dispatch.deliveryPartnerId': { $in: partnerIds } },
            { restaurantId: { $in: restaurantIds } }
        ];
    }

    const [orders, total, earningsAgg, distinctPartners] = await Promise.all([
        FoodOrder.find(filter)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .select('orderId orderStatus createdAt pricing riderEarning deliveryPartnerSettlement dispatch.deliveryPartnerId restaurantId')
            .populate({ path: 'dispatch.deliveryPartnerId', select: 'name phone' })
            .populate({ path: 'restaurantId', select: 'restaurantName name' })
            .lean(),
        FoodOrder.countDocuments(filter),
        FoodOrder.aggregate([
            { $match: filter },
            {
                $group: {
                    _id: null,
                    totalEarnings: {
                        $sum: {
                            $ifNull: [
                                '$riderEarning',
                                {
                                    $ifNull: [
                                        '$deliveryPartnerSettlement',
                                        { $ifNull: ['$pricing.deliveryFee', 0] }
                                    ]
                                }
                            ]
                        }
                    },
                    totalOrders: { $sum: 1 }
                }
            }
        ]),
        FoodOrder.distinct('dispatch.deliveryPartnerId', filter)
    ]);

    const earnings = orders.map((order) => {
        const partner = order?.dispatch?.deliveryPartnerId;
        const amount = Number(
            order?.riderEarning ??
            order?.deliveryPartnerSettlement ??
            order?.pricing?.deliveryFee ??
            0
        ) || 0;

        return {
            transactionId: String(order._id),
            orderId: order.orderId || 'N/A',
            deliveryPartnerId: partner?._id ? String(partner._id) : null,
            deliveryPartnerName: partner?.name || 'N/A',
            deliveryPartnerPhone: partner?.phone || 'N/A',
            restaurantName: order?.restaurantId?.restaurantName || order?.restaurantId?.name || 'N/A',
            amount,
            orderTotal: Number(order?.pricing?.total || 0) || 0,
            deliveryFee: Number(order?.pricing?.deliveryFee || 0) || 0,
            orderStatus: order?.orderStatus || 'N/A',
            createdAt: order?.createdAt || null
        };
    });

    const agg = earningsAgg?.[0] || {};
    const totalDeliveryPartners = (distinctPartners || []).filter(Boolean).length;

    return {
        earnings,
        summary: {
            totalDeliveryPartners,
            totalEarnings: Number(agg.totalEarnings || 0),
            totalOrders: Number(agg.totalOrders || 0)
        },
        pagination: {
            page,
            limit,
            total,
            pages: Math.ceil(total / limit) || 1
        }
    };
}

// ----- Earning Addon Offers (admin) -----





// ----- Zones CRUD -----


// ----- Withdrawals (admin) -----


/**
 * Fetch delivery partner wallets with financial summary
 */


/**
 * Deactivate a delivery partner (admin)
 */
/**
 * Edits a delivery partner's name and phone from the admin panel.
 *
 * Phone is not just a display field — it is how the rider logs in, and it carries a
 * unique index. Two things follow:
 *
 *  - A number already used by another partner has to be rejected with a readable
 *    message. Letting it reach the database surfaces a raw E11000 to the admin, and
 *    a deactivated partner still holds its number, so the collision is not always
 *    visible in the list.
 *  - Changing the number changes who can sign in. The rider's existing sessions are
 *    invalidated so the old handset cannot keep acting on an identity that has moved.
 */


/**
 * Fetch cash limit settlement (deposit) transactions
 */
