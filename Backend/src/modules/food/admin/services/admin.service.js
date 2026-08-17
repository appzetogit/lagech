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


const PENDING_ORDER_STATUSES = ['created', 'confirmed', 'preparing', 'ready_for_pickup', 'picked_up'];

const getDateRangeByPeriod = (periodRaw) => {
    const period = String(periodRaw || 'overall').trim().toLowerCase();
    if (!period || period === 'overall' || period === 'all') return null;

    const now = new Date();
    const start = new Date(now);
    const end = new Date(now);

    if (period === 'today') {
        start.setHours(0, 0, 0, 0);
        end.setHours(23, 59, 59, 999);
        return { start, end };
    }

    if (period === 'week') {
        start.setHours(0, 0, 0, 0);
        start.setDate(start.getDate() - start.getDay());
        end.setTime(start.getTime());
        end.setDate(start.getDate() + 6);
        end.setHours(23, 59, 59, 999);
        return { start, end };
    }

    if (period === 'month') {
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
        const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
        return { start: monthStart, end: monthEnd };
    }

    if (period === 'year') {
        const yearStart = new Date(now.getFullYear(), 0, 1);
        const yearEnd = new Date(now.getFullYear(), 11, 31, 23, 59, 59, 999);
        return { start: yearStart, end: yearEnd };
    }

    return null;
};

const formatMonthShort = (year, monthIndex) =>
    new Date(year, monthIndex, 1).toLocaleString('en-IN', { month: 'short' });

