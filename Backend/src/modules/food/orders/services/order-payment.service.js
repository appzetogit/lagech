import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { toOrder, toFoodTransaction, orderInclude } from '../order.mapper.js';
import {
  ValidationError,
  ForbiddenError,
  NotFoundError,
} from '../../../../core/auth/errors.js';
import { logger } from '../../../../utils/logger.js';
import {
  createPaymentLink,
  fetchRazorpayPaymentLink,
  isRazorpayConfigured,
} from '../helpers/razorpay.helper.js';
import * as foodTransactionService from './foodTransaction.service.js';
import {
  buildOrderIdentityFilter,
  enqueueOrderEvent,
} from './order.helpers.js';

/** Accepts a raw id or a display id, same as buildOrderIdentityFilter. */
const orderIdentity = (orderId) =>
  isId(orderId) ? { id: String(orderId) } : { order_id: String(orderId) };

export async function syncRazorpayQrPayment(orderDoc) {
  const orderId = String(orderDoc?._id || orderDoc?.id || '');
  // FoodTransaction is the source of truth; the order's payment snapshot is fallback.
  const tx = await foodTransactionService.getTransactionByOrder(orderId);
  const payment = tx?.payment || orderDoc?.payment || null;
  if (!payment) {
    logger.warn(`[QrSync] No payment found for order ${orderId}`);
    return null;
  }

  // Allow sync if either the transaction OR the order carries razorpay_qr.
  const isQrMethod = payment.method === 'razorpay_qr';
  if (!isQrMethod) return payment;
  if (payment.status === 'paid') return payment;

  const paymentLinkId = payment?.qr?.paymentLinkId;
  if (!paymentLinkId) {
    logger.warn(`[QrSync] No paymentLinkId for order ${orderId}`);
    return payment;
  }
  if (!isRazorpayConfigured()) {
    logger.warn(`[QrSync] Razorpay not configured – cannot sync order ${orderId}`);
    return payment;
  }

  let link;
  try {
    link = await fetchRazorpayPaymentLink(paymentLinkId);
    logger.info(`[QrSync] Razorpay link status for ${paymentLinkId}: ${link?.status}`);
  } catch (error) {
    logger.error(
      `[QrSync] Razorpay payment-link fetch FAILED for ${paymentLinkId}: ${error?.message || error}`,
    );
    return payment;
  }

  const linkStatus = String(link?.status || '').toLowerCase();
  if (!linkStatus) {
    logger.warn(`[QrSync] Empty linkStatus for ${paymentLinkId}`);
    return payment;
  }

  // Razorpay Payment Link statuses: created, partially_paid, paid, expired, cancelled.
  // ONLY a fully-paid link counts. 'partially_paid' means some of the amount arrived, and
  // 'authorized' means funds are merely held, not captured — treating either as paid let a
  // rider hand over food for an order that was underpaid or never actually charged.
  const isPaid = ['paid', 'captured'].includes(linkStatus);
  const isFailed = ['expired', 'cancelled', 'canceled', 'failed'].includes(linkStatus);
  const newPaymentStatus = isPaid ? 'paid' : isFailed ? 'failed' : payment.status || 'pending_qr';

  if (['partially_paid', 'authorized'].includes(linkStatus)) {
    logger.warn(
      `[QrSync] Order ${orderId} link is '${linkStatus}' — NOT settling as paid. The rider must not hand over the order until it is fully captured.`,
    );
  }

  logger.info(
    `[QrSync] Updating order ${orderId} payment.status from '${payment.status}' to '${newPaymentStatus}'`,
  );

  await prisma.foodTransaction.updateMany({
    where: { orderId },
    data: {
      paymentStatusLabel: newPaymentStatus,
      qr: { ...(payment.qr || {}), status: linkStatus },
    },
  });

  // Keep the order's snapshot in step.
  if (isPaid) {
    await prisma.foodOrder.update({
      where: { id: orderId },
      data: { paymentStatus: 'paid', qr: { ...(payment.qr || {}), status: 'paid' } },
    });
  }

  const updatedTx = await foodTransactionService.getTransactionByOrder(orderId);
  return updatedTx?.payment || payment;
}

