import { prisma } from '../../../../config/prisma.js';
import { toOrder, toOrders, fromOrder, orderInclude } from '../order.mapper.js';
import { logger } from '../../../../utils/logger.js';
import { ValidationError, ForbiddenError, NotFoundError } from '../../../../core/auth/errors.js';
import { buildPaginationOptions, buildPaginatedResult, isId } from '../../../../utils/helpers.js';
import {
    createRazorpayOrder,
    verifyPaymentSignature,
    getRazorpayKeyId,
    isRazorpayConfigured,
    initiateRazorpayRefund,
    fetchRazorpayPayment
} from '../helpers/razorpay.helper.js';
import { getIO, rooms } from '../../../../config/socket.js';
import { addOrderJob } from '../../../../queues/producers/order.producer.js';
import { getFirebaseDB } from '../../../../config/firebase.js';
import * as foodTransactionService from './foodTransaction.service.js';
import * as userWalletService from '../../user/services/userWallet.service.js';
import {
  calculateOrderPricing,
  calculateRiderEarning,
  getDeliveryDistanceKm,
  loadActiveFeeSettings,
  loadRestaurantForOrdering,
  assertRestaurantOpenForOrdering,
} from './order-pricing.service.js';
import { normalizeDeliveryAddress } from '../../shared/geo.utils.js';
import * as dispatchService from './order-dispatch.service.js';
import * as deliveryService from './order-delivery.service.js';
import * as paymentService from './order-payment.service.js';
import {
  enqueueOrderEvent,
  sanitizeOrderForExternal,
  sanitizeOrderForDeliveryPartner,
  notifyOwnersSafely,
  buildOrderIdentityFilter,
  pushStatusHistory,
  normalizeOrderForClient,
  applyAggregateRating,
  buildDeliverySocketPayload,
  notifyRestaurantNewOrder,
  canExposeOrderToRestaurant,
  isStatusAdvance,
  STATUS_PRIORITY,
} from './order.helpers.js';

const ORDER_ACCEPTANCE_WINDOW_SECONDS = 240;
const PENDING_PAYMENT_TTL_MS = 30 * 60 * 1000;

/** Projections that replace the old `.populate(path, fields)` calls. */
const RESTAURANT_CARD = {
  id: true, restaurantName: true, profileImage: true, area: true, city: true,
  latitude: true, longitude: true, rating: true, totalRatings: true,
};
const RESTAURANT_DETAIL = { ...RESTAURANT_CARD, ownerPhone: true, primaryContactNumber: true };
const RESTAURANT_ADMIN = {
  id: true, restaurantName: true, area: true, city: true, ownerPhone: true, zoneId: true,
};
const PARTNER_CARD = {
  id: true, name: true, phone: true, rating: true, totalRatings: true, profilePhoto: true,
  vehicleType: true, vehicleName: true, vehicleNumber: true, totalDeliveries: true,
};
const PARTNER_WITH_LOCATION = {
  ...PARTNER_CARD, lastLat: true, lastLng: true, lastLocationAt: true,
};
const USER_CARD = { id: true, name: true, phone: true, email: true };

const withRelations = (restaurant = RESTAURANT_CARD, partner = PARTNER_CARD, user = USER_CARD) => ({
  ...orderInclude,
  restaurant: { select: restaurant },
  deliveryPartner: { select: partner },
  user: { select: user },
});

/** Validates an id's shape, replacing the old toObjectId() cast. */
function requireId(id, fieldName = 'ID') {
  if (!id) return null;
  if (!isId(id)) throw new ValidationError(`Invalid ${fieldName} format`);
  return String(id);
}

function normalizeAcceptanceWindowSeconds(minutes) {
  const numeric = Number(minutes);
  if (!Number.isFinite(numeric)) return ORDER_ACCEPTANCE_WINDOW_SECONDS;
  const roundedMinutes = Math.round(numeric);
  if (roundedMinutes < 1 || roundedMinutes > 20) return ORDER_ACCEPTANCE_WINDOW_SECONDS;
  return roundedMinutes * 60;
}

async function getOrderAcceptanceWindowSeconds() {
  try {
    const settings = await prisma.foodBusinessSettings.findFirst({
      select: { orderAcceptanceTimeMinutes: true },
    });
    return normalizeAcceptanceWindowSeconds(settings?.orderAcceptanceTimeMinutes);
  } catch (err) {
    logger.warn(`Failed to load order acceptance setting: ${err?.message || err}`);
    return ORDER_ACCEPTANCE_WINDOW_SECONDS;
  }
}

function isAwaitingOnlinePaymentMethod(paymentMethod) {
  const method = String(paymentMethod || "").toLowerCase();
  return method === "razorpay" || method === "card";
}

function buildAcceptanceDeadline(date = new Date(), windowSeconds = ORDER_ACCEPTANCE_WINDOW_SECONDS) {
  const seconds = Number(windowSeconds);
  return new Date(date.getTime() + (Number.isFinite(seconds) && seconds > 0 ? seconds : ORDER_ACCEPTANCE_WINDOW_SECONDS) * 1000);
}

// ----- Order deletion -----

/**
 * Remove an order and everything that cannot outlive it.
 *
 * Mongo simply deleted the document; Postgres has real foreign keys, so the
 * dependants have to be dealt with explicitly. Ledger rows are DETACHED rather
 * than deleted — money records must survive the order they refer to, or a
 * deleted order silently erases its own wallet history.
 */
async function purgeOrder(orderId) {
  const id = String(orderId);
  await prisma.$transaction([
    prisma.foodSupportTicket.updateMany({ where: { orderId: id }, data: { orderId: null } }),
    prisma.transaction.updateMany({ where: { orderId: id }, data: { orderId: null } }),
    prisma.foodChatMessage.updateMany({ where: { orderId: id }, data: { orderId: null } }),
    prisma.foodChatConversation.updateMany({ where: { orderId: id }, data: { orderId: null } }),
    prisma.deliveryOrderEmergencyRequest.deleteMany({ where: { orderId: id } }),
    prisma.refund.deleteMany({ where: { orderId: id } }),
    prisma.payment.deleteMany({ where: { orderId: id } }),
    prisma.foodTransaction.deleteMany({ where: { orderId: id } }),
    // items, itemRatings, statusHistory and dispatchOffers cascade.
    prisma.foodOrder.delete({ where: { id } }),
  ]);
}

async function deletePendingPaymentOrder(orderLike) {
  const id = orderLike?.id || orderLike?._id;
  if (!id) return false;
  if (String(orderLike.orderStatus || "").toLowerCase() !== "pending_payment") return false;

  const payStatus = String(orderLike.payment?.status || orderLike.paymentStatus || "").toLowerCase();
  if (payStatus === "paid" || payStatus === "refunded") return false;

  await purgeOrder(id);
  return true;
}

let lastExpiredCleanupAt = 0;
const EXPIRE_CLEANUP_INTERVAL_MS = 60_000;

async function expireStalePendingPaymentOrders() {
  const now = Date.now();
  if (now - lastExpiredCleanupAt < EXPIRE_CLEANUP_INTERVAL_MS) return;
  lastExpiredCleanupAt = now;

  const cutoff = new Date(Date.now() - PENDING_PAYMENT_TTL_MS);
  const stale = await prisma.foodOrder.findMany({
    where: {
      orderStatus: "pending_payment",
      // 'failed' covers orders rejected by payment amount verification.
      paymentStatus: { in: ["created", "pending", "failed"] },
      createdAt: { lte: cutoff },
    },
    select: { id: true, orderStatus: true, paymentStatus: true },
  });

  for (const doc of stale) {
    try {
      await deletePendingPaymentOrder(doc);
    } catch (err) {
      logger.warn(
        `expireStalePendingPaymentOrders cleanup failed for ${doc.id}: ${err?.message || err}`,
      );
    }
  }
}

// ----- Refunds -----

function buildCancellationRefundDescription(order, cancelledBy = 'system') {
  const orderReadableId = order?.order_id || order?.id || order?._id;
  switch (String(cancelledBy || '').toLowerCase()) {
    case 'user':
      return `Refund for cancelled order #${orderReadableId}`;
    case 'restaurant':
      return `Refund for order #${orderReadableId} cancelled by restaurant`;
    case 'admin':
      return `Refund for order #${orderReadableId} cancelled by admin`;
    case 'auto_cancel':
    case 'timeout':
    case 'system':
      return `Refund for order #${orderReadableId} auto-cancelled by system`;
    default:
      return `Refund for cancelled order #${orderReadableId}`;
  }
}

/**
 * Decide and perform the refund for a cancelled order.
 *
 * Returns a `paymentPatch` of flat columns instead of mutating the order, which
 * is what the Mongoose version did before the caller ran `order.save()`. Callers
 * merge the patch into their own update so the status change and the refund land
 * in one write.
 */
async function applyCancellationRefund(order, { cancelledBy = 'system', refundAmount } = {}) {
  const none = (extra) => ({ attempted: false, processed: false, paymentPatch: {}, ...extra });

  if (!order?.payment) return none({ reason: 'missing_payment' });

  const paymentMethod = String(order.payment?.method || 'cash').toLowerCase();
  const paymentStatus = String(order.payment?.status || 'cod_pending').toLowerCase();
  const refundStatus = String(order.payment?.refund?.status || 'none').toLowerCase();
  const amount = Number(refundAmount ?? order?.pricing?.total ?? order?.payment?.amountDue ?? 0);

  if (!Number.isFinite(amount) || amount <= 0) return none({ reason: 'invalid_amount' });
  if (paymentMethod === 'cash' || paymentMethod === 'cod') return none({ reason: 'cash_payment' });

  if (paymentStatus === 'refunded' || refundStatus === 'processed') {
    return none({ processed: true, reason: 'already_refunded', method: paymentMethod });
  }
  if (paymentStatus !== 'paid') {
    return none({ reason: `payment_status_${paymentStatus || 'unknown'}`, method: paymentMethod });
  }

  if (paymentMethod === 'razorpay') {
    const paymentId = String(order.payment?.razorpay?.paymentId || '').trim();
    if (!paymentId) {
      return {
        attempted: true, processed: false, method: paymentMethod,
        reason: 'missing_razorpay_payment_id',
        paymentPatch: { refundStatus: 'failed', refundAmount: amount },
      };
    }

    const refundResult = await initiateRazorpayRefund(paymentId, amount);
    if (refundResult.success) {
      return {
        attempted: true, processed: true, method: paymentMethod, refundId: refundResult.refundId,
        paymentPatch: {
          paymentStatus: 'refunded',
          refundStatus: 'processed',
          refundAmount: amount,
          refundId: refundResult.refundId,
          refundProcessedAt: new Date(),
        },
      };
    }

    return {
      attempted: true, processed: false, method: paymentMethod,
      reason: refundResult.error || 'razorpay_refund_failed',
      paymentPatch: { refundStatus: 'failed', refundAmount: amount },
    };
  }

  if (paymentMethod === 'wallet') {
    await userWalletService.refundWalletBalance(
      order.userId?.id ?? order.userId,
      amount,
      buildCancellationRefundDescription(order, cancelledBy),
      { orderId: order.id ?? order._id, cancelledBy }
    );
    return {
      attempted: true, processed: true, method: paymentMethod,
      paymentPatch: {
        paymentStatus: 'refunded',
        refundStatus: 'processed',
        refundAmount: amount,
        refundProcessedAt: new Date(),
      },
    };
  }

  return none({ reason: `unsupported_method_${paymentMethod}`, method: paymentMethod });
}

// ----- Acceptance window expiry -----