export async function getDashboardStats(query = {}) {
    const periodRange = getDateRangeByPeriod(query.period);
    const zoneId = query.zoneId && mongoose.Types.ObjectId.isValid(query.zoneId)
        ? new mongoose.Types.ObjectId(query.zoneId)
        : null;

    const orderMatch = {
        $or: [
            { "payment.method": { $in: ["cash", "wallet"] } },
            { "payment.status": { $in: ["paid", "authorized", "captured", "settled", "refunded"] } },
        ],
    };
    if (periodRange) {
        orderMatch.createdAt = { $gte: periodRange.start, $lte: periodRange.end };
    }
    if (zoneId) {
        orderMatch.zoneId = zoneId;
    }

    const restaurantMatch = {};
    if (zoneId) {
        restaurantMatch.zoneId = zoneId;
    }

    const zoneRestaurantIds = zoneId
        ? await FoodRestaurant.find({ zoneId }).distinct('_id')
        : null;
    const zoneScopedRestaurantMatch = zoneId
        ? { restaurantId: { $in: zoneRestaurantIds || [] } }
        : {};

    const [
        orderTotalsAgg,
        monthlyAgg,
        restaurantsTotal,
        restaurantsPending,
        deliveryTotal,
        deliveryPending,
        foodsTotal,
        addonsTotal,
        customersTotal,
        recentPendingRestaurants,
        recentPendingDelivery,
        recentPendingOrders,
        recentDeliveredOrders,
        recentCancelledOrders,
        recentCustomers
    ] = await Promise.all([
        FoodOrder.aggregate([
            { $match: orderMatch },
            {
                $group: {
                    _id: null,
                    totalOrders: { $sum: 1 },
                    delivered: { $sum: { $cond: [{ $eq: ['$orderStatus', 'delivered'] }, 1, 0] } },
                    cancelled: {
                        $sum: {
                            $cond: [{ $in: ['$orderStatus', CANCELLED_ORDER_STATUSES] }, 1, 0]
                        }
                    },
                    pending: {
                        $sum: {
                            $cond: [{ $in: ['$orderStatus', PENDING_ORDER_STATUSES] }, 1, 0]
                        }
                    },
                    revenueTotal: { 
                        $sum: { 
                            $cond: [{ $eq: ['$orderStatus', 'delivered'] }, { $ifNull: ['$pricing.total', 0] }, 0] 
                        } 
                    },
                    commissionTotal: { 
                        $sum: { 
                            $cond: [{ $eq: ['$orderStatus', 'delivered'] }, { $ifNull: ['$pricing.restaurantCommission', 0] }, 0] 
                        } 
                    },
                    platformFeeTotal: { 
                        $sum: { 
                            $cond: [{ $eq: ['$orderStatus', 'delivered'] }, { $ifNull: ['$pricing.platformFee', 0] }, 0] 
                        } 
                    },
                    deliveryFeeTotal: { 
                        $sum: { 
                            $cond: [{ $eq: ['$orderStatus', 'delivered'] }, { $ifNull: ['$pricing.deliveryFee', 0] }, 0] 
                        } 
                    },
                    gstTotal: { 
                        $sum: { 
                            $cond: [{ $eq: ['$orderStatus', 'delivered'] }, { $ifNull: ['$pricing.tax', 0] }, 0] 
                        } 
                    },
                    adminNetProfit: { 
                        $sum: { 
                            $cond: [{ $eq: ['$orderStatus', 'delivered'] }, { $ifNull: ['$platformProfit', 0] }, 0] 
                        } 
                    }
                }
            }
        ]),
        FoodOrder.aggregate([
            {
                $match: {
                    ...orderMatch,
                    createdAt: {
                        $gte: new Date(new Date().getFullYear(), new Date().getMonth() - 11, 1),
                        $lte: new Date()
                    }
                }
            },
            {
                $group: {
                    _id: {
                        year: { $year: '$createdAt' },
                        month: { $month: '$createdAt' }
                    },
                    orders: { $sum: 1 },
                    revenue: { 
                        $sum: { 
                            $cond: [{ $eq: ['$orderStatus', 'delivered'] }, { $ifNull: ['$pricing.total', 0] }, 0] 
                        } 
                    },
                    commission: {
                        $sum: {
                            $cond: [
                                { $eq: ['$orderStatus', 'delivered'] },
                                { $ifNull: ['$platformProfit', { $ifNull: ['$pricing.platformFee', 0] }] },
                                0
                            ]
                        }
                    }
                }
            },
            { $sort: { '_id.year': 1, '_id.month': 1 } }
        ]),
        FoodRestaurant.countDocuments({ ...restaurantMatch, status: 'approved' }),
        FoodRestaurant.countDocuments({ ...restaurantMatch, status: 'pending' }),
        FoodDeliveryPartner.countDocuments({ status: 'approved' }),
        FoodDeliveryPartner.countDocuments({ status: 'pending' }),
        FoodItem.countDocuments({ approvalStatus: 'approved', ...zoneScopedRestaurantMatch }),
        FoodAddon.countDocuments({ approvalStatus: 'approved', isDeleted: { $ne: true }, ...zoneScopedRestaurantMatch }),
        zoneId
            ? FoodOrder.distinct('userId', { ...orderMatch, userId: { $ne: null } }).then((ids) => ids.length)
            : FoodUser.countDocuments({}),
        FoodRestaurant.find({ ...restaurantMatch, status: 'pending' }).sort({ createdAt: -1 }).limit(5).select('restaurantName createdAt').lean(),
        FoodDeliveryPartner.find({ status: 'pending' }).sort({ createdAt: -1 }).limit(5).select('name createdAt').lean(),
        FoodOrder.find({ 
            ...orderMatch,
            orderStatus: { $in: PENDING_ORDER_STATUSES },
        }).sort({ createdAt: -1 }).limit(5).select('orderId createdAt').lean(),
        FoodOrder.find({ ...orderMatch, orderStatus: 'delivered' }).sort({ updatedAt: -1 }).limit(5).select('orderId updatedAt').lean(),
        FoodOrder.find({ 
            ...orderMatch,
            orderStatus: { $in: CANCELLED_ORDER_STATUSES },
        }).sort({ updatedAt: -1 }).limit(5).select('orderId updatedAt').lean(),
        zoneId
            ? FoodOrder.aggregate([
                { $match: { ...orderMatch, userId: { $ne: null } } },
                { $sort: { createdAt: -1 } },
                {
                    $group: {
                        _id: '$userId',
                        createdAt: { $first: '$createdAt' }
                    }
                },
                { $sort: { createdAt: -1 } },
                { $limit: 5 },
                {
                    $lookup: {
                        from: 'food_users',
                        localField: '_id',
                        foreignField: '_id',
                        as: 'user'
                    }
                },
                { $unwind: '$user' },
                {
                    $project: {
                        _id: '$user._id',
                        name: '$user.name',
                        createdAt: 1
                    }
                }
            ])
            : FoodUser.find({}).sort({ createdAt: -1 }).limit(5).select('name createdAt').lean()
    ]);

    const liveSignals = [];
    
    (recentPendingRestaurants || []).forEach(r => {
        liveSignals.push({
            type: 'restaurant',
            title: 'New Restaurant Request',
            detail: `${r.restaurantName} is waiting for approval`,
            time: formatTimeAgo(r.createdAt),
            timestamp: r.createdAt
        });
    });

    (recentPendingDelivery || []).forEach(d => {
        liveSignals.push({
            type: 'delivery',
            title: 'New Delivery Partner',
            detail: `${d.name} requested to join`,
            time: formatTimeAgo(d.createdAt),
            timestamp: d.createdAt
        });
    });

    (recentPendingOrders || []).forEach(o => {
        liveSignals.push({
            type: 'order_pending',
            title: 'New Order Received',
            detail: `Order #${o.orderId} is pending`,
            time: formatTimeAgo(o.createdAt),
            timestamp: o.createdAt
        });
    });

    (recentDeliveredOrders || []).forEach(o => {
        liveSignals.push({
            type: 'order_delivered',
            title: 'Order Delivered',
            detail: `Order #${o.orderId} was successful`,
            time: formatTimeAgo(o.updatedAt),
            timestamp: o.updatedAt
        });
    });

    (recentCancelledOrders || []).forEach(o => {
        liveSignals.push({
            type: 'order_cancelled',
            title: 'Order Cancelled',
            detail: `Order #${o.orderId} was cancelled`,
            time: formatTimeAgo(o.updatedAt),
            timestamp: o.updatedAt
        });
    });

    (recentCustomers || []).forEach(c => {
        liveSignals.push({
            type: 'customer',
            title: 'New Customer',
            detail: `${c.name} just registered`,
            time: formatTimeAgo(c.createdAt),
            timestamp: c.createdAt
        });
    });

    // Sort by timestamp and take top 15
    liveSignals.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    const finalLiveSignals = liveSignals.slice(0, 15);

    const totals = orderTotalsAgg?.[0] || {};

    const now = new Date();
    const monthlyMap = new Map(
        (monthlyAgg || []).map((row) => {
            const key = `${row._id?.year}-${row._id?.month}`;
            return [key, row];
        })
    );

    const monthlyData = [];
    for (let i = 11; i >= 0; i -= 1) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const year = d.getFullYear();
        const month = d.getMonth() + 1;
        const key = `${year}-${month}`;
        const row = monthlyMap.get(key);
        monthlyData.push({
            month: formatMonthShort(year, month - 1),
            orders: Number(row?.orders || 0),
            revenue: Number(row?.revenue || 0),
            commission: Number(row?.commission || 0)
        });
    }

    return {
        orders: {
            total: Number(totals.totalOrders || 0),
            byStatus: {
                delivered: Number(totals.delivered || 0),
                cancelled: Number(totals.cancelled || 0),
                pending: Number(totals.pending || 0)
            }
        },
        revenue: { total: Number(totals.revenueTotal || 0) },
        commission: { total: Number(totals.commissionTotal || 0) },
        platformFee: { total: Number(totals.platformFeeTotal || 0) },
        deliveryFee: { total: Number(totals.deliveryFeeTotal || 0) },
        gst: { total: Number(totals.gstTotal || 0) },
        totalAdminEarnings: Number(totals.adminNetProfit || 0) + Number(totals.gstTotal || 0),
        deliveryProfit: Number(totals.adminNetProfit || 0) - Number(totals.commissionTotal || 0) - Number(totals.platformFeeTotal || 0),
        restaurants: {
            total: Number(restaurantsTotal || 0),
            pendingRequests: Number(restaurantsPending || 0)
        },
        deliveryBoys: {
            total: Number(deliveryTotal || 0),
            pendingRequests: Number(deliveryPending || 0)
        },
        foods: { total: Number(foodsTotal || 0) },
        addons: { total: Number(addonsTotal || 0) },
        customers: { total: Number(customersTotal || 0) },
        orderStats: {
            pending: Number(totals.pending || 0),
            completed: Number(totals.delivered || 0)
        },
        monthlyData,
        liveSignals: finalLiveSignals
    };
}

