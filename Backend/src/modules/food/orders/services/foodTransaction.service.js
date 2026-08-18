import { prisma } from '../../../../config/prisma.js';
import { toFoodTransaction } from '../order.mapper.js';
import { resolveDiscountSplitByCoupon } from '../../shared/discountSplit.util.js';

const RESTAURANT_COMMISSION_CACHE_MS = 60 * 1000;
let restaurantCommissionRulesCache = null;
let restaurantCommissionRulesLoadedAt = 0;

async function getActiveRestaurantCommissionRules() {
  const now = Date.now();
  if (
    restaurantCommissionRulesCache &&
    now - restaurantCommissionRulesLoadedAt < RESTAURANT_COMMISSION_CACHE_MS
  ) {
    return restaurantCommissionRulesCache;
  }

  const list = await prisma.foodRestaurantCommission.findMany({ where: { status: true } });
  restaurantCommissionRulesCache = list || [];
  restaurantCommissionRulesLoadedAt = now;
  return restaurantCommissionRulesCache;
}

export function computeRestaurantCommissionAmount(baseAmount, rule) {
  const safeBase = Math.max(0, Number(baseAmount) || 0);
  if (!Number.isFinite(safeBase) || safeBase < 0) return 0;

  // The nested defaultCommission subdoc is two columns now; the legacy shape is
  // still accepted so a caller passing an old object keeps working.
  const commissionType = rule?.commissionType || rule?.defaultCommission?.type || 'percentage';
  const commissionValue = Math.max(
    0,
    Number(rule?.commissionValue ?? rule?.defaultCommission?.value ?? 0) || 0
  );

  let commissionAmount = 0;
  if (commissionType === 'percentage') {
    commissionAmount = safeBase * (commissionValue / 100);
  } else if (commissionType === 'amount') {
    commissionAmount = commissionValue;
  }

  // Round to 2 decimals and clamp to [0, base]
  commissionAmount = Math.round((commissionAmount || 0) * 100) / 100;
  commissionAmount = Math.max(0, Math.min(commissionAmount, safeBase));

  return { commissionAmount, commissionType, commissionValue, baseAmount: safeBase };
}

export async function getRestaurantCommissionSnapshot(orderDoc) {
  const baseAmount = Number(orderDoc?.subtotal ?? 0) || 0;
  const restaurantIdRaw = orderDoc?.restaurantId ?? null;

  if (!restaurantIdRaw) {
    return { commissionAmount: 0, commissionType: 'percentage', commissionValue: 0, baseAmount };
  }

  const rules = await getActiveRestaurantCommissionRules();
  const rule = rules.find((r) => String(r.restaurantId) === String(restaurantIdRaw)) || null;

  if (!rule) {
    return { commissionAmount: 0, commissionType: 'percentage', commissionValue: 0, baseAmount };
  }

  return computeRestaurantCommissionAmount(baseAmount, rule);
}

/**
 * Creates the initial 'pending' transaction when an order is created.
 */