async function expireUnacceptedOrders(where = {}) {
  const now = new Date();
  const baseWhere = {
    orderStatus: { in: ["created", "confirmed"] },
    acceptanceDeadlineAt: { not: null, lte: now },
    ...where,
  };

  const docs = await prisma.foodOrder.findMany({
    where: baseWhere,
    select: { id: true, orderStatus: true },
  });
  if (!docs.length) return 0;

  for (const doc of docs) {
    const from = String(doc.orderStatus || "created");

    // The status guard lives in the WHERE clause so a restaurant accepting in
    // this same moment wins rather than being overwritten by the sweep.
    const { count } = await prisma.foodOrder.updateMany({
      where: {
        id: doc.id,
        orderStatus: { in: ["created", "confirmed"] },
        acceptanceDeadlineAt: { not: null, lte: now },
      },
      data: { orderStatus: "cancelled_by_restaurant", note: "Not accepted by restaurant" },
    });
    if (count === 0) continue;

    await pushStatusHistory(doc.id, {
      byRole: "SYSTEM",
      from,
      to: "cancelled_by_restaurant",
      note: "Not accepted by restaurant",
    });

    const updated = toOrder(
      await prisma.foodOrder.findUnique({ where: { id: doc.id }, include: orderInclude }),
    );

    try {
      const refund = await applyCancellationRefund(updated, { cancelledBy: 'auto_cancel' });
      if (Object.keys(refund.paymentPatch).length > 0) {
        await prisma.foodOrder.update({ where: { id: doc.id }, data: refund.paymentPatch });
      }
    } catch (err) {
      logger.warn(`expireUnacceptedOrders refund failed for ${doc.id}: ${err?.message || err}`);
    }

    try {
      const io = getIO();
      if (io) {
        const payload = {
          orderMongoId: doc.id,
          orderId: doc.id,
          orderStatus: "cancelled_by_restaurant",
          note: "Not accepted by restaurant",
          message: "Order was not accepted by restaurant in time.",
        };
        io.to(rooms.user(updated.userId)).emit("order_status_update", payload);
        io.to(rooms.restaurant(updated.restaurantId)).emit("order_status_update", payload);
      }
    } catch (err) {
      logger.warn(`expireUnacceptedOrders socket emit failed: ${err?.message || err}`);
    }
  }

  return docs.length;
}

export async function expireUnacceptedOrderById(orderMongoId) {
  if (!isId(orderMongoId)) return 0;
  return expireUnacceptedOrders({ id: String(orderMongoId) });
}

// ----- Settings -----
export async function getDispatchSettings() {
  return dispatchService.getDispatchSettings();
}

export async function updateDispatchSettings(dispatchMode, adminId) {
  return dispatchService.updateDispatchSettings(dispatchMode, adminId);
}

// ----- Calculate (validation + return pricing from payload) -----
export async function calculateOrder(userId, dto) {
  const at = dto.scheduledAt ? new Date(dto.scheduledAt) : new Date();
  return calculateOrderPricing(userId, dto, {
    at: Number.isNaN(at.getTime()) ? new Date() : at,
  });
}

// ----- Coupons -----

async function incrementCouponUsageForOrder(order, userId) {
  const couponCode = order?.pricing?.couponCode
    ? String(order.pricing.couponCode).trim().toUpperCase()
    : "";
  if (!couponCode) return;
  // A stored code with no applied discount means the coupon was rejected at
  // pricing time — don't consume the user's/offer's usage allowance for it.
  if (!(Number(order?.pricing?.discount) > 0)) return;

  try {
    const offer = await prisma.foodOffer.findUnique({ where: { couponCode } });
    if (!offer) return;

    // Conditional increment so concurrent orders cannot push usedCount past usageLimit.
    const { count } = await prisma.foodOffer.updateMany({
      where: {
        id: offer.id,
        OR: [{ usageLimit: null }, { usageLimit: 0 }, { usedCount: { lt: offer.usageLimit ?? 0 } }],
      },
      data: { usedCount: { increment: 1 } },
    });
    if (count === 0 && Number(offer.usageLimit) > 0) {
      // Payment is already processed at this point, so honour the discount but flag the overflow.
      logger.warn(
        `Coupon ${couponCode} reached usage limit before increment for order ${order?.id}; discount honored.`,
      );
    }

    await prisma.foodOfferUsage.upsert({
      where: { offerId_userId: { offerId: offer.id, userId: String(userId) } },
      create: { offerId: offer.id, userId: String(userId), count: 1, lastUsedAt: new Date() },
      update: { count: { increment: 1 }, lastUsedAt: new Date() },
    });
  } catch (err) {
    logger.error(`Coupon usage update failed: ${err.message}`);
  }
}

// ----- Create order -----

/**
 * "FOD-" + 6 timestamp digits + 4 random.
 *
 * Was a pre('save') hook that probed the collection for collisions; the unique
 * index does that job here, so a clash just retries. The old 4+3 format collided
 * after a few thousand orders and made display-id lookups match the wrong order.
 */
function buildOrderDisplayId(entropyDigits = 4) {
  const timestamp = Date.now().toString().slice(-6);
  const floor = 10 ** (entropyDigits - 1);
  const random = Math.floor(floor + Math.random() * (floor * 9));
  return `FOD-${timestamp}${random}`;
}

async function createOrderRow(data) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    // Widen the random part on later attempts rather than retrying the same odds.
    const displayId = buildOrderDisplayId(attempt < 3 ? 4 : 8);
    try {
      return await prisma.foodOrder.create({
        data: { ...data, order_id: displayId, orderId: displayId },
        include: orderInclude,
      });
    } catch (err) {
      // P2002 here can only be the display id — nothing else in `data` is unique.
      if (err?.code === 'P2002') continue;
      throw err;
    }
  }
  throw new ValidationError('Could not allocate an order id. Please try again.');
}

export async function createOrder(userId, dto) {
  try {
    const restaurantId = requireId(dto.restaurantId, 'Restaurant ID');
    const restaurant = await loadRestaurantForOrdering(restaurantId);

    const orderAt = dto.scheduledAt ? new Date(dto.scheduledAt) : new Date();
    if (dto.scheduledAt && Number.isNaN(orderAt.getTime())) {
      throw new ValidationError('Invalid scheduled time');
    }
    assertRestaurantOpenForOrdering(restaurant, orderAt);

    const settings = await getDispatchSettings();
    const dispatchMode = settings.dispatchMode;

    const deliveryAddress = normalizeDeliveryAddress({
      label: dto.address?.label || "Home",
      name: dto.address?.name || dto.address?.fullName || dto.customerName || "",
      fullName: dto.address?.fullName || dto.address?.name || dto.customerName || "",
      street: dto.address?.street || "",
      additionalDetails: dto.address?.additionalDetails || "",
      city: dto.address?.city || "",
      state: dto.address?.state || "",
      zipCode: dto.address?.zipCode || "",
      phone: dto.address?.phone || "",
      ...(dto.address || {}),
    });

    const paymentMethod = dto.paymentMethod === "card" ? "razorpay" : dto.paymentMethod;
    // COD was hard-disabled here. It is back on by default and kept behind a switch
    // so it can be turned off again without a deploy — everything downstream already
    // supports it.
    if (paymentMethod === "cash" && String(process.env.COD_ENABLED || "true") !== "true") {
      throw new ValidationError("Cash on Delivery is no longer available. Please pay online.");
    }
    const isCash = paymentMethod === "cash";
    const isWallet = paymentMethod === "wallet";

    const pricingResult = await calculateOrderPricing(
      userId,
      {
        restaurantId,
        items: dto.items || [],
        deliveryAddress,
        couponCode: dto.pricing?.couponCode || undefined,
        deliveryMode: dto.deliveryMode || "basic",
      },
      { at: orderAt, restaurant, skipAvailabilityCheck: true },
    );

    const resolvedItems = pricingResult.items || [];
    const normalizedPricing = {
      subtotal: Number(pricingResult.pricing?.subtotal) || 0,
      tax: Number(pricingResult.pricing?.tax) || 0,
      packagingFee: Number(pricingResult.pricing?.packagingFee) || 0,
      deliveryFee: Number(pricingResult.pricing?.deliveryFee) || 0,
      deliveryFeeGst: Number(pricingResult.pricing?.deliveryFeeGst) || 0,
      platformFee: Number(pricingResult.pricing?.platformFee) || 0,
      quickDeliveryFee: Number(pricingResult.pricing?.quickDeliveryFee) || 0,
      deliveryMode:
        pricingResult.pricing?.deliveryMode === "quick" || dto.deliveryMode === "quick"
          ? "quick"
          : "basic",
      discount: Number(pricingResult.pricing?.discount) || 0,
      couponCode: pricingResult.pricing?.couponCode
        ? String(pricingResult.pricing.couponCode).trim().toUpperCase()
        : null,
      total: Number(pricingResult.pricing?.total) || 0,
      currency: String(pricingResult.pricing?.currency || "INR"),
      distanceKm: Number.isFinite(Number(pricingResult.pricing?.distanceKm))
        ? Number(pricingResult.pricing.distanceKm)
        : null,
      roadDistanceKm: Number.isFinite(Number(pricingResult.pricing?.roadDistanceKm))
        ? Number(pricingResult.pricing.roadDistanceKm)
        : null,
    };

    if (!Number.isFinite(normalizedPricing.total) || normalizedPricing.total <= 0) {
      throw new ValidationError("Order total must be greater than zero");
    }
    normalizedPricing.total = Math.round(normalizedPricing.total * 100) / 100;

    const payment = {
      method: paymentMethod,
      status: isCash ? "cod_pending" : isWallet ? "paid" : "created",
      amountDue: normalizedPricing.total || 0,
      razorpay: {},
      qr: {},
    };

    // Reuse the pricing distance (already road-preferred) — do not call Directions again.
    let distanceKm = Number.isFinite(Number(normalizedPricing.distanceKm))
      ? Number(normalizedPricing.distanceKm)
      : await getDeliveryDistanceKm(restaurant, deliveryAddress);
    distanceKm = Number.isFinite(distanceKm) ? Number(distanceKm.toFixed(2)) : null;
    if (Number.isFinite(distanceKm)) {
      normalizedPricing.distanceKm = distanceKm;
      normalizedPricing.roadDistanceKm = distanceKm;
    }

    const feeSettings = await loadActiveFeeSettings();
    const riderEarning = calculateRiderEarning(feeSettings, distanceKm) || 0;

    let restaurantCommission = 0;
    try {
      const snapshot = await foodTransactionService.getRestaurantCommissionSnapshot({
        pricing: normalizedPricing,
        restaurantId,
      });
      restaurantCommission = Number(snapshot?.commissionAmount) || 0;
    } catch (err) {
      logger.error(`Commission calculation failed for order: ${err.message}`);
    }
    normalizedPricing.restaurantCommission = restaurantCommission;

    // Provisional; synced to the transaction's platformNetProfit (which also accounts
    // for the admin discount share) once the initial transaction is created.
    const platformProfit =
      (Number.isFinite(normalizedPricing.deliveryFee) ? normalizedPricing.deliveryFee : 0) +
      (Number.isFinite(normalizedPricing.deliveryFeeGst) ? normalizedPricing.deliveryFeeGst : 0) +
      (Number.isFinite(normalizedPricing.platformFee) ? normalizedPricing.platformFee : 0) +
      restaurantCommission -
      riderEarning;

    const isAwaitingOnlinePayment = isAwaitingOnlinePaymentMethod(paymentMethod);
    const initialStatus = isAwaitingOnlinePayment ? "pending_payment" : "created";
    const acceptanceWindowSeconds = await getOrderAcceptanceWindowSeconds();

    const created = await createOrderRow({
      ...fromOrder({ pricing: normalizedPricing, payment, deliveryAddress }),
      userId: requireId(userId, 'User ID'),
      restaurantId,
      zoneId: dto.zoneId ? requireId(dto.zoneId, 'Zone ID') : restaurant.zoneId || null,
      customerName: String(dto.customerName || deliveryAddress.fullName || ""),
      customerPhone: String(dto.customerPhone || deliveryAddress.phone || ""),
      orderStatus: initialStatus,
      acceptanceWindowSeconds,
      acceptanceDeadlineAt:
        initialStatus === "created" ? buildAcceptanceDeadline(new Date(), acceptanceWindowSeconds) : null,
      dispatchStatus: "unassigned",
      note: String(dto.note || ""),
      deliveryInstructions: String(dto.deliveryInstructions || ""),
      sendCutlery: dto.sendCutlery !== false,
      deliveryFleet: String(dto.deliveryFleet || "standard"),
      scheduledAt: dto.scheduledAt ? new Date(dto.scheduledAt) : null,
      riderEarning: Number(riderEarning) || 0,
      platformProfit: Number(platformProfit) || 0,
      items: {
        create: resolvedItems.map((item) => ({
          itemId: String(item.itemId),
          name: item.name,
          variantId: item.variantId || '',
          variantName: item.variantName || '',
          variantPrice: Number(item.variantPrice) || 0,
          price: Number(item.price) || 0,
          otherPrice: Number(item.otherPrice) || 0,
          quantity: Number(item.quantity) || 1,
          isVeg: Boolean(item.isVeg),
          image: item.image || '',
          notes: item.notes || '',
          addons: item.addons || [],
        })),
      },
      statusHistory: {
        create: [{
          at: new Date(),
          byRole: "SYSTEM",
          from: "",
          to: initialStatus,
          note: initialStatus === "pending_payment" ? "Order created, awaiting payment" : "Order placed",
        }],
      },
    });

    let order = toOrder(created);
    let razorpayPayload = null;

    if (paymentMethod === "razorpay" && isRazorpayConfigured()) {
      const amountPaise = Math.round((normalizedPricing.total || 0) * 100);
      if (amountPaise < 100) {
        await purgeOrder(order.id);
        throw new ValidationError("Amount too low for online payment");
      }
      try {
        // The gateway receipt is the order id, so this can only run post-insert.
        const rzOrder = await createRazorpayOrder(amountPaise, "INR", order.id);
        razorpayPayload = {
          key: getRazorpayKeyId(),
          orderId: rzOrder.id,
          amount: rzOrder.amount,
          currency: rzOrder.currency || "INR",
        };
        order = toOrder(await prisma.foodOrder.update({
          where: { id: order.id },
          data: { razorpayOrderId: rzOrder.id, razorpayPaymentId: '', razorpaySignature: '', paymentStatus: 'created' },
          include: orderInclude,
        }));
      } catch (err) {
        // Mongo threw before saving, so no order existed on gateway failure.
        await purgeOrder(order.id).catch(() => {});
        logger.error(`Razorpay order creation failed: ${err.message}`);
        throw new ValidationError(err?.message || "Payment gateway error");
      }
    }

    if (!isAwaitingOnlinePayment) {
      void addOrderJob(
        { action: "ORDER_ACCEPTANCE_TIMEOUT_CHECK", orderMongoId: order.id, orderId: order.id },
        {
          delay: acceptanceWindowSeconds * 1000,
          removeOnComplete: true,
          removeOnFail: true,
          jobId: `order-accept-timeout-${order.id}`,
        },
      ).catch((err) => {
        logger.warn(`Failed to enqueue acceptance timeout check: ${err?.message || err}`);
      });
    }

    if (isWallet) {
      try {
        await userWalletService.deductWalletBalance(
          userId,
          order.pricing.total,
          `Payment for order #${order.order_id || order.id}`,
          { orderId: order.id },
        );
      } catch (err) {
        await purgeOrder(order.id).catch(() => {});
        throw err;
      }
    }

    // Create the initial transaction after payment is confirmed (online) or immediately (cash/wallet).
    if (!isAwaitingOnlinePayment) {
      try {
        const transaction = await foodTransactionService.createInitialTransaction(order);
        if (transaction && Number.isFinite(Number(transaction.amounts?.platformNetProfit))) {
          await prisma.foodOrder.update({
            where: { id: order.id },
            data: { platformProfit: Number(transaction.amounts.platformNetProfit) },
          });
          order.platformProfit = Number(transaction.amounts.platformNetProfit);
        }
      } catch (err) {
        logger.error(`[CRITICAL] Initial transaction failed for order ${order.id}: ${err.message}`);
      }
    }

    try {
      // Nothing is pushed for an order still awaiting online payment — that push
      // fired while the customer was sitting on the Razorpay sheet actually paying.
      if (!isAwaitingOnlinePayment) {
        await notifyOwnersSafely([{ ownerType: "USER", ownerId: userId }], {
          title: "Order Confirmed! 🍔",
          body: `Your order #${order.order_id || order.id} from ${restaurant.restaurantName || "the restaurant"} has been placed successfully.`,
          image: "https://i.ibb.co/5GzXz7r/Switcheats-Brand-Image.png",
          data: {
            type: "order_created",
            orderId: order.id,
            orderMongoId: order.id,
            link: `/food/user/orders/${order.id}`,
          },
        });

        await notifyRestaurantNewOrder(order);
      }
    } catch (err) {
      logger.warn(`Notifications failed for order ${order.id}: ${err.message}`);
    }

    if (!isAwaitingOnlinePayment) {
      await incrementCouponUsageForOrder(order, userId);
    }

    return { order: normalizeOrderForClient(order), razorpay: razorpayPayload };
  } catch (err) {
    logger.error(`Order placement error: ${err.message}`, { stack: err.stack, userId, dto });
    if (err instanceof ValidationError || err instanceof ForbiddenError || err instanceof NotFoundError) {
      throw err;
    }
    throw new ValidationError(err.message || "Something went wrong while placing your order. Please try again.");
  }
}