function formatTimeAgo(date) {
    if (!date) return '';
    const seconds = Math.floor((new Date() - new Date(date)) / 1000);
    let interval = seconds / 31536000;
    if (interval > 1) return Math.floor(interval) + ' years ago';
    interval = seconds / 2592000;
    if (interval > 1) return Math.floor(interval) + ' months ago';
    interval = seconds / 86400;
    if (interval > 1) return Math.floor(interval) + ' days ago';
    interval = seconds / 3600;
    if (interval > 1) return Math.floor(interval) + ' hours ago';
    interval = seconds / 60;
    if (interval > 1) return Math.floor(interval) + ' minutes ago';
    return Math.floor(seconds) + ' seconds ago';
}


export async function getTransactionReport(query = {}) {
    const { fromDate, toDate, zone, restaurant, search } = query;
    const match = {};

    if (fromDate && toDate) {
        match.createdAt = { $gte: new Date(fromDate), $lte: new Date(toDate) };
    }

    if (search) {
        const searchRegex = new RegExp(String(search).trim(), "i");
        const matchingOrders = await FoodOrder.find({ orderId: { $regex: searchRegex } })
            .select('_id')
            .lean();

        match.$or = [
            { orderReadableId: { $regex: searchRegex } },
            { orderId: { $in: matchingOrders.map((order) => order._id) } }
        ];
    }

    if (zone || restaurant) {
        const restFilter = {};

        if (zone) {
            const zoneRaw = String(zone).trim();
            if (zoneRaw) {
                if (mongoose.Types.ObjectId.isValid(zoneRaw)) {
                    restFilter.zoneId = new mongoose.Types.ObjectId(zoneRaw);
                } else {
                    const matchedZone = await FoodZone.findOne({
                        $or: [{ name: zoneRaw }, { zoneName: zoneRaw }]
                    })
                        .select('_id')
                        .lean();
                    if (matchedZone?._id) {
                        restFilter.zoneId = matchedZone._id;
                    } else {
                        match.restaurantId = { $in: [] };
                    }
                }
            }
        }

        if (restaurant && restaurant !== 'All restaurants') {
            const restaurantRaw = String(restaurant).trim();
            if (restaurantRaw) {
                let restDoc = null;
                if (mongoose.Types.ObjectId.isValid(restaurantRaw)) {
                    restDoc = await mongoose
                        .model('FoodRestaurant')
                        .findById(restaurantRaw)
                        .select('_id')
                        .lean();
                } else {
                    restDoc = await mongoose.model('FoodRestaurant').findOne({
                        $or: [{ restaurantName: restaurantRaw }, { name: restaurantRaw }]
                    })
                        .select('_id')
                        .lean();
                }
                if (restDoc?._id) {
                    restFilter._id = restDoc._id;
                } else {
                    match.restaurantId = { $in: [] };
                }
            }
        }

        if (!match.restaurantId && Object.keys(restFilter).length > 0) {
            const restaurantsList = await mongoose
                .model('FoodRestaurant')
                .find(restFilter)
                .select('_id')
                .lean();
            match.restaurantId = { $in: restaurantsList.map((r) => r._id) };
        }
    }

    // Include only resolved transactions for reports (or all to match orders)
    // We will query the FoodTransaction table directly as it is the ledger
    const transactionRows = await FoodTransaction.find(match)
        .populate('orderId')
        .populate('userId', 'name')
        .populate('restaurantId', 'restaurantName')
        .sort({ createdAt: -1 })
        .lean();

    const transactions = transactionRows.map((tx) => {
        const order = tx.orderId || {};
        const pricing = order.pricing || {};
        const subtotal = Number(pricing.subtotal || 0) || 0;
        const packagingFee = Number(pricing.packagingFee || 0) || 0;
        const deliveryFee = Number(pricing.deliveryFee || 0) || 0;
        const tax = Number(pricing.tax || 0) || 0;
        const discount = Number(pricing.discount || 0) || 0;
        const total = Number(pricing.total || 0) || 0;

        // "Platform fee" should come from pricing.platformFee when available.
        // For older orders where pricing.platformFee isn't stored, derive it from the pricing equation:
        // total = subtotal + packagingFee + deliveryFee + platformFee + tax - discount
        const platformFeeDerived = Math.max(
            0,
            total - subtotal - packagingFee - deliveryFee - tax + discount
        );
        const platformFee =
            pricing.platformFee !== undefined && pricing.platformFee !== null
                ? Number(pricing.platformFee || 0) || 0
                : platformFeeDerived;
        return {
            id: tx._id,
            orderId: tx.orderReadableId || order.orderId || 'N/A',
            restaurant: tx.restaurantId?.restaurantName || 'N/A',
            customerName: tx.userId?.name || 'Guest',
            totalItemAmount: subtotal,
            itemDiscount: pricing.discount || 0,
            couponDiscount: pricing.discount || 0,
            adminDiscountShare: Number(tx.amounts?.adminDiscountShare || 0),
            restaurantDiscountShare: Number(tx.amounts?.restaurantDiscountShare || 0),
            referralDiscount: 0, // Placeholder
            discountedAmount: Math.max(0, (pricing.subtotal || 0) - (pricing.discount || 0)),
            vatTax: tx.amounts?.taxAmount || pricing.tax || 0,
            deliveryCharge: pricing.deliveryFee || 0,
            platformFee,
            orderAmount: tx.amounts?.totalCustomerPaid || pricing.total || 0,
            status: tx.status
        };
    });

    let completedTransaction = 0;
    let refundedTransaction = 0;
    let adminEarning = 0;
    let restaurantEarning = 0;
    let deliverymanEarning = 0;

    for (const tx of transactionRows) {
        // Calculate Summary
        if (tx.status === 'captured' || tx.status === 'settled' || (tx.orderId && tx.orderId.orderStatus === 'delivered')) {
            completedTransaction += tx.amounts?.totalCustomerPaid || 0;
            adminEarning += tx.amounts?.platformNetProfit || 0;
            restaurantEarning += tx.amounts?.restaurantShare || 0;
            deliverymanEarning += tx.amounts?.riderShare || 0;
        }
        if (tx.status === 'refunded' || (tx.orderId && tx.orderId.orderStatus === 'cancelled_by_admin')) {
            // Count number of refunded transactions according to old logic or sum them
            refundedTransaction += tx.amounts?.totalCustomerPaid || 0;
        }
    }

    const summary = {
        completedTransaction,
        refundedTransaction, // Returning amount instead of count for consistency, frontend might expect count though
        adminEarning,
        restaurantEarning,
        deliverymanEarning,
    };

    return { transactions, summary };
}