export async function createInitialTransaction(order) {
  if (!order) return null;

  const { commissionAmount = 0 } = await getRestaurantCommissionSnapshot(order).catch(() => ({
    commissionAmount: 0,
  }));

  const totalCustomerPaid = Number(order.total) || 0;
  const riderShare = Number(order.riderEarning) || 0;

  // Prefer the commission already computed and stored on the order (source of truth
  // for this order); fall back to the rule snapshot for older orders.
  const restaurantCommissionFromOrder = Number(order.restaurantCommission);
  const restaurantCommission =
    Number.isFinite(restaurantCommissionFromOrder) && restaurantCommissionFromOrder > 0
      ? restaurantCommissionFromOrder
      : Number(commissionAmount) || 0;

  const discount = Number(order.discount) || 0;
  const subtotal = Number(order.subtotal) || 0;
  const packagingFee = Number(order.packagingFee) || 0;
  const platformFee = Number(order.platformFee) || 0;
  const deliveryFee = Number(order.deliveryFee) || 0;
  const deliveryFeeGst = Number(order.deliveryFeeGst) || 0;
  const tax = Number(order.tax) || 0;

  let restaurantNet = subtotal + packagingFee - restaurantCommission;
  let platformNetProfit =
    platformFee + deliveryFee + deliveryFeeGst + restaurantCommission - riderShare;
  let adminDiscountShare = 0;
  let restaurantDiscountShare = 0;
  let discountAdminBearPercentage = 0;
  let discountRestaurantBearPercentage = 0;

  // Discount attribution goes through the shared split util (single source of truth).
  const couponCode = order.couponCode;
  if (discount > 0 && couponCode) {
    const split = await resolveDiscountSplitByCoupon({ couponCode, discount });
    adminDiscountShare = split.adminDiscountShare;
    restaurantDiscountShare = split.restaurantDiscountShare;
    discountAdminBearPercentage = split.adminBearPercentage;
    discountRestaurantBearPercentage = split.restaurantBearPercentage;
  }
  restaurantNet -= restaurantDiscountShare;
  platformNetProfit -= adminDiscountShare;

  restaurantNet = Math.round((Number(restaurantNet) || 0) * 100) / 100;
  platformNetProfit = Math.round((Number(platformNetProfit) || 0) * 100) / 100;

  const orderId = String(order.id);

  const transaction = await prisma.foodTransaction.create({
    data: {
      orderId,
      userId: String(order.userId),
      restaurantId: String(order.restaurantId),
      deliveryPartnerId: order.dispatchDeliveryPartnerId || null,
      paymentMethod: order.paymentMethod || 'cash',
      status: order.paymentStatus === 'paid' ? 'captured' : 'pending',

      paymentStatusLabel: String(order.paymentStatus || 'cod_pending'),
      amountDue: Number(order.paymentAmountDue ?? totalCustomerPaid) || 0,
      gatewayProvider: 'razorpay',
      razorpayOrderId: order.razorpayOrderId || null,
      razorpayPaymentId: order.razorpayPaymentId || null,
      razorpaySignature: order.razorpaySignature || null,
      qr: order.qr || undefined,

      subtotal,
      tax,
      packagingFee,
      deliveryFee,
      deliveryFeeGst,
      platformFee,
      restaurantCommission,
      discount,
      couponCode: couponCode ? String(couponCode).toUpperCase() : null,
      total: totalCustomerPaid,
      currency: String(order.currency || 'INR'),

      totalCustomerPaid,
      restaurantShare: Math.max(0, restaurantNet),
      commissionAmount: restaurantCommission,
      riderShare,
      platformNetProfit,
      taxAmount: tax,
      adminDiscountShare,
      restaurantDiscountShare,
      discountAdminBearPercentage,
      discountRestaurantBearPercentage,

      history: {
        create: [
          { kind: 'created', amount: totalCustomerPaid, note: 'Initial transaction created with order' },
        ],
      },
    },
    include: { history: true },
  });

  // Link back to the order. Failure here must not fail the transaction.
  await prisma.foodOrder
    .update({ where: { id: orderId }, data: { transactionId: transaction.id } })
    .catch(() => {});

  return toFoodTransaction(transaction);
}

/**
 * Update transaction status (captured, settled, …) and append to history.
 */
export async function updateTransactionStatus(orderId, kind, details = {}) {
  const transaction = await prisma.foodTransaction.findUnique({
    where: { orderId: String(orderId) },
  });
  if (!transaction) return null;

  const updated = await prisma.foodTransaction.update({
    where: { id: transaction.id },
    data: {
      ...(details.status ? { status: details.status } : {}),
      ...(details.razorpayPaymentId ? { razorpayPaymentId: details.razorpayPaymentId } : {}),
      ...(details.razorpaySignature ? { razorpaySignature: details.razorpaySignature } : {}),
      history: {
        create: [
          {
            kind,
            amount: transaction.totalCustomerPaid,
            at: new Date(),
            note: details.note || `Transaction updated: ${kind}`,
            recordedByRole: details.recordedByRole || 'SYSTEM',
            recordedById: details.recordedById ? String(details.recordedById) : null,
          },
        ],
      },
    },
    include: { history: true },
  });

  return toFoodTransaction(updated);
}

/**
 * Set the rider on the transaction when an order is accepted.
 */
export async function updateTransactionRider(orderId, riderId) {
  const { count } = await prisma.foodTransaction.updateMany({
    where: { orderId: String(orderId) },
    data: { deliveryPartnerId: String(riderId) },
  });
  if (count === 0) return null;

  return getTransactionByOrder(orderId);
}

/** Fetch the split for one order, in the nested shape callers read. */
export async function getTransactionByOrder(orderId) {
  const row = await prisma.foodTransaction.findUnique({
    where: { orderId: String(orderId) },
    include: { history: { orderBy: { at: 'desc' } } },
  });
  return row ? toFoodTransaction(row) : null;
}

/**
 * Mark the restaurant settled in the finance record.
 */
export async function settleRestaurant(orderId, adminId) {
  return updateTransactionStatus(orderId, 'settled', {
    status: 'captured', // Ensure it is captured even if it was pending cash
    note: 'Restaurant payout settled by admin',
    recordedByRole: 'ADMIN',
    recordedById: adminId,
  });
}