// ----- Verify payment -----
export async function verifyPayment(userId, dto) {
  const identity = buildOrderIdentityFilter(dto.orderId);
  if (!identity) throw new ValidationError("Order id required");

  const row = await prisma.foodOrder.findFirst({
    where: { ...identity, userId: String(userId) },
    include: orderInclude,
  });
  if (!row) throw new NotFoundError("Order not found");
  const order = toOrder(row);

  if (order.payment.status === "paid") {
    return { order: normalizeOrderForClient(order), payment: order.payment };
  }

  if (String(dto.razorpayOrderId) !== String(order.payment?.razorpay?.orderId || "")) {
    throw new ValidationError("Payment verification failed");
  }

  const valid = verifyPaymentSignature(
    dto.razorpayOrderId,
    dto.razorpayPaymentId,
    dto.razorpaySignature,
  );
  if (!valid) throw new ValidationError("Payment verification failed");

  // Cross-check the captured payment against the order: correct Razorpay order
  // linkage, an acceptable status, and the exact amount in paise. Fail closed —
  // the webhook remains the recovery path for transient errors.
  let rzPayment;
  try {
    rzPayment = await fetchRazorpayPayment(dto.razorpayPaymentId);
  } catch (err) {
    logger.error(`Razorpay payment fetch failed for order ${order.id}: ${err?.message || err}`);
    throw new ValidationError("Payment verification failed. Please retry in a moment.");
  }

  const expectedPaise = Math.round((Number(order.pricing?.total) || 0) * 100);
  const paidPaise = Number(rzPayment?.amount);
  const rzStatus = String(rzPayment?.status || "").toLowerCase();
  if (
    String(rzPayment?.order_id || "") !== String(order.payment.razorpay.orderId) ||
    !["captured", "authorized"].includes(rzStatus) ||
    !Number.isFinite(paidPaise) ||
    paidPaise !== expectedPaise
  ) {
    await prisma.foodOrder.update({ where: { id: order.id }, data: { paymentStatus: 'failed' } });
    await pushStatusHistory(order.id, {
      byRole: "SYSTEM",
      from: order.orderStatus,
      to: order.orderStatus,
      note: `Payment rejected: amount/order mismatch (paid ${paidPaise} paise, expected ${expectedPaise} paise, status ${rzStatus})`,
    });
    logger.error(
      `Payment amount mismatch for order ${order.id}: paid ${paidPaise} paise, expected ${expectedPaise} paise, rz order ${rzPayment?.order_id}, status ${rzStatus}`,
    );
    throw new ValidationError("Payment verification failed");
  }

  const from = order.orderStatus;
  const acceptanceWindowSeconds = await getOrderAcceptanceWindowSeconds();

  const updated = toOrder(await prisma.foodOrder.update({
    where: { id: order.id },
    data: {
      paymentStatus: 'paid',
      razorpayPaymentId: dto.razorpayPaymentId,
      razorpaySignature: dto.razorpaySignature,
      orderStatus: 'created',
      acceptanceWindowSeconds,
      acceptanceDeadlineAt: buildAcceptanceDeadline(new Date(), acceptanceWindowSeconds),
    },
    include: orderInclude,
  }));

  await pushStatusHistory(order.id, {
    byRole: "USER",
    byId: userId,
    from,
    to: "created",
    note: "Payment verified, order confirmed",
  });

  void addOrderJob(
    { action: "ORDER_ACCEPTANCE_TIMEOUT_CHECK", orderMongoId: order.id, orderId: order.id },
    {
      delay: acceptanceWindowSeconds * 1000,
      removeOnComplete: true,
      removeOnFail: true,
      jobId: `order-accept-timeout-${order.id}`,
    },
  ).catch((err) => {
    logger.warn(`Failed to enqueue acceptance timeout check: ${err?.message || err}`);
  });

  try {
    const transaction = await foodTransactionService.createInitialTransaction(updated);
    if (transaction && Number.isFinite(Number(transaction.amounts?.platformNetProfit))) {
      await prisma.foodOrder.update({
        where: { id: order.id },
        data: { platformProfit: Number(transaction.amounts.platformNetProfit) },
      });
      updated.platformProfit = Number(transaction.amounts.platformNetProfit);
    }
  } catch (err) {
    logger.error(`[CRITICAL] Initial transaction failed for order ${order.id}: ${err.message}`);
  }

  await incrementCouponUsageForOrder(updated, userId);

  await foodTransactionService.updateTransactionStatus(order.id, 'captured', {
    status: 'captured',
    razorpayPaymentId: dto.razorpayPaymentId,
    razorpaySignature: dto.razorpaySignature,
    recordedByRole: "USER",
    recordedById: String(userId),
  });

  // Now that payment is verified, tell the restaurant about the new order.
  await notifyRestaurantNewOrder(updated);

  return { order: normalizeOrderForClient(updated), payment: updated.payment };
}

export async function abandonOnlinePaymentOrder(userId, orderId) {
  const identity = buildOrderIdentityFilter(orderId);
  if (!identity) throw new ValidationError("Order id required");

  const row = await prisma.foodOrder.findFirst({
    where: { ...identity, userId: String(userId) },
    include: orderInclude,
  });
  if (!row) throw new NotFoundError("Order not found");
  const order = toOrder(row);

  if (String(order.orderStatus || "").toLowerCase() !== "pending_payment") {
    throw new ValidationError("Order is not awaiting payment");
  }

  const deleted = await deletePendingPaymentOrder(order);
  if (!deleted) throw new ValidationError("Could not abandon payment");

  return { deleted: true, orderId: order.id };
}

// ----- Auto-assign -----
export async function tryAutoAssign(orderId, options = {}) {
  return dispatchService.tryAutoAssign(orderId, options);
}

export async function processDispatchTimeout(orderId, partnerId, options = {}) {
  return dispatchService.processDispatchTimeout(orderId, partnerId, options);
}