export async function getRestaurantReport(query = {}) {
    const parseTimeRange = (timeLabel) => {
        const now = new Date();
        const start = new Date(now);
        const end = new Date(now);

        const value = String(timeLabel || '').trim().toLowerCase();
        if (!value || value === 'all time') return null;

        if (value === 'today') {
            start.setHours(0, 0, 0, 0);
            end.setHours(23, 59, 59, 999);
            return { $gte: start, $lte: end };
        }

        if (value === 'this week') {
            const day = start.getDay(); // 0=Sun
            const diffToMonday = day === 0 ? 6 : day - 1;
            start.setDate(start.getDate() - diffToMonday);
            start.setHours(0, 0, 0, 0);
            end.setHours(23, 59, 59, 999);
            return { $gte: start, $lte: end };
        }

        if (value === 'this month') {
            start.setDate(1);
            start.setHours(0, 0, 0, 0);
            end.setHours(23, 59, 59, 999);
            return { $gte: start, $lte: end };
        }

        if (value === 'this year') {
            start.setMonth(0, 1);
            start.setHours(0, 0, 0, 0);
            end.setHours(23, 59, 59, 999);
            return { $gte: start, $lte: end };
        }

        return null;
    };

    const formatCurrency = (value) => `\u20B9${Number(value || 0).toFixed(2)}`;

    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 1000, 1), 5000);
    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    const skip = (page - 1) * limit;

    const restaurantFilter = {};
    const allFilter = String(query.all || '').trim().toLowerCase();
    if (allFilter === 'active') {
        restaurantFilter.status = 'approved';
    } else if (allFilter === 'inactive') {
        restaurantFilter.status = { $ne: 'approved' };
    }

    const zoneRaw = String(query.zone || '').trim();
    if (zoneRaw) {
        if (mongoose.Types.ObjectId.isValid(zoneRaw)) {
            restaurantFilter.zoneId = new mongoose.Types.ObjectId(zoneRaw);
        } else {
            const matchedZone = await FoodZone.findOne({
                $or: [{ name: zoneRaw }, { zoneName: zoneRaw }]
            })
                .select('_id')
                .lean();
            if (matchedZone?._id) {
                restaurantFilter.zoneId = matchedZone._id;
            } else {
                return { restaurants: [], total: 0, page, limit };
            }
        }
    }

    const typeRaw = String(query.type || '').trim().toLowerCase();
    if (typeRaw === 'commission') {
        const commissionRows = await FoodRestaurantCommission.find({ status: { $ne: false } })
            .select('restaurantId')
            .lean();
        const commissionRestaurantIds = commissionRows
            .map((row) => row?.restaurantId)
            .filter((id) => mongoose.Types.ObjectId.isValid(id))
            .map((id) => new mongoose.Types.ObjectId(id));

        if (!commissionRestaurantIds.length) {
            return { restaurants: [], total: 0, page, limit };
        }
        restaurantFilter._id = { $in: commissionRestaurantIds };
    }

    const searchRaw = String(query.search || '').trim();
    if (searchRaw) {
        const escaped = searchRaw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        restaurantFilter.$or = [
            { restaurantName: { $regex: escaped, $options: 'i' } },
            { ownerName: { $regex: escaped, $options: 'i' } },
            { ownerPhone: { $regex: escaped, $options: 'i' } },
            { city: { $regex: escaped, $options: 'i' } },
            { area: { $regex: escaped, $options: 'i' } }
        ];
    }

    const [restaurantDocs, total] = await Promise.all([
        FoodRestaurant.find(restaurantFilter)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .select('restaurantName profileImage rating totalRatings status zoneId')
            .populate('zoneId', 'name zoneName')
            .lean(),
        FoodRestaurant.countDocuments(restaurantFilter)
    ]);

    const restaurantIds = restaurantDocs.map((r) => r._id).filter(Boolean);
    if (!restaurantIds.length) {
        return { restaurants: [], total, page, limit };
    }

    const orderCreatedAtFilter = (() => {
        if (query.fromDate || query.toDate) {
            const createdAt = {};
            if (query.fromDate) {
                createdAt.$gte = new Date(query.fromDate);
            }
            if (query.toDate) {
                createdAt.$lte = new Date(query.toDate);
            }
            return Object.keys(createdAt).length ? createdAt : null;
        }
        return parseTimeRange(query.time);
    })();
    const orderMatch = {
        restaurantId: { $in: restaurantIds },
        $or: [
            { "payment.method": { $in: ["cash", "wallet"] } },
            { "payment.status": { $in: ["paid", "authorized", "captured", "settled", "refunded"] } },
        ],
    };
    if (orderCreatedAtFilter) {
        orderMatch.createdAt = orderCreatedAtFilter;
    }

    const [foodsAgg, ordersAgg] = await Promise.all([
        FoodItem.aggregate([
            {
                $match: {
                    restaurantId: { $in: restaurantIds },
                    approvalStatus: 'approved'
                }
            },
            {
                $group: {
                    _id: '$restaurantId',
                    totalFood: { $sum: 1 }
                }
            }
        ]),
        FoodOrder.aggregate([
            { $match: orderMatch },
            {
                $group: {
                    _id: '$restaurantId',
                    totalOrder: { $sum: 1 },
                    totalOrderAmount: { $sum: { $ifNull: ['$pricing.total', 0] } },
                    totalDiscountGiven: { $sum: { $ifNull: ['$pricing.discount', 0] } },
                    totalVATTAX: { $sum: { $ifNull: ['$pricing.tax', 0] } },
                    totalAdminCommissionFromPlatformProfit: { $sum: { $ifNull: ['$platformProfit', 0] } },
                    totalAdminCommissionFromPlatformFee: { $sum: { $ifNull: ['$pricing.platformFee', 0] } }
                }
            }
        ])
    ]);

    const foodMap = new Map(foodsAgg.map((x) => [String(x._id), Number(x.totalFood || 0)]));
    const orderMap = new Map(
        ordersAgg.map((x) => [
            String(x._id),
            {
                totalOrder: Number(x.totalOrder || 0),
                totalOrderAmount: Number(x.totalOrderAmount || 0),
                totalDiscountGiven: Number(x.totalDiscountGiven || 0),
                totalVATTAX: Number(x.totalVATTAX || 0),
                totalAdminCommission:
                    Number(x.totalAdminCommissionFromPlatformProfit || 0) > 0
                        ? Number(x.totalAdminCommissionFromPlatformProfit || 0)
                        : Number(x.totalAdminCommissionFromPlatformFee || 0)
            }
        ])
    );

    const restaurants = restaurantDocs.map((restaurant, index) => {
        const key = String(restaurant._id);
        const counts = orderMap.get(key) || {
            totalOrder: 0,
            totalOrderAmount: 0,
            totalDiscountGiven: 0,
            totalVATTAX: 0,
            totalAdminCommission: 0
        };

        return {
            _id: restaurant._id,
            sl: skip + index + 1,
            icon: restaurant.profileImage || '',
            restaurantName: restaurant.restaurantName || '',
            totalFood: foodMap.get(key) || 0,
            totalOrder: counts.totalOrder,
            totalOrderAmount: formatCurrency(counts.totalOrderAmount),
            totalDiscountGiven: formatCurrency(counts.totalDiscountGiven),
            totalAdminCommission: formatCurrency(counts.totalAdminCommission),
            totalVATTAX: formatCurrency(counts.totalVATTAX),
            averageRatings: Number(restaurant.rating || 0),
            reviews: Number(restaurant.totalRatings || 0),
            status: restaurant.status || 'pending',
            zoneName: restaurant.zoneId?.name || restaurant.zoneId?.zoneName || ''
        };
    });

    return { restaurants, total, page, limit };
}

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
        const earnings = computeRestaurantOrderShare(order, tx, offers, restaurantId);
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
            const earnings = computeRestaurantOrderShare(order, tx, offers, restaurantId);
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
    const getOrderFromRow = (row) => (row?.orderId && typeof row.orderId === 'object' ? row.orderId : row);
    const getDiscountShares = (row) => {
        const pricing = getPricing(row);
        const amounts = row?.amounts || {};
        const order = getOrderFromRow(row);
        return resolveDiscountSplit({
            order,
            pricing,
            amounts,
            offers: relevantOffers,
            restaurantId: rId,
        });
    };

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