export async function createCollectQr(orderId, deliveryPartnerId, customerInfo = {}) {
  const row = await prisma.foodOrder.findFirst({
    where: orderIdentity(orderId),
    include: { ...orderInclude, user: { select: { id: true, name: true, email: true, phone: true } } },
  });

  if (!row) throw new NotFoundError('Order not found');
  const order = toOrder(row);

  if (String(order.dispatch.deliveryPartnerId || '') !== String(deliveryPartnerId)) {
    throw new ForbiddenError('Not your order');
  }

  const tx = await foodTransactionService.getTransactionByOrder(order.id);
  const payment = tx?.payment || order.payment || {};
  if (payment.method !== 'cash' && payment.status === 'paid') {
    throw new ValidationError('Order already paid');
  }

  const amountDue = payment.amountDue ?? tx?.pricing?.total ?? order.pricing?.total ?? 0;
  if (amountDue < 1) throw new ValidationError('No amount due');
  if (!isRazorpayConfigured()) {
    throw new ValidationError('QR payment not configured');
  }

  const user = row.user || {};
  const link = await createPaymentLink({
    amountPaise: Math.round(amountDue * 100),
    currency: 'INR',
    description: `Order ${order.id} - COD collect`,
    orderId: order.id,
    customerName: customerInfo.name || user.name || 'Customer',
    customerEmail: customerInfo.email || user.email || 'customer@example.com',
    customerPhone: customerInfo.phone || user.phone,
  });

  const qr = {
    paymentLinkId: link.id,
    shortUrl: link.short_url,
    imageUrl: link.short_url,
    status: link.status || 'created',
    expiresAt: link.expire_by ? new Date(link.expire_by * 1000).toISOString() : null,
  };

  // Upsert, so this works even when no FoodTransaction was created at order placement.
  await prisma.foodTransaction.upsert({
    where: { orderId: order.id },
    update: {
      paymentMethod: 'razorpay_qr',
      paymentStatusLabel: 'pending_qr',
      amountDue,
      qr,
    },
    create: {
      orderId: order.id,
      userId: order.userId,
      restaurantId: order.restaurantId,
      deliveryPartnerId: order.dispatch?.deliveryPartnerId || null,
      paymentMethod: 'razorpay_qr',
      paymentStatusLabel: 'pending_qr',
      amountDue,
      qr,
      currency: 'INR',
      status: 'pending',
      subtotal: order.pricing?.subtotal || 0,
      tax: order.pricing?.tax || 0,
      packagingFee: order.pricing?.packagingFee || 0,
      deliveryFee: order.pricing?.deliveryFee || 0,
      deliveryFeeGst: order.pricing?.deliveryFeeGst || 0,
      platformFee: order.pricing?.platformFee || 0,
      restaurantCommission: order.pricing?.restaurantCommission || 0,
      discount: order.pricing?.discount || 0,
      couponCode: order.pricing?.couponCode
        ? String(order.pricing.couponCode).trim().toUpperCase()
        : null,
      total: order.pricing?.total || 0,
      totalCustomerPaid: order.pricing?.total || 0,
      restaurantShare: 0,
      riderShare: 0,
      commissionAmount: 0,
      platformNetProfit: 0,
      history: {
        create: [
          { kind: 'created', amount: amountDue, note: 'Transaction auto-created at QR generation' },
        ],
      },
    },
  });

  // Also write to the order, so sync can find the paymentLinkId without a transaction row.
  await prisma.foodOrder.update({
    where: { id: order.id },
    data: { paymentMethod: 'razorpay_qr', paymentStatus: 'pending_qr', qr },
  });

  await foodTransactionService.updateTransactionStatus(order.id, 'cod_collect_qr_created', {
    recordedByRole: 'DELIVERY_PARTNER',
    recordedById: deliveryPartnerId,
    note: 'COD collection QR created',
  });

  enqueueOrderEvent('collect_qr_created', {
    orderMongoId: order.id,
    orderId: order.order_id || null,
    deliveryPartnerId,
    paymentLinkId: link.id,
    shortUrl: link.short_url,
    amountDue,
  });

  return {
    shortUrl: link?.short_url ?? link?.shortUrl ?? link?.short_url_path ?? null,
    imageUrl: link?.short_url ?? link?.image_url ?? link?.imageUrl ?? link?.image ?? null,
    amount: amountDue,
    expiresAt: link?.expire_by
      ? new Date(link.expire_by * 1000)
      : link?.expiresAt
        ? new Date(link.expiresAt)
        : null,
  };
}