// ----- User: list, get, cancel -----
export async function listOrdersUser(userId, query) {
  await expireStalePendingPaymentOrders();
  await expireUnacceptedOrders();

  const { page, limit, skip } = buildPaginationOptions(query);
  const where = { userId: String(userId), orderStatus: { not: 'pending_payment' } };

  const [rows, total] = await Promise.all([
    prisma.foodOrder.findMany({
      where,
      include: withRelations(),
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.foodOrder.count({ where }),
  ]);

  return buildPaginatedResult({
    docs: toOrders(rows).map((order) => normalizeOrderForClient(order)),
    total,
    page,
    limit,
  });
}

/**
 * Full money split + audit history for the admin order detail view.
 */
async function buildAdminTransactionView(orderId) {
  try {
    const tx = await foodTransactionService.getTransactionByOrder(orderId);
    if (!tx) return null;
    return {
      status: tx.status || null,
      paymentMethod: tx.paymentMethod || tx.payment?.method || null,
      amounts: tx.amounts || null,
      settlement: tx.settlement || null,
      history: (tx.history || []).map((entry) => ({
        kind: entry.kind,
        amount: entry.amount ?? null,
        at: entry.at || null,
        note: entry.note || "",
        byRole: entry.recordedByRole || null,
      })),
    };
  } catch (err) {
    logger.warn(`buildAdminTransactionView failed for order ${orderId}: ${err?.message || err}`);
    return null;
  }
}

/**
 * Restaurant-safe earnings breakdown. Never includes platform economics
 * (platformNetProfit, riderShare, adminDiscountShare).
 */
function buildRestaurantFinanceViewSync(order, tx = null) {
  const pricing = order?.pricing || {};
  const subtotal = Number(pricing.subtotal) || 0;
  const packagingFee = Number(pricing.packagingFee) || 0;

  if (tx?.amounts) {
    return {
      itemTotal: subtotal,
      packagingFee,
      commission: Number(tx.amounts.restaurantCommission) || 0,
      restaurantDiscountShare: Number(tx.amounts.restaurantDiscountShare) || 0,
      discount: Number(pricing.discount) || 0,
      taxAmount: Number(tx.amounts.taxAmount ?? pricing.tax) || 0,
      totalCustomerPaid: Number(tx.amounts.totalCustomerPaid ?? pricing.total) || 0,
      netPayout: Number(tx.amounts.restaurantShare) || 0,
      isSettled: Boolean(tx.settlement?.isRestaurantSettled),
      settledAt: tx.settlement?.restaurantSettledAt || null,
    };
  }

  const commission = Number(pricing.restaurantCommission) || 0;
  const netPayout = Math.max(0, Math.round((subtotal + packagingFee - commission) * 100) / 100);
  return {
    itemTotal: subtotal,
    packagingFee,
    commission,
    restaurantDiscountShare: 0,
    discount: Number(pricing.discount) || 0,
    taxAmount: Number(pricing.tax) || 0,
    totalCustomerPaid: Number(pricing.total) || 0,
    netPayout,
    isSettled: false,
    settledAt: null,
  };
}

async function buildRestaurantFinanceView(order) {
  try {
    const tx = await foodTransactionService.getTransactionByOrder(order.id);
    return buildRestaurantFinanceViewSync(order, tx);
  } catch (err) {
    logger.warn(`buildRestaurantFinanceView failed for order ${order?.id}: ${err?.message || err}`);
    return buildRestaurantFinanceViewSync(order, null);
  }
}

export async function getOrderById(
  orderId,
  { userId, restaurantId, deliveryPartnerId, admin } = {},
) {
  await expireUnacceptedOrders();
  const identity = buildOrderIdentityFilter(orderId);
  if (!identity) throw new ValidationError("Order id required");

  const row = await prisma.foodOrder.findFirst({
    where: identity,
    include: withRelations(RESTAURANT_DETAIL, PARTNER_WITH_LOCATION),
  });
  if (!row) throw new NotFoundError("Order not found");
  const order = toOrder(row);

  if (admin) {
    const out = normalizeOrderForClient(order);
    out.transaction = await buildAdminTransactionView(order.id);
    return out;
  }

  const orderUserId = row.userId;
  const orderRestaurantId = row.restaurantId;
  const orderPartnerId = row.dispatchDeliveryPartnerId;

  if (userId && orderUserId !== String(userId)) throw new ForbiddenError("Not your order");
  if (restaurantId && orderRestaurantId !== String(restaurantId)) {
    throw new ForbiddenError("Not your restaurant order");
  }
  if (deliveryPartnerId && orderPartnerId !== String(deliveryPartnerId)) {
    throw new ForbiddenError("Not assigned to you");
  }

  if (restaurantId) {
    const out = sanitizeOrderForExternal(order);
    out.finance = await buildRestaurantFinanceView(order);
    return out;
  }

  if (deliveryPartnerId) {
    return sanitizeOrderForDeliveryPartner(order);
  }

  if (userId) {
    const drop = order.deliveryVerification?.dropOtp || {};
    const secret = String(order.deliveryOtp || "").trim();
    const out = normalizeOrderForClient(order);
    delete out.deliveryOtp;
    out.deliveryVerification = {
      dropOtp: { required: Boolean(drop.required), verified: Boolean(drop.verified) },
    };
    if (!drop.verified && secret) out.handoverOtp = secret;

    // deliveryState.currentLocation comes from the order's own rider position,
    // which is only written once the rider emits an update FOR THIS ORDER — so
    // before pickup it is null and customer screens fell back to the restaurant's
    // coordinates. The assigned partner's last ping is a real position.
    const partner = row.deliveryPartner;
    if (!out.deliveryState?.currentLocation && partner?.id) {
      const pLat = Number(partner.lastLat);
      const pLng = Number(partner.lastLng);
      if (Number.isFinite(pLat) && Number.isFinite(pLng)) {
        out.deliveryState = {
          ...(out.deliveryState || {}),
          currentLocation: { lat: pLat, lng: pLng },
          currentLocationAt: partner.lastLocationAt || null,
        };
      }
    }

    return out;
  }

  return sanitizeOrderForExternal(order);
}

export async function getDropOtpUser(orderId, userId) {
  const identity = buildOrderIdentityFilter(orderId);
  if (!identity) throw new ValidationError("Order id required");

  const row = await prisma.foodOrder.findFirst({
    where: { ...identity, userId: String(userId) },
    select: { deliveryOtp: true, deliveryPhase: true, orderStatus: true },
  });
  if (!row) throw new NotFoundError("Order not found");

  const eligiblePhases = ["at_drop", "en_route_to_delivery"];
  const isEligible = eligiblePhases.includes(row.deliveryPhase) || row.orderStatus === "picked_up";

  if (!isEligible) {
    throw new ValidationError(
      "Rider is still at the restaurant. Wait for them to pick up your order to see the OTP.",
    );
  }

  return { otp: row.deliveryOtp };
}

/**
 * Closes trips that were picked up but never completed.
 *
 * DELIBERATELY LIMITED TO POST-PICKUP STATES. Marking any four-hour-old order
 * delivered would sweep up ones never accepted, cooked or paid for and record
 * them as fulfilled — which feeds restaurant payouts and rider earnings for food
 * that does not exist.
 *
 * Marks the order only. Settlement is left alone: an auto-closed trip is
 * unverified, so paying it out automatically would make a guess irreversible.
 */
export async function autoDeliverStaleOrders() {
  const cutoffHours = Number(process.env.AUTO_DELIVER_AFTER_HOURS) || 4;
  const cutoff = new Date(Date.now() - cutoffHours * 60 * 60 * 1000);

  const stale = await prisma.foodOrder.findMany({
    where: {
      orderStatus: { in: ['picked_up', 'reached_drop'] },
      // Age from the pickup, not order creation: a trip picked up 10 minutes ago
      // on a five-hour-old scheduled order is perfectly healthy.
      OR: [
        { pickedUpAt: { lte: cutoff } },
        { pickedUpAt: null, updatedAt: { lte: cutoff } },
      ],
    },
    select: { id: true, order_id: true, orderStatus: true, deliveredAt: true },
    take: 200,
  });

  if (!stale.length) return 0;

  let closed = 0;
  for (const order of stale) {
    try {
      const now = new Date();
      // Guard on the status inside the update so a rider completing the trip in
      // this same moment wins rather than being overwritten by the sweep.
      const { count } = await prisma.foodOrder.updateMany({
        where: { id: order.id, orderStatus: { in: ['picked_up', 'reached_drop'] } },
        data: { orderStatus: 'delivered', deliveredAt: order.deliveredAt || now },
      });
      if (count === 0) continue;

      await pushStatusHistory(order.id, {
        byRole: 'ADMIN',
        from: order.orderStatus,
        to: 'delivered',
        note: `Auto-closed after ${cutoffHours}h without completion`,
      });

      closed += 1;
      logger.warn(
        `[AutoDeliver] Order ${order.order_id || order.id} closed automatically ` +
          `after ${cutoffHours}h in '${order.orderStatus}'. Settlement NOT run — review manually.`,
      );

      enqueueOrderEvent('order_auto_delivered', {
        orderMongoId: order.id,
        orderId: order.id,
        previousStatus: order.orderStatus,
      });
    } catch (err) {
      logger.error(`[AutoDeliver] Failed to close order ${order.id}: ${err?.message || err}`);
    }
  }

  if (closed > 0) logger.warn(`[AutoDeliver] Closed ${closed} stale trip(s).`);
  return closed;
}

export async function recoverStuckOrders() {
  const now = Date.now();
  const FIVE_MIN = 5 * 60 * 1000;
  const TWO_MIN = 2 * 60 * 1000;

  try {
    // 1. Stuck in 'assigned' (partner never accepted) for > 2m
    const stuckAssigned = await prisma.foodOrder.findMany({
      where: {
        dispatchStatus: 'assigned',
        dispatchAcceptedAt: null,
        dispatchAssignedAt: { lt: new Date(now - TWO_MIN) },
        orderStatus: { notIn: ['delivered', 'cancelled_by_user', 'cancelled_by_restaurant'] },
      },
      select: { id: true },
    });

    if (stuckAssigned.length > 0) {
      logger.info(`Watchdog: Healing ${stuckAssigned.length} stuck assigned orders.`);
      for (const order of stuckAssigned) {
        await prisma.foodOrder.update({
          where: { id: order.id },
          data: { dispatchStatus: 'unassigned', dispatchDeliveryPartnerId: null },
        });
        await tryAutoAssign(order.id);
      }
    }

    // 2. Clear old dispatching locks (cleanup in case of crash)
    await prisma.foodOrder.updateMany({
      where: { dispatchingAt: { lt: new Date(now - FIVE_MIN) } },
      data: { dispatchingAt: null },
    });
  } catch (err) {
    logger.error(`Watchdog recovery error: ${err.message}`);
  }
}

export async function resyncState(userId, role) {
  if (role === "USER") {
    const row = await prisma.foodOrder.findFirst({
      where: {
        userId: String(userId),
        orderStatus: {
          notIn: ["delivered", "cancelled_by_user", "cancelled_by_restaurant", "cancelled_by_admin"],
        },
      },
      include: withRelations(),
      orderBy: { createdAt: 'desc' },
    });

    if (!row) return { activeOrder: null };

    const order = toOrder(row);
    const out = normalizeOrderForClient(order);
    if (
      (order.deliveryState?.currentPhase === "at_drop" || order.orderStatus === "picked_up") &&
      !order.deliveryVerification?.dropOtp?.verified &&
      order.deliveryOtp
    ) {
      out.handoverOtp = order.deliveryOtp;
    }
    return { activeOrder: out };
  }

  if (role === "DELIVERY_PARTNER") {
    const row = await prisma.foodOrder.findFirst({
      where: {
        dispatchDeliveryPartnerId: String(userId),
        dispatchStatus: { in: ["assigned", "accepted"] },
        orderStatus: { notIn: ["delivered", "cancelled_by_user", "cancelled_by_restaurant"] },
      },
      include: { ...orderInclude, restaurant: true },
    });
    return { activeOrder: row ? sanitizeOrderForDeliveryPartner(toOrder(row)) : null };
  }

  return {};
}

export async function cancelOrder(orderId, userId, reason) {
  const identity = buildOrderIdentityFilter(orderId);
  if (!identity) throw new ValidationError("Order id required");

  const row = await prisma.foodOrder.findFirst({
    where: { ...identity, userId: String(userId) },
    include: orderInclude,
  });
  if (!row) throw new NotFoundError("Order not found");
  const order = toOrder(row);

  const allowed = ["created"];
  if (!allowed.includes(order.orderStatus)) {
    throw new ValidationError("Order cannot be cancelled");
  }

  const from = order.orderStatus;
  const paymentMethod = String(order.payment?.method || "cash").toLowerCase();
  const paymentStatus = String(order.payment?.status || "cod_pending").toLowerCase();

  let refund;
  try {
    refund = await applyCancellationRefund(order, { cancelledBy: 'user' });
  } catch (err) {
    logger.error(`Refund processing error for Order ${orderId}: ${err?.message || err}`);
    refund = { paymentPatch: { refundStatus: "failed", refundAmount: order.pricing.total } };
  }

  const updated = toOrder(await prisma.foodOrder.update({
    where: { id: order.id },
    data: { orderStatus: "cancelled_by_user", ...refund.paymentPatch },
    include: orderInclude,
  }));

  await pushStatusHistory(order.id, {
    byRole: "USER",
    byId: userId,
    from,
    to: "cancelled_by_user",
    note: reason || "",
  });

  enqueueOrderEvent("order_cancelled_by_user", {
    orderMongoId: order.id,
    orderId: order.id,
    userId,
    reason: reason || "",
  });

  const finalPaymentMethod = String(updated.payment?.method || paymentMethod || "cash").toLowerCase();
  const finalPaymentStatus = String(updated.payment?.status || paymentStatus || "cod_pending").toLowerCase();
  const isOnlinePaid =
    finalPaymentMethod === "razorpay" &&
    (finalPaymentStatus === "paid" || finalPaymentStatus === "refunded");

  try {
    await foodTransactionService.updateTransactionStatus(order.id, 'cancelled_by_user', {
      status: isOnlinePaid ? 'refunded' : 'failed',
      note: `Order cancelled by user: ${reason || "No reason"}`,
      recordedByRole: 'USER',
      recordedById: userId,
    });
  } catch (err) {
    logger.warn(`cancelOrder transaction sync failed: ${err?.message || err}`);
  }

  const refundDetail = isOnlinePaid
    ? ` Your refund of ₹${updated.pricing.total} is being processed and will be credited to your original payment method within 5-7 working days.`
    : "";

  await notifyOwnersSafely(
    [
      { ownerType: "USER", ownerId: userId },
      { ownerType: "RESTAURANT", ownerId: updated.restaurantId },
    ],
    {
      title: "Order Cancelled ❌",
      body: `Order #${updated.order_id || updated.id} has been cancelled successfully.${refundDetail}`,
      image: "https://i.ibb.co/5GzXz7r/Switcheats-Brand-Image.png",
      data: { type: "order_cancelled", orderId: updated.id, orderMongoId: updated.id },
    },
  );

  try {
    const io = getIO();
    if (io) {
      const payload = {
        orderMongoId: updated.id,
        orderId: updated.id,
        orderStatus: updated.orderStatus,
        message: `Order #${updated.order_id || updated.id} has been cancelled successfully.${refundDetail}`,
      };
      io.to(rooms.user(userId)).emit("order_status_update", payload);
      io.to(rooms.restaurant(updated.restaurantId)).emit("order_status_update", payload);
    }
  } catch (err) {
    logger.warn(`cancelOrder socket emit failed: ${err?.message || err}`);
  }

  return normalizeOrderForClient(updated);
}

export async function submitOrderRatings(orderId, userId, dto) {
  const identity = buildOrderIdentityFilter(orderId);
  if (!identity) throw new ValidationError("Order id required");

  const row = await prisma.foodOrder.findFirst({
    where: { ...identity, userId: String(userId) },
    include: orderInclude,
  });
  if (!row) throw new NotFoundError("Order not found");
  const order = toOrder(row);

  if (String(order.orderStatus) !== "delivered") {
    throw new ValidationError("You can rate only delivered orders");
  }

  const partnerId = row.dispatchDeliveryPartnerId;
  const hasDeliveryPartner = Boolean(partnerId);
  if (hasDeliveryPartner && !dto.deliveryPartnerRating) {
    throw new ValidationError("Delivery partner rating is required");
  }

  const restaurantAlreadyRated = Number.isFinite(Number(order?.ratings?.restaurant?.rating));
  const deliveryAlreadyRated = Number.isFinite(Number(order?.ratings?.deliveryPartner?.rating));
  if (restaurantAlreadyRated || (hasDeliveryPartner && deliveryAlreadyRated)) {
    throw new ValidationError("Ratings already submitted for this order");
  }

  const now = new Date();

  // Per-dish ratings. Only items actually on this order count — otherwise a
  // customer could rate any dish on the menu, from one cheap order.
  const orderedItems = new Map((order.items || []).map((it) => [String(it.itemId), it]));
  const itemRatings = Array.isArray(dto.itemRatings) ? dto.itemRatings : [];
  const seenItemIds = new Set();
  const itemRatingRows = [];
  for (const entry of itemRatings) {
    const itemId = String(entry.itemId || "").trim();
    const ordered = orderedItems.get(itemId);
    if (!ordered) throw new ValidationError("You can only rate dishes from this order");
    if (seenItemIds.has(itemId)) throw new ValidationError("Each dish can be rated only once");
    seenItemIds.add(itemId);
    itemRatingRows.push({
      itemId,
      name: ordered.name || "",
      rating: entry.rating,
      comment: entry.comment || "",
      ratedAt: now,
    });
  }

  await Promise.all([
    applyAggregateRating('restaurant', row.restaurantId, dto.restaurantRating),
    hasDeliveryPartner
      ? applyAggregateRating('deliveryPartner', partnerId, dto.deliveryPartnerRating)
      : Promise.resolve(),
    ...itemRatings.map((entry) => applyAggregateRating('foodItem', entry.itemId, entry.rating)),
  ]);

  const updated = toOrder(await prisma.foodOrder.update({
    where: { id: order.id },
    data: {
      restaurantRating: dto.restaurantRating,
      restaurantRatingComment: dto.restaurantComment || "",
      restaurantRatedAt: now,
      ...(hasDeliveryPartner
        ? {
            partnerRating: dto.deliveryPartnerRating,
            partnerRatingComment: dto.deliveryPartnerComment || "",
            partnerRatedAt: now,
          }
        : {}),
      ...(itemRatingRows.length ? { itemRatings: { create: itemRatingRows } } : {}),
    },
    include: orderInclude,
  }));

  enqueueOrderEvent('order_ratings_submitted', {
    orderMongoId: order.id,
    orderId: order.id,
    userId,
    restaurantRating: dto.restaurantRating,
    deliveryPartnerRating: hasDeliveryPartner ? dto.deliveryPartnerRating : null,
  });

  return normalizeOrderForClient(updated);
}

/**
 * Delivery partner rates the customer after handover.
 *
 * Kept separate from submitOrderRatings: the two are written by different roles
 * at different times, and sharing the one-shot guard would mean whichever side
 * rated first locked the other out.
 */
export async function submitCustomerRating(orderId, deliveryPartnerId, dto) {
  const identity = buildOrderIdentityFilter(orderId);
  if (!identity) throw new ValidationError("Order id required");

  const row = await prisma.foodOrder.findFirst({ where: identity, include: orderInclude });
  if (!row) throw new NotFoundError("Order not found");
  const order = toOrder(row);

  if (String(row.dispatchDeliveryPartnerId || "") !== String(deliveryPartnerId)) {
    throw new ForbiddenError("Not your order");
  }
  if (String(order.orderStatus) !== "delivered") {
    throw new ValidationError("You can rate only delivered orders");
  }
  if (Number.isFinite(Number(order?.ratings?.customer?.rating))) {
    throw new ValidationError("You have already rated this customer");
  }

  const ratedAt = new Date();
  await applyAggregateRating('user', row.userId, dto.rating);

  const updated = toOrder(await prisma.foodOrder.update({
    where: { id: order.id },
    data: {
      customerRating: dto.rating,
      customerRatingComment: dto.comment || "",
      customerRatedAt: ratedAt,
    },
    include: orderInclude,
  }));

  return {
    orderId: updated.order_id || updated.id,
    orderMongoId: updated.id,
    customerRating: updated.ratings.customer,
  };
}

export async function updateOrderInstructions(orderId, userId, instructions) {
  const identity = buildOrderIdentityFilter(orderId);
  if (!identity) throw new ValidationError("Order id required");

  const row = await prisma.foodOrder.findFirst({
    where: { ...identity, userId: String(userId) },
    select: { id: true, orderStatus: true },
  });
  if (!row) throw new NotFoundError("Order not found");

  const allowedStatuses = ['created', 'confirmed', 'preparing'];
  if (!allowedStatuses.includes(row.orderStatus)) {
    throw new ValidationError("Instructions can no longer be updated for this order");
  }

  const updated = await prisma.foodOrder.update({
    where: { id: row.id },
    data: { deliveryInstructions: String(instructions || "").trim() },
    include: orderInclude,
  });
  return toOrder(updated);
}

// ----- Restaurant -----
export async function listOrdersRestaurant(restaurantId, query) {
  await expireUnacceptedOrders({ restaurantId: String(restaurantId) });

  const { page, limit, skip } = buildPaginationOptions(query);
  const AND = [];

  const where = {
    restaurantId: String(restaurantId),
    // razorpay_qr = collected at the door, same as cash — see canExposeOrderToRestaurant.
    // ('captured' and 'settled' were in the old $in but are not valid payment
    // statuses on an order, so they never matched anything.)
    OR: [
      { paymentMethod: { in: ["cash", "wallet", "razorpay_qr"] } },
      { paymentStatus: { in: ["paid", "authorized", "refunded"] } },
    ],
  };

  const startDateRaw = query?.startDate || query?.from;
  const endDateRaw = query?.endDate || query?.to;
  if (startDateRaw || endDateRaw) {
    const createdAt = {};
    const start = startDateRaw ? new Date(startDateRaw) : null;
    const end = endDateRaw ? new Date(endDateRaw) : null;
    if (start && !Number.isNaN(start.getTime())) {
      start.setHours(0, 0, 0, 0);
      createdAt.gte = start;
    }
    if (end && !Number.isNaN(end.getTime())) {
      end.setHours(23, 59, 59, 999);
      createdAt.lte = end;
    }
    if (Object.keys(createdAt).length > 0) where.createdAt = createdAt;
  }

  const statusRaw = query?.orderStatus || query?.status;
  if (statusRaw) {
    const statuses = String(statusRaw)
      .split(",")
      .map((value) => String(value || "").trim().toLowerCase())
      .filter(Boolean);
    if (statuses.length > 0) where.orderStatus = { in: statuses };
  }

  const searchRaw = String(query?.search || query?.orderId || "").trim();
  if (searchRaw) {
    AND.push({
      OR: [
        { orderId: { contains: searchRaw, mode: 'insensitive' } },
        { order_id: { contains: searchRaw, mode: 'insensitive' } },
      ],
    });
  }
  if (AND.length) where.AND = AND;

  const [rows, total] = await Promise.all([
    prisma.foodOrder.findMany({
      where,
      include: { ...orderInclude, user: { select: { ...USER_CARD, profileImage: true } } },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.foodOrder.count({ where }),
  ]);

  const transactions = rows.length
    ? await prisma.foodTransaction.findMany({
        where: { orderId: { in: rows.map((r) => r.id) } },
      })
    : [];
  const txByOrderId = new Map(transactions.map((tx) => [tx.orderId, tx]));

  const normalizedOrders = toOrders(rows).map((order) => {
    const out = normalizeOrderForClient(order);
    const tx = txByOrderId.get(order.id);
    out.finance = buildRestaurantFinanceViewSync(
      order,
      tx
        ? {
            amounts: {
              restaurantCommission: Number(tx.commissionAmount),
              restaurantDiscountShare: Number(tx.restaurantDiscountShare),
              taxAmount: Number(tx.taxAmount),
              totalCustomerPaid: Number(tx.totalCustomerPaid),
              restaurantShare: Number(tx.restaurantShare),
            },
            settlement: {
              isRestaurantSettled: tx.isRestaurantSettled,
              restaurantSettledAt: tx.restaurantSettledAt,
            },
          }
        : null,
    );
    return out;
  });

  const paginated = buildPaginatedResult({ docs: normalizedOrders, total, page, limit });
  return {
    ...paginated,
    orders: paginated.data,
    pagination: {
      page: paginated.meta.page,
      limit: paginated.meta.limit,
      total: paginated.meta.total,
      totalPages: paginated.meta.totalPages,
      pages: paginated.meta.totalPages,
    },
  };
}

export async function updateOrderStatusRestaurant(orderId, restaurantId, orderStatus, note = "") {
  await expireUnacceptedOrders({ restaurantId: String(restaurantId) });

  const identity = buildOrderIdentityFilter(orderId);
  const row = await prisma.foodOrder.findFirst({
    where: { ...identity, restaurantId: String(restaurantId) },
    include: orderInclude,
  });
  if (!row) throw new NotFoundError("Order not found");
  const order = toOrder(row);

  // An unpaid order must never be actionable by the restaurant. pending_payment is
  // absent from STATUS_PRIORITY, so isStatusAdvance() treats it as 0 and lets ANY
  // target status through — a restaurant could walk an abandoned, never-paid order
  // all the way to 'delivered', which then counts toward its payout.
  if (!canExposeOrderToRestaurant(order)) {
    throw new ValidationError("This order is not payable yet and cannot be updated");
  }

  const targetStatus = String(orderStatus || "").toLowerCase();
  if (targetStatus === "preparing" || targetStatus === "confirmed") {
    const now = new Date();
    const deadline = order.acceptanceDeadlineAt ? new Date(order.acceptanceDeadlineAt) : null;
    if (deadline && deadline.getTime() <= now.getTime()) {
      await expireUnacceptedOrders({ id: order.id });
      throw new ValidationError("Order acceptance window has expired");
    }
  }

  const from = order.orderStatus;
  if (!isStatusAdvance(from, orderStatus)) {
    throw new ValidationError(
      `Current order status '${from}' is further ahead than '${orderStatus}'. Order cannot be moved backwards.`,
    );
  }

  const normalizedPaymentMethod = String(order.payment?.method || "cash").toLowerCase();
  const prevPaymentStatus = String(order.payment?.status || "cod_pending").toLowerCase();
  const codBecomesPaid =
    String(orderStatus) === "delivered" &&
    normalizedPaymentMethod === "cash" &&
    prevPaymentStatus === "cod_pending";

  let updated = toOrder(await prisma.foodOrder.update({
    where: { id: order.id },
    data: {
      orderStatus,
      // The acceptance window exists only to auto-cancel orders the restaurant
      // never acted on. It was never cleared once they did, so expireUnacceptedOrders
      // later cancelled confirmed, actively-dispatching orders as "Not accepted".
      acceptanceDeadlineAt: null,
      ...(codBecomesPaid ? { paymentStatus: 'paid' } : {}),
    },
    include: orderInclude,
  }));

  await pushStatusHistory(order.id, {
    byRole: "RESTAURANT",
    byId: restaurantId,
    from,
    to: orderStatus,
    note: note || "",
  });

  if (String(orderStatus) === "delivered") {
    try {
      const ledgerKind = codBecomesPaid ? "cod_marked_paid_on_delivery" : "payment_snapshot_sync";
      await foodTransactionService.updateTransactionStatus(order.id, ledgerKind, {
        status: "captured",
        recordedByRole: "RESTAURANT",
        recordedById: restaurantId,
        note: `Delivery completed from restaurant flow. Prev payment status: ${prevPaymentStatus}`,
      });
    } catch (err) {
      logger.warn(`updateOrderStatusRestaurant delivered transaction sync failed: ${err?.message || err}`);
    }
  }

  let title = `Order ${updated.id} updated`;
  let body = `Status changed to ${String(orderStatus).replace(/_/g, " ")}`;

  if (orderStatus === "confirmed") {
    title = "Order Accepted! 🧑‍🍳";
    body = "The restaurant has accepted your order and is starting to prepare it.";
  } else if (orderStatus === "preparing") {
    title = "Food is being prepared! 🍳";
    body = "Your food is currently being prepared by the restaurant.";
  } else if (orderStatus === "ready_for_pickup") {
    title = "Food is ready! 🛍️";
    body = "Your order is ready and waiting to be picked up.";
  } else if (String(orderStatus).includes("cancel")) {
    const isOnlinePaid =
      updated.payment.method === "razorpay" &&
      (updated.payment.status === "paid" || updated.payment.status === "refunded");
    const refundDetail = isOnlinePaid
      ? ` Your refund of ₹${updated.pricing.total} is being processed and will be credited to your original payment method within 5-7 working days.`
      : "";
    title = "Order Cancelled ❌";
    body = (note && String(note).trim()) ? note : `Unfortunately, your order has been cancelled by the restaurant.${refundDetail}`;
  }

  try {
    const io = getIO();
    const payload = {
      orderMongoId: updated.id,
      orderId: updated.id,
      orderStatus: updated.orderStatus,
      note: updated.note || "",
      statusNote: note || "",
      title,
      message: body,
    };

    if (io) {
      io.to(rooms.restaurant(restaurantId)).emit("order_status_update", payload);
      io.to(rooms.user(updated.userId)).emit("order_status_update", payload);
      const assignedRiderId = row.dispatchDeliveryPartnerId;
      if (assignedRiderId) {
        io.to(rooms.delivery(assignedRiderId)).emit("order_status_update", payload);
      }
    }

    // Who actually needs telling about THIS status. Everyone used to be pushed for
    // every transition, which trains people to swipe alerts away — which is how a
    // genuinely important one gets missed.
    const status = String(orderStatus || "");
    const isCancellation = status.includes("cancel");
    // ready_for_pickup and preparing are kitchen states the customer cannot act on.
    const CUSTOMER_RELEVANT = ["confirmed", "picked_up", "delivered"];
    const notifyList = [];

    if (isCancellation || CUSTOMER_RELEVANT.includes(status)) {
      notifyList.push({ ownerType: "USER", ownerId: updated.userId });
    }
    // The restaurant is making these changes; echoing its own tap back is noise.
    // A cancellation may come from support or the customer, so that one it needs.
    if (isCancellation) {
      notifyList.push({ ownerType: "RESTAURANT", ownerId: restaurantId });
    }
    const assignedRiderId = row.dispatchDeliveryPartnerId;
    if (assignedRiderId) {
      notifyList.push({ ownerType: "DELIVERY_PARTNER", ownerId: assignedRiderId });
    }

    if (isCancellation) {
      try {
        const isOnlinePaid =
          updated.payment.method === "razorpay" &&
          (updated.payment.status === "paid" || updated.payment.status === "refunded");
        await foodTransactionService.updateTransactionStatus(order.id, 'cancelled_by_restaurant', {
          status: isOnlinePaid ? 'refunded' : 'failed',
          note: `Order cancelled by restaurant/admin`,
          recordedByRole: 'RESTAURANT',
          recordedById: restaurantId,
        });
      } catch (err) {
        logger.warn(`updateOrderStatusRestaurant transaction sync failed: ${err?.message || err}`);
      }
    }

    // Fire-and-forget: awaiting a push fan-out put Google's latency inside the
    // restaurant's tap for no benefit. Guarded rather than returned early, so the
    // dispatch below still runs for a status nobody is pushed about.
    if (notifyList.length > 0) {
      void notifyOwnersSafely(notifyList, {
        title,
        body,
        image: "https://i.ibb.co/5GzXz7r/Switcheats-Brand-Image.png",
        data: {
          type: "order_status_update",
          orderId: updated.id,
          orderMongoId: updated.id,
          orderStatus: String(orderStatus || ""),
          link: `/food/user/orders/${updated.id}`,
        },
      });
    }
  } catch (err) {
    logger.warn(`updateOrderStatusRestaurant notify failed: ${err?.message || err}`);
  }

  try {
    const io = getIO();
    if (io) {
      // On accept (confirmed or preparing) -> request delivery partners.
      if (
        (String(orderStatus) === "preparing" || String(orderStatus) === "confirmed") &&
        String(from) !== "preparing" && String(from) !== "confirmed"
      ) {
        // Dispatch runs in the background, not inside the request: tryAutoAssign does
        // a geo query, a Directions call and an FCM batch. Awaiting all of that made
        // accepting an order take up to 2.7s, which reads as an unresponsive button.
        void tryAutoAssign(order.id).catch((err) => {
          logger.warn(`Auto-assign in updateOrderStatusRestaurant failed: ${err?.message || err}`);
        });
      }

      // When ready for pickup -> ping the assigned delivery partner.
      if (String(orderStatus) === 'ready_for_pickup' && String(from) !== 'ready_for_pickup') {
        const assignedId = row.dispatchDeliveryPartnerId;
        if (assignedId) {
          const restaurant = await prisma.foodRestaurant.findUnique({
            where: { id: row.restaurantId },
            select: {
              id: true, restaurantName: true, latitude: true, longitude: true,
              addressLine1: true, area: true, city: true, state: true,
              ownerPhone: true, coverImage: true, coverImages: true,
              galleryImages: true, landmark: true,
            },
          });
          const payload = buildDeliverySocketPayload(updated, restaurant);
          logger.info(
            `[DeliveryDispatch] Emitting order_ready to ${rooms.delivery(assignedId)} for order ${order.id}`,
          );
          io.to(rooms.delivery(assignedId)).emit('order_ready', payload);
        }
      }
    }
  } catch (err) {
    logger.warn(`updateOrderStatusRestaurant delivery notification failed: ${err?.message || err}`);
  }

  enqueueOrderEvent('restaurant_order_status_updated', {
    orderMongoId: order.id,
    orderId: order.id,
    restaurantId,
    from,
    to: orderStatus,
  });

  if (String(orderStatus).includes("cancel")) {
    try {
      const refund = await applyCancellationRefund(updated, { cancelledBy: 'restaurant' });
      if (Object.keys(refund.paymentPatch).length > 0) {
        updated = toOrder(await prisma.foodOrder.update({
          where: { id: order.id },
          data: refund.paymentPatch,
          include: orderInclude,
        }));
      }
    } catch (err) {
      logger.error(`Automated refund failed for Order ${order.id} (Restaurant Cancel): ${err?.message || err}`);
      updated = toOrder(await prisma.foodOrder.update({
        where: { id: order.id },
        data: { refundStatus: "failed", refundAmount: updated.pricing.total },
        include: orderInclude,
      }));
    }
  }

  return normalizeOrderForClient(updated);
}

export async function resendDeliveryNotificationRestaurant(orderId, restaurantId) {
  return dispatchService.resendDeliveryNotificationRestaurant(orderId, restaurantId);
}

export async function resendDeliveryNotificationAdmin(orderId) {
  return dispatchService.resendDeliveryNotificationAdmin(orderId);
}

export async function getCurrentTripDelivery(deliveryPartnerId) {
  return deliveryService.getCurrentTripDelivery(deliveryPartnerId);
}

// ----- Delivery: available, accept, reject, status -----
export async function listOrdersAvailableDelivery(deliveryPartnerId, query) {
  return deliveryService.listOrdersAvailableDelivery(deliveryPartnerId, query);
}

export async function getOrderRouteForDelivery(orderId, deliveryPartnerId, query) {
  return deliveryService.getOrderRouteForDelivery(orderId, deliveryPartnerId, query);
}

export async function getOrderRouteForUser(orderId, userId, query) {
  return deliveryService.getOrderRouteForUser(orderId, userId, query);
}

export async function acceptOrderDelivery(orderId, deliveryPartnerId) {
  return deliveryService.acceptOrderDelivery(orderId, deliveryPartnerId);
}

export async function rejectOrderDelivery(orderId, deliveryPartnerId) {
  return deliveryService.rejectOrderDelivery(orderId, deliveryPartnerId);
}

export async function confirmReachedPickupDelivery(orderId, deliveryPartnerId) {
  return deliveryService.confirmReachedPickupDelivery(orderId, deliveryPartnerId);
}

export async function confirmPickupDelivery(orderId, deliveryPartnerId, billImageUrl) {
  return deliveryService.confirmPickupDelivery(orderId, deliveryPartnerId, billImageUrl);
}

export async function confirmReachedDropDelivery(orderId, deliveryPartnerId) {
  return deliveryService.confirmReachedDropDelivery(orderId, deliveryPartnerId);
}

export async function verifyDropOtpDelivery(orderId, deliveryPartnerId, otp) {
  return deliveryService.verifyDropOtpDelivery(orderId, deliveryPartnerId, otp);
}

export async function completeDelivery(orderId, deliveryPartnerId, body = {}) {
  return deliveryService.completeDelivery(orderId, deliveryPartnerId, body);
}

export async function updateOrderStatusDelivery(orderId, deliveryPartnerId, orderStatus) {
  return deliveryService.updateOrderStatusDelivery(orderId, deliveryPartnerId, orderStatus);
}

// ----- COD QR collection -----
export async function createCollectQr(orderId, deliveryPartnerId, customerInfo = {}) {
  return paymentService.createCollectQr(orderId, deliveryPartnerId, customerInfo);
}

export async function getPaymentStatus(orderId, deliveryPartnerId) {
  return paymentService.getPaymentStatus(orderId, deliveryPartnerId);
}

export async function switchToCash(orderId, deliveryPartnerId) {
  return paymentService.switchToCash(orderId, deliveryPartnerId);
}

// ----- Admin -----

function applyAdminOrderSearchFilter(AND, searchRaw) {
  const search = String(searchRaw || '').trim().slice(0, 80);
  if (!search) return;

  const phoneDigits = search.replace(/\D/g, '');
  const orConditions = [
    { orderId: { contains: search, mode: 'insensitive' } },
    { order_id: { contains: search, mode: 'insensitive' } },
    { customerName: { contains: search, mode: 'insensitive' } },
    { customerPhone: { contains: search, mode: 'insensitive' } },
    // Matched through the relation rather than a separate id lookup.
    { restaurant: { restaurantName: { contains: search, mode: 'insensitive' } } },
  ];

  if (phoneDigits.length >= 4) {
    orConditions.push({ customerPhone: { contains: phoneDigits } });
  }

  AND.push({ OR: orConditions });
}

function applyAdminPaymentStatusFilter(AND, paymentStatusRaw) {
  const paymentStatus = String(paymentStatusRaw || '').trim().toLowerCase();
  if (!paymentStatus) return;

  if (paymentStatus === 'paid') {
    AND.push({
      OR: [
        { paymentStatus: { in: ['paid', 'authorized'] } },
        { AND: [{ paymentMethod: 'cash' }, { orderStatus: 'delivered' }] },
        {
          AND: [
            { paymentMethod: 'wallet' },
            { paymentStatus: { notIn: ['failed', 'refunded', 'created', 'cod_pending', 'pending_qr'] } },
          ],
        },
      ],
    });
    return;
  }

  if (paymentStatus === 'pending') {
    AND.push({
      OR: [
        { paymentStatus: { in: ['created', 'cod_pending', 'pending_qr'] } },
        { AND: [{ paymentMethod: 'cash' }, { orderStatus: { not: 'delivered' } }] },
      ],
    });
    return;
  }

  if (paymentStatus === 'failed') AND.push({ paymentStatus: 'failed' });
  if (paymentStatus === 'refunded') AND.push({ paymentStatus: 'refunded' });
}

function applyAdminAmountFilter(AND, minAmountRaw, maxAmountRaw) {
  const minAmount = Number(minAmountRaw);
  const maxAmount = Number(maxAmountRaw);
  const total = {};

  if (Number.isFinite(minAmount) && minAmount >= 0) total.gte = minAmount;
  if (Number.isFinite(maxAmount) && maxAmount >= 0) total.lte = maxAmount;
  if (Object.keys(total).length > 0) AND.push({ total });
}

export async function listOrdersAdmin(query) {
  await expireStalePendingPaymentOrders();

  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 50, 1), 2000);
  const skip = (page - 1) * limit;

  const where = {};
  const AND = [];

  const rawStatus = typeof query.status === "string" ? query.status.trim().toLowerCase() : "";
  const cancelledBy =
    typeof query.cancelledBy === "string" ? query.cancelledBy.trim().toLowerCase() : "";
  const restaurantIdRaw = typeof query.restaurantId === "string" ? query.restaurantId.trim() : "";
  const zoneIdRaw = typeof query.zoneId === "string" ? query.zoneId.trim() : "";
  const startDateRaw = typeof query.startDate === "string" ? query.startDate.trim() : "";
  const endDateRaw = typeof query.endDate === "string" ? query.endDate.trim() : "";
  const searchRaw = typeof query.search === "string" ? query.search.trim() : "";
  const paymentStatusRaw =
    typeof query.paymentStatus === "string" ? query.paymentStatus.trim() : "";

  if (!rawStatus || rawStatus === "all") {
    where.orderStatus = { not: "pending_payment" };
  }

  if (rawStatus && rawStatus !== "all") {
    const terminalCancelledStatuses = [
      "cancelled_by_user", "cancelled_by_restaurant", "cancelled_by_admin",
    ];

    switch (rawStatus) {
      case "pending":
        // Placed by customer; restaurant has not accepted yet.
        where.orderStatus = "created";
        break;
      case "processing":
        // Active orders not delivered/cancelled, delivery partner not accepted yet.
        where.orderStatus = {
          notIn: ["created", "delivered", "pending_payment", ...terminalCancelledStatuses],
        };
        AND.push({ dispatchStatus: { not: "accepted" } });
        break;
      case "food-on-the-way":
        where.dispatchStatus = "accepted";
        where.orderStatus = { notIn: ["delivered", ...terminalCancelledStatuses] };
        break;
      case "delivered":
        where.orderStatus = "delivered";
        break;
      case "canceled":
      case "cancelled":
        where.orderStatus = { in: terminalCancelledStatuses };
        break;
      case "restaurant-cancelled":
        where.orderStatus = "cancelled_by_restaurant";
        break;
      case "payment-failed":
        where.paymentStatus = "failed";
        break;
      case "refunded":
        where.paymentStatus = "refunded";
        break;
      case "offline-payments":
        where.paymentMethod = "cash";
        where.orderStatus = { in: ["created", "confirmed", "delivered"] };
        break;
      default:
        break;
    }
  }

  if (cancelledBy) {
    if (cancelledBy === "restaurant") where.orderStatus = "cancelled_by_restaurant";
    else if (cancelledBy === "user" || cancelledBy === "customer") {
      where.orderStatus = "cancelled_by_user";
    }
  }

  if (isId(restaurantIdRaw)) where.restaurantId = restaurantIdRaw;

  // Zone is a property of the restaurant, so filter through the relation rather
  // than pre-resolving every restaurant id in the zone.
  if (isId(zoneIdRaw)) AND.push({ restaurant: { zoneId: zoneIdRaw } });

  if (startDateRaw || endDateRaw) {
    const createdAt = {};
    const start = startDateRaw ? new Date(startDateRaw) : null;
    const end = endDateRaw ? new Date(endDateRaw) : null;
    if (start && !Number.isNaN(start.getTime())) createdAt.gte = start;
    if (end && !Number.isNaN(end.getTime())) {
      end.setHours(23, 59, 59, 999);
      createdAt.lte = end;
    }
    if (Object.keys(createdAt).length > 0) where.createdAt = createdAt;
  }

  applyAdminOrderSearchFilter(AND, searchRaw);
  applyAdminPaymentStatusFilter(AND, paymentStatusRaw);
  applyAdminAmountFilter(AND, query.minAmount, query.maxAmount);
  if (AND.length) where.AND = AND;

  const [rows, total] = await Promise.all([
    prisma.foodOrder.findMany({
      where,
      include: withRelations(RESTAURANT_ADMIN, PARTNER_CARD),
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.foodOrder.count({ where }),
  ]);

  const paginated = buildPaginatedResult({
    docs: toOrders(rows).map((order) => normalizeOrderForClient(order)),
    total,
    page,
    limit,
  });
  return { ...paginated, orders: paginated.data };
}

export async function assignDeliveryPartnerAdmin(orderId, deliveryPartnerId, adminId) {
  const row = await prisma.foodOrder.findUnique({
    where: { id: String(orderId) },
    include: orderInclude,
  });
  if (!row) throw new NotFoundError("Order not found");
  if (row.dispatchStatus === "accepted") {
    throw new ValidationError("Order already accepted by partner");
  }

  const partner = await prisma.foodDeliveryPartner.findUnique({
    where: { id: String(deliveryPartnerId) },
    select: { status: true },
  });
  if (!partner || partner.status !== "approved") {
    throw new ValidationError("Delivery partner not available");
  }

  const updated = toOrder(await prisma.foodOrder.update({
    where: { id: row.id },
    data: {
      dispatchStatus: 'assigned',
      dispatchDeliveryPartnerId: String(deliveryPartnerId),
      dispatchAssignedAt: new Date(),
    },
    include: orderInclude,
  }));

  await pushStatusHistory(row.id, {
    byRole: 'ADMIN',
    byId: adminId,
    from: row.orderStatus,
    to: row.orderStatus,
    note: 'Delivery partner assigned by admin',
  });

  enqueueOrderEvent('delivery_partner_assigned', {
    orderMongoId: row.id,
    orderId: row.id,
    deliveryPartnerId,
    adminId,
  });

  return normalizeOrderForClient(updated);
}

export async function deleteOrderAdmin(orderId, adminId) {
  const identity = buildOrderIdentityFilter(orderId);
  if (!identity) throw new ValidationError("Order id required");

  const row = await prisma.foodOrder.findFirst({ where: identity, include: orderInclude });
  if (!row) throw new NotFoundError("Order not found");
  const order = toOrder(row);

  await purgeOrder(order.id);

  // Remove the realtime tracking node if present.
  try {
    const db = getFirebaseDB();
    if (db) await db.ref(`active_orders/${order.id}`).remove();
  } catch (err) {
    logger.warn(`Delete order firebase cleanup failed: ${err?.message || err}`);
  }

  // Notify connected apps so stale UI entries disappear without a refresh.
  try {
    const io = getIO();
    if (io) {
      const payload = {
        orderMongoId: order.id,
        orderId: order.id,
        deletedBy: "ADMIN",
        adminId: adminId ? String(adminId) : null,
      };
      if (row.userId) io.to(rooms.user(row.userId)).emit("order_deleted", payload);
      if (row.restaurantId) io.to(rooms.restaurant(row.restaurantId)).emit("order_deleted", payload);
      if (row.dispatchDeliveryPartnerId) {
        io.to(rooms.delivery(row.dispatchDeliveryPartnerId)).emit("order_deleted", payload);
      }
    }
  } catch (err) {
    logger.warn(`Delete order socket emit failed: ${err?.message || err}`);
  }

  enqueueOrderEvent("order_deleted_by_admin", {
    orderMongoId: order.id,
    orderId: order.id,
    adminId: adminId ? String(adminId) : null,
  });

  return { deleted: true, orderId: order.id, orderMongoId: order.id };
}

export async function updateOrderStatusAdmin(orderId, orderStatus, note = "", adminId) {
  const identity = buildOrderIdentityFilter(orderId);
  const row = await prisma.foodOrder.findFirst({ where: identity, include: orderInclude });
  if (!row) throw new NotFoundError("Order not found");
  const order = toOrder(row);

  if (!Object.prototype.hasOwnProperty.call(STATUS_PRIORITY, String(orderStatus))) {
    throw new ValidationError(`Invalid order status: ${orderStatus}`);
  }
  if (!isStatusAdvance(order.orderStatus, orderStatus)) {
    throw new ValidationError(
      `Cannot change order status from '${order.orderStatus}' to '${orderStatus}'`,
    );
  }

  const from = order.orderStatus;
  const normalizedPaymentMethod = String(order.payment?.method || "cash").toLowerCase();
  const prevPaymentStatus = String(order.payment?.status || "cod_pending").toLowerCase();
  const codBecomesPaid =
    String(orderStatus) === "delivered" &&
    normalizedPaymentMethod === "cash" &&
    prevPaymentStatus === "cod_pending";

  let refundPatch = {};
  if (String(orderStatus).includes("cancel")) {
    try {
      const refund = await applyCancellationRefund(order, { cancelledBy: 'admin' });
      refundPatch = refund.paymentPatch;
    } catch (err) {
      logger.warn(`Admin cancellation refund failed for order ${order.id}: ${err?.message || err}`);
      refundPatch = { refundStatus: "failed", refundAmount: order.pricing?.total || 0 };
    }
  }

  let updated = toOrder(await prisma.foodOrder.update({
    where: { id: order.id },
    data: { orderStatus, ...(codBecomesPaid ? { paymentStatus: 'paid' } : {}), ...refundPatch },
    include: orderInclude,
  }));

  await pushStatusHistory(order.id, {
    byRole: "ADMIN",
    byId: adminId,
    from,
    to: orderStatus,
    note: note || "Status updated by admin",
  });

  if (String(orderStatus) === "delivered") {
    try {
      const ledgerKind = codBecomesPaid ? "cod_marked_paid_on_delivery" : "payment_snapshot_sync";
      await foodTransactionService.updateTransactionStatus(order.id, ledgerKind, {
        status: "captured",
        recordedByRole: "ADMIN",
        recordedById: adminId,
        note: `Delivery completed from admin flow. Prev payment status: ${prevPaymentStatus}`,
      });
    } catch (err) {
      logger.warn(`updateOrderStatusAdmin delivered transaction sync failed: ${err?.message || err}`);
    }
  }

  const notifyList = [
    { ownerType: "USER", ownerId: updated.userId },
    { ownerType: "RESTAURANT", ownerId: updated.restaurantId },
  ];
  if (row.dispatchDeliveryPartnerId) {
    notifyList.push({ ownerType: "DELIVERY_PARTNER", ownerId: row.dispatchDeliveryPartnerId });
  }

  let title = `Order Status Updated 📋`;
  let body = `Order #${updated.order_id || updated.id} status changed to ${String(orderStatus).replace(/_/g, " ")} by support.`;

  if (orderStatus === "confirmed") {
    title = "Order Accepted! 🧑‍🍳";
    body = "The order has been accepted and is starting to be prepared.";
  } else if (orderStatus === "preparing") {
    title = "Food is being prepared! 🍳";
    body = "Your food is currently being prepared by the restaurant.";
  } else if (orderStatus === "ready_for_pickup") {
    title = "Food is ready! 🛍️";
    body = "Your order is ready and waiting to be picked up.";
  } else if (String(orderStatus).includes("cancel")) {
    title = "Order Cancelled ❌";
    body = (note && String(note).trim()) ? note : `Unfortunately, your order has been cancelled by support.`;
  }

  await notifyOwnersSafely(notifyList, {
    title,
    body,
    data: { type: "order_status_update", orderId: updated.id, orderStatus: String(orderStatus || "") },
  });

  try {
    const io = getIO();
    if (io) {
      const payload = {
        orderMongoId: updated.id,
        orderId: updated.id,
        orderStatus: updated.orderStatus,
        message: body,
        title,
        note: updated.note || "",
        statusNote: note || "",
      };
      io.to(rooms.user(updated.userId)).emit("order_status_update", payload);
      io.to(rooms.restaurant(updated.restaurantId)).emit("order_status_update", payload);
      if (row.dispatchDeliveryPartnerId) {
        io.to(rooms.delivery(row.dispatchDeliveryPartnerId)).emit("order_status_update", payload);
      }

      if (
        (String(orderStatus) === "preparing" || String(orderStatus) === "confirmed") &&
        String(from) !== "preparing" && String(from) !== "confirmed"
      ) {
        try {
          await tryAutoAssign(order.id);
          updated = toOrder(
            await prisma.foodOrder.findUnique({ where: { id: order.id }, include: orderInclude }),
          );
        } catch (err) {
          logger.warn(`Auto-assign in updateOrderStatusAdmin failed: ${err?.message || err}`);
        }
      }
    }
  } catch (err) {
    logger.warn(`Admin status update socket emit failed: ${err?.message || err}`);
  }

  return normalizeOrderForClient(updated);
}

export async function markOrderDeliveredAdmin(orderId, adminId, note = "") {
  const identity = buildOrderIdentityFilter(orderId);
  const row = await prisma.foodOrder.findFirst({ where: identity, include: orderInclude });
  if (!row) throw new NotFoundError("Order not found");
  const order = toOrder(row);

  const from = String(order.orderStatus || "");
  if (from === "delivered") throw new ValidationError("Order is already delivered");
  if (from.includes("cancel") || from === "pending_payment") {
    throw new ValidationError(`Cannot mark order as delivered from status '${from}'`);
  }

  const normalizedPaymentMethod = String(order.payment?.method || "cash").toLowerCase();
  const prevPaymentStatus = String(order.payment?.status || "cod_pending").toLowerCase();
  const codBecomesPaid = normalizedPaymentMethod === "cash" && prevPaymentStatus === "cod_pending";

  const updated = toOrder(await prisma.foodOrder.update({
    where: { id: order.id },
    data: {
      orderStatus: "delivered",
      deliveryPhase: "delivered",
      deliveryStatus: "delivered",
      deliveredAt: row.deliveredAt || new Date(),
      ...(codBecomesPaid ? { paymentStatus: 'paid' } : {}),
    },
    include: orderInclude,
  }));

  await pushStatusHistory(order.id, {
    byRole: "ADMIN",
    byId: adminId,
    from,
    to: "delivered",
    note: note || "Order marked as delivered by admin",
  });

  try {
    const ledgerKind = codBecomesPaid ? "cod_marked_paid_on_delivery" : "payment_snapshot_sync";
    await foodTransactionService.updateTransactionStatus(order.id, ledgerKind, {
      status: "captured",
      recordedByRole: "ADMIN",
      recordedById: adminId,
      note: `Delivery completed by admin override. Prev payment status: ${prevPaymentStatus}`,
    });
  } catch (err) {
    logger.warn(`markOrderDeliveredAdmin transaction sync failed: ${err?.message || err}`);
  }

  const orderLabel = updated.order_id || updated.id;
  const notifyList = [
    { ownerType: "USER", ownerId: updated.userId },
    { ownerType: "RESTAURANT", ownerId: updated.restaurantId },
  ];
  if (row.dispatchDeliveryPartnerId) {
    notifyList.push({ ownerType: "DELIVERY_PARTNER", ownerId: row.dispatchDeliveryPartnerId });
  }

  await notifyOwnersSafely(notifyList, {
    title: "Order Delivered! 🎉",
    body: `Order #${orderLabel} has been marked as delivered by support.`,
    data: { type: "order_status_update", orderId: updated.id, orderStatus: "delivered" },
  });

  try {
    const io = getIO();
    if (io) {
      const payload = {
        orderMongoId: updated.id,
        orderId: updated.id,
        orderStatus: "delivered",
        deliveryState: updated.deliveryState,
        message: `Order #${orderLabel} marked as delivered by admin.`,
        title: "Order Delivered! 🎉",
      };
      io.to(rooms.user(updated.userId)).emit("order_status_update", payload);
      io.to(rooms.restaurant(updated.restaurantId)).emit("order_status_update", payload);
      if (row.dispatchDeliveryPartnerId) {
        io.to(rooms.delivery(row.dispatchDeliveryPartnerId)).emit("order_status_update", payload);
        io.to(rooms.delivery(row.dispatchDeliveryPartnerId)).emit("order_completed", payload);
      }
    }
  } catch (err) {
    logger.warn(`markOrderDeliveredAdmin socket emit failed: ${err?.message || err}`);
  }

  enqueueOrderEvent("delivery_completed", {
    orderMongoId: updated.id,
    orderId: updated.id,
    adminId: adminId ? String(adminId) : null,
    payMethod: normalizedPaymentMethod,
    prevPayStatus: prevPaymentStatus,
    paymentStatus: updated.payment?.status,
    source: "admin_override",
  });

  return normalizeOrderForClient(updated);
}

export async function processRefundAdmin(orderId, amount, adminId) {
  const identity = buildOrderIdentityFilter(orderId);
  const row = await prisma.foodOrder.findFirst({ where: identity, include: orderInclude });
  if (!row) throw new NotFoundError("Order not found");
  const order = toOrder(row);

  const currentPaymentStatus = String(order.payment?.status || "").toLowerCase();
  if (currentPaymentStatus === "refunded") {
    throw new ValidationError("Order is already refunded");
  }

  const refundAmount = Number(amount) || order.pricing?.total || 0;
  if (refundAmount <= 0) throw new ValidationError("Invalid refund amount");

  const refundResult = await applyCancellationRefund(order, { cancelledBy: 'admin', refundAmount });

  if (Object.keys(refundResult.paymentPatch).length > 0) {
    await prisma.foodOrder.update({ where: { id: order.id }, data: refundResult.paymentPatch });
  }

  if (!refundResult.processed) {
    if (refundResult.reason === 'cash_payment') {
      throw new ValidationError('Cash on Delivery orders do not require a refund');
    }
    throw new Error('Refund processing failed');
  }

  try {
    await foodTransactionService.updateTransactionStatus(order.id, order.orderStatus, {
      status: 'refunded',
      note: `Refund of ₹${refundAmount} processed by admin`,
      recordedByRole: 'ADMIN',
      recordedById: adminId,
    });
  } catch (err) {
    logger.warn(`Admin refund transaction sync failed: ${err?.message || err}`);
  }

  const updated = toOrder(
    await prisma.foodOrder.findUnique({ where: { id: order.id }, include: orderInclude }),
  );
  return { success: true, order: normalizeOrderForClient(updated) };
}