export async function getSidebarBadges() {
    try {
        const [
            pendingRestaurants,
            pendingDeliveryPartners,
            pendingFoods,
            pendingAddons,
            pendingOrders,
            pendingOfflinePayments,
            pendingRestaurantWithdrawals,
            pendingDeliveryWithdrawals,
            openUserSupportTickets,
            openDeliverySupportTickets,
            pendingEarningAddons,
            pendingSafetyReports,
            pendingEmergencyHelp,
            pendingRestaurantComplaints
        ] = await Promise.all([
            FoodRestaurant.countDocuments({ status: 'pending' }),
            FoodDeliveryPartner.countDocuments({ status: 'pending' }),
            FoodItem.countDocuments({ approvalStatus: 'pending' }),
            FoodAddon.countDocuments({ approvalStatus: 'pending' }),
            FoodOrder.countDocuments({ orderStatus: 'pending' }),
            FoodOrder.countDocuments({ paymentMethod: 'offline_payment', orderStatus: 'pending' }),
            FoodRestaurantWithdrawal.countDocuments({ status: 'pending' }),
            FoodDeliveryWithdrawal.countDocuments({ status: 'pending' }),
            FoodSupportTicket.countDocuments({ status: 'open', userId: { $exists: true }, restaurantId: { $exists: false } }),
            DeliverySupportTicket.countDocuments({ status: 'open' }),
            FoodEarningAddonHistory.countDocuments({ status: 'pending' }),
            FoodSafetyEmergencyReport.countDocuments({ status: 'pending' }),
            FoodDeliveryEmergencyHelp.countDocuments({ status: 'pending' }),
            FoodSupportTicket.countDocuments({ status: 'open', restaurantId: { $exists: true } })
        ]);

        return {
            restaurants: pendingRestaurants,
            deliveryPartners: pendingDeliveryPartners,
            foods: pendingFoods + pendingAddons,
            foodApprovals: pendingFoods,
            orders: pendingOrders,
            offlinePayments: pendingOfflinePayments,
            restaurantWithdrawals: pendingRestaurantWithdrawals,
            deliveryWithdrawals: pendingDeliveryWithdrawals,
            userSupportTickets: openUserSupportTickets,
            deliverySupportTickets: openDeliverySupportTickets,
            earningAddons: pendingEarningAddons,
            safetyReports: pendingSafetyReports,
            emergencyHelp: pendingEmergencyHelp,
            restaurantComplaints: pendingRestaurantComplaints
        };
    } catch (error) {
        console.error('Error fetching sidebar badges:', error);
        return {};
    }
}