export async function getPaymentStatus(orderId, deliveryPartnerId) {
  const identity = buildOrderIdentityFilter(orderId);
  if (!identity) throw new ValidationError('Order id required');

  const row = await prisma.foodOrder.findFirst({
    where: identity,
    select: {
      id: true,
      dispatchDeliveryPartnerId: true,
      riderEarning: true,
      platformProfit: true,
      paymentMethod: true,
      paymentStatus: true,
      paymentAmountDue: true,
      razorpayOrderId: true,
      razorpayPaymentId: true,
      razorpaySignature: true,
      qr: true,
      refundStatus: true,
      refundAmount: true,
      refundId: true,
      refundProcessedAt: true,
    },
  });
  if (!row) throw new NotFoundError('Order not found');
  if (String(row.dispatchDeliveryPartnerId || '') !== String(deliveryPartnerId)) {
    throw new ForbiddenError('Not your order');
  }

  const order = toOrder(row);
  let transaction = await foodTransactionService.getTransactionByOrder(row.id);
  const effectiveMethod = transaction?.payment?.method || order.payment?.method;
  const hasPaymentLink =
    transaction?.payment?.qr?.paymentLinkId || order.payment?.qr?.paymentLinkId;

  logger.info(
    `[getPaymentStatus] order=${row.id} method=${effectiveMethod} txStatus=${transaction?.payment?.status} hasLink=${!!hasPaymentLink}`,
  );

  if (
    effectiveMethod === 'razorpay_qr' &&
    transaction?.payment?.status !== 'paid' &&
    hasPaymentLink
  ) {
    await syncRazorpayQrPayment(order);
    transaction = await foodTransactionService.getTransactionByOrder(row.id);
    logger.info(`[getPaymentStatus] After sync: tx.payment.status=${transaction?.payment?.status}`);
  }

  const paymentData = transaction?.payment || order.payment || {};

  // History already arrives newest-first from getTransactionByOrder.
  const latestHistory = (transaction?.history || [])[0] || null;

  return {
    payment: paymentData,
    latestPaymentSnapshot: latestHistory,
    riderEarning: Number(row.riderEarning ?? 0),
    platformProfit: Number(row.platformProfit ?? 0),
    pricingTotal: transaction?.pricing?.total ?? 0,
    transactionStatus: transaction?.status ?? null,
  };
}

export async function switchToCash(orderId, deliveryPartnerId) {
  const where = orderIdentity(orderId);

  let row = await prisma.foodOrder.findFirst({ where, include: orderInclude });
  if (!row) throw new NotFoundError('Order not found');
  let order = toOrder(row);

  if (String(order.dispatch.deliveryPartnerId || '') !== String(deliveryPartnerId)) {
    throw new ForbiddenError('Not your order');
  }

  // The local payment status is only refreshed by syncRazorpayQrPayment. Without syncing
  // first, a customer who has already scanned and paid the QR still looks unpaid here, so
  // the rider collects cash as well — the customer pays twice and the QR payment is left
  // unattributed. Pull the real state from Razorpay before deciding.
  if (order.payment?.qr?.paymentLinkId) {
    try {
      await syncRazorpayQrPayment(order);
      row = await prisma.foodOrder.findFirst({ where, include: orderInclude });
      order = toOrder(row);
    } catch (err) {
      logger.warn(`switchToCash QR sync failed for ${order.id}: ${err?.message || err}`);
    }
  }

  // Only pay-at-delivery orders (legacy COD or QR-collect) may switch to cash.
  const orderPayMethod = String(order.payment?.method || '').toLowerCase();
  if (!['cash', 'razorpay_qr'].includes(orderPayMethod)) {
    throw new ValidationError('Online-paid orders cannot be switched to cash collection');
  }
  if (String(order.payment?.status || '').toLowerCase() === 'paid') {
    throw new ValidationError('Order is already paid');
  }

  // Reset the method on BOTH records. Updating only the transaction left the order at
  // razorpay_qr/pending_qr, so completeDelivery never flipped it to paid and the
  // cash-in-hand aggregations — which filter on the order's method 'cash' + status
  // 'paid' — never saw the money the rider actually collected.
  await prisma.$transaction([
    prisma.foodTransaction.updateMany({
      where: { orderId: order.id },
      data: { paymentMethod: 'cash', paymentStatusLabel: 'cod_pending', qr: {} },
    }),
    prisma.foodOrder.update({
      where: { id: order.id },
      data: { paymentMethod: 'cash', paymentStatus: 'cod_pending', qr: {} },
    }),
  ]);

  await foodTransactionService.updateTransactionStatus(order.id, 'cod_switched_to_cash', {
    recordedByRole: 'DELIVERY_PARTNER',
    recordedById: deliveryPartnerId,
    note: 'Rider switched from QR to Cash collection',
  });

  return { success: true };
}
