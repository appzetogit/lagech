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

/**
 * How a restaurant is billed, cached briefly.
 *
 * Read on every order, changed rarely, and a stale value for up to a minute
 * only means one order bills the way it did a moment ago -- the same trade the
 * commission rule cache already makes.
 */
const billingModeCache = new Map(); // restaurantId -> { mode, at }

async function getRestaurantBillingMode(restaurantId) {
  const hit = billingModeCache.get(restaurantId);
  if (hit && Date.now() - hit.at < RESTAURANT_COMMISSION_CACHE_MS) return hit.mode;

  const row = await prisma.foodRestaurant.findUnique({
    where: { id: restaurantId },
    select: { billingMode: true },
  });
  const mode = row?.billingMode || 'commission_overall';
  // Bounded: a deployment has tens of restaurants, not tens of thousands, but
  // this never grows past the cache window either way.
  if (billingModeCache.size > 2000) billingModeCache.clear();
  billingModeCache.set(restaurantId, { mode, at: Date.now() });
  return mode;
}

/** Per-dish rates for one restaurant, keyed by item id. */
const itemRulesCache = new Map(); // restaurantId -> { map, at }

async function getItemCommissionRules(restaurantId) {
  const hit = itemRulesCache.get(restaurantId);
  if (hit && Date.now() - hit.at < RESTAURANT_COMMISSION_CACHE_MS) return hit.map;

  const rows = await prisma.foodItemCommission.findMany({
    where: { restaurantId, status: true },
    select: { itemId: true, commissionType: true, commissionValue: true },
  });
  const map = new Map(rows.map((r) => [String(r.itemId), r]));
  if (itemRulesCache.size > 2000) itemRulesCache.clear();
  itemRulesCache.set(restaurantId, { map, at: Date.now() });
  return map;
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

/**
 * Dish-mode commission: every line at its own rate, the restaurant rate
 * standing in for dishes that have none.
 *
 * Pure and exported so the arithmetic can be tested without a database --
 * getting this wrong bills a restaurant the wrong amount on every order, and
 * the rest of the function is lookups.
 */
export function sumItemCommissions(lines, itemRules, fallbackRule, cap = Infinity) {
  let total = 0;
  for (const line of lines) {
    const lineBase = (Number(line?.price) || 0) * (Number(line?.quantity) || 0);
    const rule =
      (itemRules && typeof itemRules.get === 'function'
        ? itemRules.get(String(line?.itemId))
        : null) || fallbackRule;
    // No rate for this dish and no restaurant fallback: that line earns
    // nothing rather than silently inheriting some other dish's rate.
    if (!rule) continue;
    total += computeRestaurantCommissionAmount(lineBase, rule).commissionAmount;
  }
  total = Math.round(total * 100) / 100;
  // Never bill more commission than the order was worth.
  return Math.max(0, Math.min(total, Number.isFinite(cap) ? cap : total));
}

/** Order lines, from whichever shape the caller has. */
function orderLines(orderDoc) {
  const raw = Array.isArray(orderDoc?.items)
    ? orderDoc.items
    : Array.isArray(orderDoc?.pricing?.items)
      ? orderDoc.pricing.items
      : [];
  return raw
    .map((line) => ({
      itemId: String(line?.itemId ?? line?.id ?? ''),
      // variantPrice wins where a variant was chosen, matching what the
      // customer was actually billed for the line.
      price: Number(line?.variantPrice ?? line?.price ?? 0) || 0,
      quantity: Number(line?.quantity ?? 1) || 1,
    }))
    .filter((line) => line.itemId);
}

/**
 * Commission for one order, according to how the restaurant is billed.
 *
 * commission_overall  one rate against the subtotal
 * commission_dish     each line at its own rate, restaurant rate as the
 *                     fallback for dishes with none of their own
 * subscription        nothing per order; the restaurant pays a monthly plan
 *
 * Everything downstream -- the order column, the transaction, the payout and
 * the dashboards -- reads this one function, so the mode only has to be
 * honoured here.
 */
export async function getRestaurantCommissionSnapshot(orderDoc) {
  // Two shapes reach this: a saved order row, which has `subtotal` as a
  // column, and the in-flight draft from createOrder, which carries it under
  // `pricing`. Only the first was read, so every order priced its commission
  // off a base of 0 and stored 0 in food_orders.restaurantCommission -- and
  // platformProfit, computed from it at creation, was understated by the same
  // amount.
  const baseAmount =
    Number(orderDoc?.subtotal ?? orderDoc?.pricing?.subtotal ?? 0) || 0;
  const restaurantIdRaw = orderDoc?.restaurantId ?? null;

  const empty = {
    commissionAmount: 0,
    commissionType: 'percentage',
    commissionValue: 0,
    baseAmount,
    billingMode: 'commission_overall',
  };

  if (!restaurantIdRaw) return empty;
  const restaurantId = String(restaurantIdRaw);

  const billingMode = await getRestaurantBillingMode(restaurantId);

  // The restaurant pays a monthly plan instead. Charging commission as well
  // would bill them twice for the same order.
  if (billingMode === 'subscription') {
    return { ...empty, billingMode };
  }

  const rules = await getActiveRestaurantCommissionRules();
  const rule = rules.find((r) => String(r.restaurantId) === restaurantId) || null;

  if (billingMode === 'commission_dish') {
    const lines = orderLines(orderDoc);
    // No lines means this was called with a pricing-only draft; the
    // restaurant rate against the subtotal is the honest approximation, and
    // createInitialTransaction recomputes from the saved order with its items.
    if (lines.length > 0) {
      const perItem = await getItemCommissionRules(restaurantId);
      return {
        commissionAmount: sumItemCommissions(lines, perItem, rule, baseAmount),
        commissionType: 'per_item',
        commissionValue: 0,
        baseAmount,
        billingMode,
      };
    }
  }

  if (!rule) return { ...empty, billingMode };

  return { ...computeRestaurantCommissionAmount(baseAmount, rule), billingMode };
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
