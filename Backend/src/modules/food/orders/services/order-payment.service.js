import { prisma } from '../../../../config/prisma.js';
import { toOrder, orderInclude } from '../order.mapper.js';
import {
  ValidationError,
  ForbiddenError,
  NotFoundError,
} from '../../../../core/auth/errors.js';
import { logger } from '../../../../utils/logger.js';
import { getIO, rooms } from '../../../../config/socket.js';
import {
  createPaymentLink,
  createQrCode,
  fetchQrCode,
  fetchQrCodePayments,
  closeQrCode,
  cancelPaymentLink,
  fetchRazorpayPaymentLink,
  initiateRazorpayRefund,
  isRazorpayConfigured,
} from '../helpers/razorpay.helper.js';
import { remainderAmount } from './partialPayment.service.js';
import * as foodTransactionService from './foodTransaction.service.js';
import {
  buildOrderIdentityFilter,
  enqueueOrderEvent,
} from './order.helpers.js';

/**
 * Collecting a pay-at-delivery order at the door: cash, or the customer scans a
 * Razorpay QR the rider shows.
 *
 *   - The QR is a single-use, fixed-amount UPI QR (Razorpay QR Codes API) for
 *     exactly what the rider would otherwise take in cash: the total less a
 *     partial payment's wallet part. When the account does not have QR Codes
 *     enabled, a payment link is raised instead and the app draws the QR.
 *   - The money goes to the platform's Razorpay account, never to the rider:
 *     a QR-paid order is paymentMethod 'razorpay_qr', so none of the rider
 *     cash-in-hand sums (which read paymentMethod 'cash') count it.
 *   - Payment is confirmed by the webhook (qr_code.credited, payment.captured,
 *     payment_link.paid) and, as a fallback, by asking Razorpay when the rider
 *     polls. Both go through recordQrPayment, which claims the order with one
 *     conditional UPDATE, so replays and the webhook/poll race settle it once.
 *   - A payment that cannot be the order's (the order is already paid -- by
 *     cash or an earlier QR payment --, cancelled, or the amount is wrong) is
 *     refunded automatically, once.
 */

/** How long a QR stays payable. Razorpay needs close_by at least 2 minutes ahead. */
export const QR_LIFETIME_SECONDS = 15 * 60;
/** Payment links must expire at least 15 minutes ahead; a little slack for clock drift. */
const LINK_LIFETIME_SECONDS = 20 * 60;
/** A QR this close to expiry is not handed out again; a fresh one is raised. */
const REUSE_MARGIN_MS = 60 * 1000;
/** The poll fallback asks Razorpay at most this often per order. */
export const REMOTE_CHECK_GAP_MS = 5000;

/** Methods paid at the door. */
const PAY_AT_DOOR = ['cash', 'razorpay_qr'];
const CANCELLED = ['cancelled_by_user', 'cancelled_by_restaurant', 'cancelled_by_admin'];

const money = (value) => Math.round((Number(value) || 0) * 100) / 100;
const asObject = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});

const lastRemoteCheck = new Map();

/** Clears the poll rate limit (tests). */
export function resetQrPollLimiterForTests() {
  lastRemoteCheck.clear();
}

let paymentEventListener = null;
/** Tests: observe payment_received events without a socket server. */
export function setPaymentEventListenerForTests(fn) {
  paymentEventListener = typeof fn === 'function' ? fn : null;
}

/** What the rider takes at the door: the total less a partial payment's wallet part. */
const amountDueOf = (row) => remainderAmount(row);

/** The QR snapshot as stored, plus whether it can still be paid. */
function qrState(qr) {
  const q = asObject(qr);
  if (!q.qrId && !q.paymentLinkId) return null;
  const expiresMs = q.expiresAt ? new Date(q.expiresAt).getTime() : null;
  let status = String(q.status || 'created').toLowerCase();
  if (['created', 'active', 'issued'].includes(status) && expiresMs && expiresMs <= Date.now()) {
    status = 'expired';
  }
  return { ...q, status, open: ['created', 'active', 'issued'].includes(status) };
}

/** Keeps the refunded-extra-payment markers when a writer replaces the qr snapshot. */
function carryMarkers(oldQr, next) {
  const ids = asObject(oldQr).extraPaymentIds;
  return Array.isArray(ids) && ids.length ? { ...next, extraPaymentIds: ids } : next;
}

/** Shape the app reads. */
function publicQr(q, amount) {
  if (!q) return null;
  return {
    kind: q.kind || (q.qrId ? 'qr' : 'link'),
    qrId: q.qrId || null,
    paymentLinkId: q.paymentLinkId || null,
    imageUrl: q.kind === 'link' ? null : q.imageUrl || null,
    shortUrl: q.shortUrl || null,
    amount: q.amount != null ? Number(q.amount) : amount,
    expiresAt: q.expiresAt || null,
    status: q.status,
  };
}

/** Best effort: close the QR and cancel the link so neither can be paid again. */
async function closeOpenQr(qr, { except = null } = {}) {
  const q = asObject(qr);
  if (!isRazorpayConfigured()) return;
  if (q.qrId && except !== 'qr') {
    try {
      await closeQrCode(q.qrId);
    } catch (err) {
      // A paid single-use QR is already closed; Razorpay says so with an error.
      logger.info(`[CollectQr] close QR ${q.qrId}: ${err?.error?.description || err?.message || err}`);
    }
  }
  if (q.paymentLinkId && except !== 'link') {
    try {
      await cancelPaymentLink(q.paymentLinkId);
    } catch (err) {
      logger.info(`[CollectQr] cancel link ${q.paymentLinkId}: ${err?.error?.description || err?.message || err}`);
    }
  }
}

function emitPaymentReceived(row, payload) {
  const event = {
    orderId: row.id,
    orderCode: row.orderId || row.order_id || null,
    method: 'razorpay_qr',
    ...payload,
  };
  if (paymentEventListener) {
    try { paymentEventListener(event, row); } catch { /* test hook */ }
  }
  try {
    const io = getIO();
    if (!io) return;
    if (row.dispatchDeliveryPartnerId) {
      io.to(rooms.delivery(row.dispatchDeliveryPartnerId)).emit('payment_received', event);
    }
    if (row.userId) io.to(rooms.user(row.userId)).emit('payment_received', event);
  } catch (err) {
    logger.warn(`[CollectQr] payment_received emit failed for ${row.id}: ${err?.message || err}`);
  }
}

const ORDER_PAY_SELECT = {
  id: true,
  orderId: true,
  order_id: true,
  userId: true,
  dispatchDeliveryPartnerId: true,
  orderStatus: true,
  total: true,
  walletAmount: true,
  paymentMethod: true,
  paymentStatus: true,
  razorpayPaymentId: true,
  qr: true,
};

/**
 * Refunds a payment that cannot be the order's, once.
 *
 * The payment id is added to qr.extraPaymentIds in the same statement that
 * checks it is not there yet, so a replayed webhook (or the poll racing it)
 * refunds nothing the second time. Razorpay also refuses to refund a fully
 * refunded payment, which backs this up.
 */
async function refundExtraPayment(row, paymentId, amountPaise, reason) {
  const claimed = await prisma.$executeRaw`
    UPDATE food_orders
       SET qr = jsonb_set(
             CASE WHEN jsonb_typeof(qr) = 'object' THEN qr ELSE '{}'::jsonb END,
             '{extraPaymentIds}',
             CASE WHEN jsonb_typeof(qr->'extraPaymentIds') = 'array' THEN qr->'extraPaymentIds' ELSE '[]'::jsonb END
               || jsonb_build_array(${paymentId}::text)
           )
     WHERE id = ${row.id}
       AND NOT (COALESCE(qr->'extraPaymentIds', '[]'::jsonb) @> jsonb_build_array(${paymentId}::text))`;
  if (!claimed) {
    logger.info(`[CollectQr] extra payment ${paymentId} for order ${row.id} already handled`);
    return { outcome: 'already_refunded' };
  }

  const amount = money(Number(amountPaise) / 100);
  logger.warn(
    `[CollectQr] Order ${row.id}: refunding QR payment ${paymentId} of Rs.${amount} -- ${reason}`,
  );
  const refund = await initiateRazorpayRefund(paymentId, amount).catch((err) => ({
    success: false,
    error: err?.message || String(err),
  }));
  if (!refund?.success) {
    logger.error(
      `[CollectQr] AUTO-REFUND FAILED for payment ${paymentId} (order ${row.id}, Rs.${amount}): ${refund?.error}. Refund it from the Razorpay dashboard.`,
    );
  }

  await foodTransactionService
    .updateTransactionStatus(row.id, refund?.success ? 'qr_extra_payment_refunded' : 'qr_extra_payment_refund_failed', {
      recordedByRole: 'SYSTEM',
      note: `Extra QR payment ${paymentId} of Rs.${amount} (${reason}). ${
        refund?.success ? `Refund ${refund.refundId} started.` : `Refund failed: ${refund?.error}`
      }`,
    })
    .catch((err) => logger.warn(`[CollectQr] history write failed: ${err?.message || err}`));

  return { outcome: refund?.success ? 'refunded' : 'refund_failed', refundId: refund?.refundId || null };
}

/**
 * Records a captured QR / payment-link payment against an order. Idempotent:
 * the webhook, its replays and the poll fallback may all call it for the same
 * payment.
 *
 * @param {object} p
 * @param {string} p.orderId      the order's primary key (from the QR's notes)
 * @param {string} p.paymentId    Razorpay payment id
 * @param {number} p.amountPaise  what Razorpay captured
 * @param {string} [p.via]        'qr' | 'link' -- which of the two was paid
 * @param {string} [p.source]     'webhook' | 'poll', for the logs
 * @returns {Promise<{outcome: string}>}
 */
export async function recordQrPayment({ orderId, paymentId, amountPaise, via = 'qr', source = 'webhook' }) {
  if (!orderId || !paymentId) return { outcome: 'ignored' };
  const row = await prisma.foodOrder.findUnique({ where: { id: String(orderId) }, select: ORDER_PAY_SELECT });
  if (!row) {
    logger.warn(`[CollectQr] ${source}: payment ${paymentId} names unknown order ${orderId}`);
    return { outcome: 'unknown_order' };
  }
  if (row.razorpayPaymentId === paymentId && row.paymentStatus === 'paid') {
    return { outcome: 'already_recorded' };
  }

  const expectedPaise = Math.round(amountDueOf(row) * 100);
  const paidPaise = Math.round(Number(amountPaise));
  const previousMethod = row.paymentMethod;

  if (paidPaise === expectedPaise && expectedPaise > 0) {
    // One conditional UPDATE: count is 1 only for the call that settled it.
    const { count } = await prisma.foodOrder.updateMany({
      where: {
        id: row.id,
        paymentStatus: { not: 'paid' },
        paymentMethod: { in: PAY_AT_DOOR },
        orderStatus: { notIn: CANCELLED },
      },
      data: { paymentMethod: 'razorpay_qr', paymentStatus: 'paid', razorpayPaymentId: paymentId },
    });
    if (count) {
      await afterQrPaid(row, { paymentId, amount: money(paidPaise / 100), via, source, previousMethod });
      return { outcome: 'paid' };
    }
    const now = await prisma.foodOrder.findUnique({ where: { id: row.id }, select: ORDER_PAY_SELECT });
    if (now?.razorpayPaymentId === paymentId && now.paymentStatus === 'paid') return { outcome: 'already_recorded' };
    return refundExtraPayment(now || row, paymentId, paidPaise, describeWhyNotOurs(now || row));
  }

  if (row.paymentStatus === 'paid' || CANCELLED.includes(row.orderStatus) || !PAY_AT_DOOR.includes(row.paymentMethod)) {
    return refundExtraPayment(row, paymentId, paidPaise, describeWhyNotOurs(row));
  }
  return refundExtraPayment(
    row,
    paymentId,
    paidPaise,
    `amount ${paidPaise} paise does not match the ${expectedPaise} paise due`,
  );
}

function describeWhyNotOurs(row) {
  if (CANCELLED.includes(row.orderStatus)) return 'the order is cancelled';
  if (row.paymentStatus === 'paid') {
    return row.paymentMethod === 'cash' ? 'the order was already paid in cash' : 'the order was already paid';
  }
  return 'the order is not collected at the door';
}

async function afterQrPaid(row, { paymentId, amount, via, source, previousMethod }) {
  const oldQr = asObject(row.qr);
  const qr = { ...oldQr, status: 'paid', paidAt: new Date().toISOString(), paymentId, paidVia: via };
  const switchedToCash = previousMethod === 'cash';

  await prisma.foodOrder.update({ where: { id: row.id }, data: { qr } });
  await prisma.foodTransaction.updateMany({
    where: { orderId: row.id },
    data: { paymentMethod: 'razorpay_qr', paymentStatusLabel: 'paid', qr },
  });
  // Online money received by the platform, recorded the way a Razorpay
  // checkout payment is: the ledger row captured, with the payment id.
  await foodTransactionService
    .updateTransactionStatus(row.id, 'captured', {
      status: 'captured',
      razorpayPaymentId: paymentId,
      recordedByRole: 'SYSTEM',
      note: `COD collected by Razorpay QR: payment ${paymentId}, Rs.${amount} (${source})`,
    })
    .catch((err) => logger.warn(`[CollectQr] ledger write failed for ${row.id}: ${err?.message || err}`));

  logger.info(`[CollectQr] Order ${row.id} paid by QR: ${paymentId} Rs.${amount} via ${via} (${source})`);

  await closeOpenQr(oldQr, { except: via });

  emitPaymentReceived(row, {
    amount,
    paymentId,
    paid: true,
    collectCash: false,
    message: switchedToCash
      ? `Customer paid Rs.${amount} by QR. Do NOT collect cash.`
      : `Paid ✓ Rs.${amount} received`,
  });
  enqueueOrderEvent('collect_qr_paid', {
    orderMongoId: row.id,
    orderId: row.orderId || null,
    deliveryPartnerId: row.dispatchDeliveryPartnerId,
    paymentId,
    amount,
  });
}

/**
 * Asks Razorpay whether the order's QR (or link) has been paid, and records it
 * if so. Rate limited per order unless forced; never throws.
 */
async function reconcileWithRazorpay(row, { force = false } = {}) {
  const q = qrState(row.qr);
  if (!q || !isRazorpayConfigured()) return false;
  const last = lastRemoteCheck.get(row.id) || 0;
  if (!force && Date.now() - last < REMOTE_CHECK_GAP_MS) return false;
  lastRemoteCheck.set(row.id, Date.now());
  if (lastRemoteCheck.size > 5000) {
    for (const [id, at] of lastRemoteCheck) if (Date.now() - at > 60_000) lastRemoteCheck.delete(id);
  }

  try {
    if (q.qrId) {
      const remote = await fetchQrCode(q.qrId);
      const received = Number(remote?.payments_amount_received || 0);
      if (received > 0 || String(remote?.close_reason || '') === 'paid') {
        const payments = await fetchQrCodePayments(q.qrId);
        const captured = payments.filter((p) => String(p?.status || '').toLowerCase() === 'captured');
        for (const p of captured) {
          await recordQrPayment({ orderId: row.id, paymentId: p.id, amountPaise: p.amount, via: 'qr', source: 'poll' });
        }
        if (captured.length) return true;
      } else if (String(remote?.status || '') === 'closed' && q.open) {
        await markQrClosed(row.id, 'expired');
      }
    }
    if (q.paymentLinkId) {
      const link = await fetchRazorpayPaymentLink(q.paymentLinkId);
      const status = String(link?.status || '').toLowerCase();
      // ONLY a fully paid link counts: 'partially_paid' is short of the amount.
      if (status === 'paid') {
        const payments = (Array.isArray(link?.payments) ? link.payments : []).filter(
          (p) => String(p?.status || '').toLowerCase() === 'captured',
        );
        for (const p of payments) {
          await recordQrPayment({
            orderId: row.id,
            paymentId: p.payment_id || p.id,
            amountPaise: p.amount,
            via: 'link',
            source: 'poll',
          });
        }
        return payments.length > 0;
      }
      if (['expired', 'cancelled'].includes(status) && q.open && !q.qrId) {
        await markQrClosed(row.id, 'expired');
      }
    }
  } catch (err) {
    logger.warn(`[CollectQr] Razorpay check failed for order ${row.id}: ${err?.error?.description || err?.message || err}`);
  }
  return false;
}

async function markQrClosed(orderId, status) {
  const row = await prisma.foodOrder.findUnique({ where: { id: orderId }, select: { qr: true, paymentStatus: true } });
  if (!row || row.paymentStatus === 'paid') return;
  const qr = { ...asObject(row.qr), status };
  await prisma.foodOrder.updateMany({ where: { id: orderId, paymentStatus: { not: 'paid' } }, data: { qr } });
  await prisma.foodTransaction.updateMany({ where: { orderId }, data: { qr } });
}

/**
 * Brings an order's QR payment state up to date with Razorpay and returns the
 * payment snapshot. Used by the delivery guard and switch-to-cash, which must
 * not act on stale state, so it is not rate limited.
 */
export async function syncRazorpayQrPayment(orderDoc) {
  const orderId = String(orderDoc?._id || orderDoc?.id || '');
  // FoodTransaction is the source of truth; the order's payment snapshot is fallback.
  const tx = await foodTransactionService.getTransactionByOrder(orderId);
  const payment = tx?.payment || orderDoc?.payment || null;
  if (!payment) {
    logger.warn(`[QrSync] No payment found for order ${orderId}`);
    return null;
  }
  if (payment.method !== 'razorpay_qr' || payment.status === 'paid') return payment;

  const row = await prisma.foodOrder.findUnique({ where: { id: orderId }, select: ORDER_PAY_SELECT });
  if (!row) return payment;
  if (row.paymentStatus === 'paid') {
    const fresh = await foodTransactionService.getTransactionByOrder(orderId);
    return fresh?.payment || { ...payment, status: 'paid' };
  }
  if (!qrState(row.qr)) {
    logger.warn(`[QrSync] No QR or payment link on order ${orderId}`);
    return payment;
  }
  if (!isRazorpayConfigured()) {
    logger.warn(`[QrSync] Razorpay not configured – cannot sync order ${orderId}`);
    return payment;
  }

  await reconcileWithRazorpay(row, { force: true });
  const after = await prisma.foodOrder.findUnique({ where: { id: orderId }, select: { paymentStatus: true, paymentMethod: true } });
  const updatedTx = await foodTransactionService.getTransactionByOrder(orderId);
  const out = updatedTx?.payment || payment;
  return after?.paymentStatus === 'paid' ? { ...out, method: after.paymentMethod, status: 'paid' } : out;
}

async function loadOwnedOrder(orderId, deliveryPartnerId, include = undefined) {
  const identity = buildOrderIdentityFilter(orderId);
  if (!identity) throw new ValidationError('Order id required');
  const row = await prisma.foodOrder.findFirst({ where: identity, ...(include ? { include } : {}) });
  if (!row) throw new NotFoundError('Order not found');
  if (String(row.dispatchDeliveryPartnerId || '') !== String(deliveryPartnerId)) {
    throw new ForbiddenError('Not your order');
  }
  return row;
}

/**
 * POST /food/delivery/orders/:orderId/collect/qr
 *
 * Raises (or hands back the still-open) QR for what the customer owes at the
 * door. Refused when the order is not the rider's, is not pay-at-delivery, is
 * already paid, is cancelled or delivered, or nothing is due.
 */
export async function createCollectQr(orderId, deliveryPartnerId, customerInfo = {}) {
  const row = await loadOwnedOrder(orderId, deliveryPartnerId, {
    ...orderInclude,
    user: { select: { id: true, name: true, email: true, phone: true } },
  });
  const order = toOrder(row);

  if (row.paymentStatus === 'paid') throw new ValidationError('Order already paid');
  if (!PAY_AT_DOOR.includes(row.paymentMethod)) {
    throw new ValidationError('This order is not paid at delivery, so there is nothing to collect');
  }
  if (CANCELLED.includes(row.orderStatus)) throw new ValidationError('Order is cancelled');
  if (row.orderStatus === 'delivered') throw new ValidationError('Order is already delivered');

  const amountDue = amountDueOf(row);
  if (amountDue < 1) throw new ValidationError('No amount due');
  if (!isRazorpayConfigured()) {
    throw new ValidationError('QR payment not configured');
  }

  // A QR for this order and amount that can still be paid is handed back, so
  // reopening the sheet does not leave several live QRs for one order.
  const existing = row.paymentMethod === 'razorpay_qr' ? qrState(row.qr) : null;
  if (
    existing?.open &&
    money(existing.amount) === amountDue &&
    existing.expiresAt &&
    new Date(existing.expiresAt).getTime() - Date.now() > REUSE_MARGIN_MS
  ) {
    return { ...publicQr(existing, amountDue), reused: true };
  }
  // Anything older (expired, about to, or for another amount) is closed first.
  if (existing) await closeOpenQr(existing);

  const notes = { orderId: order.id, orderCode: String(row.orderId || row.order_id || ''), purpose: 'cod_collect' };
  const description = `Order ${row.orderId || row.order_id || order.id}`;
  const nowSec = Math.floor(Date.now() / 1000);
  let qr;
  try {
    const created = await createQrCode({
      amountPaise: Math.round(amountDue * 100),
      closeBy: nowSec + QR_LIFETIME_SECONDS,
      name: 'Lagech',
      description,
      notes,
    });
    if (!created?.id || !created?.image_url) throw new Error('Razorpay returned no QR image');
    qr = {
      kind: 'qr',
      qrId: created.id,
      imageUrl: created.image_url,
      amount: amountDue,
      status: 'created',
      createdAt: new Date().toISOString(),
      expiresAt: new Date((created.close_by || nowSec + QR_LIFETIME_SECONDS) * 1000).toISOString(),
    };
  } catch (err) {
    // QR Codes not enabled on the account (or the API is down): a payment link
    // collects the same amount; the app draws the QR from its URL.
    logger.warn(
      `[CollectQr] QR Codes API failed for order ${order.id} (${err?.error?.description || err?.message || err}); falling back to a payment link`,
    );
    const user = row.user || {};
    const link = await createPaymentLink({
      amountPaise: Math.round(amountDue * 100),
      currency: 'INR',
      description,
      orderId: order.id,
      customerName: customerInfo.name || user.name || 'Customer',
      customerEmail: customerInfo.email || user.email || 'customer@example.com',
      customerPhone: customerInfo.phone || user.phone,
      notes,
      expireBy: nowSec + LINK_LIFETIME_SECONDS,
    });
    qr = {
      kind: 'link',
      paymentLinkId: link.id,
      shortUrl: link.short_url,
      amount: amountDue,
      status: 'created',
      createdAt: new Date().toISOString(),
      expiresAt: new Date((link.expire_by || nowSec + LINK_LIFETIME_SECONDS) * 1000).toISOString(),
    };
  }
  qr = carryMarkers(row.qr, qr);

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
      // The raw ids: the mapped order turns included relations into objects.
      userId: row.userId,
      restaurantId: row.restaurantId,
      deliveryPartnerId: row.dispatchDeliveryPartnerId || null,
      paymentMethod: 'razorpay_qr',
      paymentStatusLabel: 'pending_qr',
      amountDue,
      walletAmount: Number(row.walletAmount) || 0,
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

  // Only an order that is still unpaid moves: a payment that landed while the
  // QR was being created must not be overwritten back to pending.
  await prisma.foodOrder.updateMany({
    where: { id: order.id, paymentStatus: { not: 'paid' } },
    data: { paymentMethod: 'razorpay_qr', paymentStatus: 'pending_qr', qr },
  });

  await foodTransactionService.updateTransactionStatus(order.id, 'cod_collect_qr_created', {
    recordedByRole: 'DELIVERY_PARTNER',
    recordedById: deliveryPartnerId,
    note: `COD collection ${qr.kind === 'qr' ? 'QR' : 'payment link'} created for Rs.${amountDue}`,
  });

  enqueueOrderEvent('collect_qr_created', {
    orderMongoId: order.id,
    orderId: row.orderId || null,
    deliveryPartnerId,
    qrId: qr.qrId || null,
    paymentLinkId: qr.paymentLinkId || null,
    amountDue,
  });

  return { ...publicQr(qr, amountDue), reused: false };
}

/**
 * GET /food/delivery/orders/:orderId/payment-status
 *
 * Safe to poll every few seconds: while a QR is open and unpaid it asks
 * Razorpay itself, at most once per REMOTE_CHECK_GAP_MS per order, in case the
 * webhook is late or missing.
 */
export async function getPaymentStatus(orderId, deliveryPartnerId) {
  let row = await loadOwnedOrder(orderId, deliveryPartnerId);

  if (row.paymentMethod === 'razorpay_qr' && row.paymentStatus !== 'paid' && qrState(row.qr)?.open) {
    if (await reconcileWithRazorpay(row)) {
      row = await prisma.foodOrder.findUnique({ where: { id: row.id } });
    }
  }

  const order = toOrder(row);
  const transaction = await foodTransactionService.getTransactionByOrder(row.id);
  const paymentData = transaction?.payment || order.payment || {};
  // History already arrives newest-first from getTransactionByOrder.
  const latestHistory = (transaction?.history || [])[0] || null;

  const amount = amountDueOf(row);
  const paid = row.paymentStatus === 'paid';
  const q = qrState(row.qr);

  return {
    paid,
    method: row.paymentMethod,
    status: row.paymentStatus,
    amount,
    paidByQr: paid && row.paymentMethod === 'razorpay_qr',
    // Cash is only taken for an unpaid order the rider has not put on QR.
    collectCash: !paid && row.paymentMethod === 'cash',
    qr: row.paymentMethod === 'razorpay_qr' || paid ? publicQr(q, amount) : null,
    payment: paid ? { ...paymentData, method: row.paymentMethod, status: 'paid' } : paymentData,
    latestPaymentSnapshot: latestHistory,
    riderEarning: Number(row.riderEarning ?? 0),
    platformProfit: Number(row.platformProfit ?? 0),
    pricingTotal: transaction?.pricing?.total ?? 0,
    transactionStatus: transaction?.status ?? null,
  };
}

/**
 * POST /food/delivery/orders/:orderId/collect/cash
 *
 * The rider takes cash instead. Any open QR or link is closed first so the
 * customer cannot also pay it; one paid in the meantime still settles the
 * order (by QR) and the rider is told not to take cash.
 */
export async function switchToCash(orderId, deliveryPartnerId) {
  let row = await loadOwnedOrder(orderId, deliveryPartnerId, orderInclude);

  // A customer who already scanned and paid must not be charged cash as well:
  // pull the real state from Razorpay before deciding.
  if (row.paymentMethod === 'razorpay_qr' && row.paymentStatus !== 'paid' && qrState(row.qr)) {
    try {
      await syncRazorpayQrPayment(toOrder(row));
      row = await prisma.foodOrder.findUnique({ where: { id: row.id }, include: orderInclude });
    } catch (err) {
      logger.warn(`switchToCash QR sync failed for ${row.id}: ${err?.message || err}`);
    }
  }

  // Only pay-at-delivery orders (legacy COD or QR-collect) may switch to cash.
  const orderPayMethod = String(row.paymentMethod || '').toLowerCase();
  if (!PAY_AT_DOOR.includes(orderPayMethod)) {
    throw new ValidationError('Online-paid orders cannot be switched to cash collection');
  }
  if (String(row.paymentStatus || '').toLowerCase() === 'paid') {
    throw new ValidationError(
      orderPayMethod === 'razorpay_qr'
        ? 'Order is already paid by QR. Do not collect cash.'
        : 'Order is already paid',
    );
  }

  const oldQr = asObject(row.qr);
  await closeOpenQr(oldQr);

  // Reset the method on BOTH records. Updating only the transaction left the order at
  // razorpay_qr/pending_qr, so completeDelivery never flipped it to paid and the
  // cash-in-hand aggregations — which filter on the order's method 'cash' — never
  // saw the money the rider actually collected.
  const qr = carryMarkers(oldQr, {});
  const [, moved] = await prisma.$transaction([
    prisma.foodTransaction.updateMany({
      where: { orderId: row.id },
      data: { paymentMethod: 'cash', paymentStatusLabel: 'cod_pending', qr },
    }),
    prisma.foodOrder.updateMany({
      where: { id: row.id, paymentStatus: { not: 'paid' } },
      data: { paymentMethod: 'cash', paymentStatus: 'cod_pending', qr },
    }),
  ]);
  if (!moved.count) {
    // Paid by QR between the check and the switch.
    throw new ValidationError('Order is already paid by QR. Do not collect cash.');
  }

  await foodTransactionService.updateTransactionStatus(row.id, 'cod_switched_to_cash', {
    recordedByRole: 'DELIVERY_PARTNER',
    recordedById: deliveryPartnerId,
    note: oldQr.qrId || oldQr.paymentLinkId
      ? `Rider switched from QR to Cash collection (closed ${oldQr.qrId || oldQr.paymentLinkId})`
      : 'Rider switched from QR to Cash collection',
  });

  return { success: true, method: 'cash', amount: amountDueOf(row) };
}

/**
 * Razorpay webhook events for door collection. Returns true when the event was
 * a door-collection event (handled or deliberately ignored), false when it is
 * not ours and the caller should process it as before.
 */
export async function handleCollectWebhookEvent(event, payload = {}) {
  const payment = payload?.payment?.entity || null;
  const qrEntity = payload?.qr_code?.entity || null;
  const linkEntity = payload?.payment_link?.entity || null;
  const notes = {
    ...asObject(qrEntity?.notes),
    ...asObject(linkEntity?.notes),
    ...asObject(payment?.notes),
  };

  let orderId = notes.purpose === 'cod_collect' ? notes.orderId : null;
  let via = qrEntity ? 'qr' : linkEntity ? 'link' : null;

  // No notes on the payment (Razorpay does not always copy them): find the
  // order by the QR or link it was raised with.
  if (!orderId) {
    const qrId = qrEntity?.id || payment?.qr_code_id || null;
    const linkId = linkEntity?.id || null;
    if (qrId || linkId) {
      const found = await prisma.foodOrder.findFirst({
        where: qrId ? { qr: { path: ['qrId'], equals: qrId } } : { qr: { path: ['paymentLinkId'], equals: linkId } },
        select: { id: true },
      });
      if (found) {
        orderId = found.id;
        via = qrId ? 'qr' : 'link';
      }
    }
  }

  const ours = ['qr_code.credited', 'payment.captured', 'payment_link.paid'].includes(event) && orderId;
  if (!ours) return false;
  if (!payment?.id) {
    logger.warn(`[CollectQr] ${event} for order ${orderId} carries no payment`);
    return true;
  }
  if (String(payment.status || 'captured').toLowerCase() !== 'captured') {
    logger.info(`[CollectQr] ${event} payment ${payment.id} is ${payment.status}; waiting for capture`);
    return true;
  }
  await recordQrPayment({
    orderId,
    paymentId: payment.id,
    amountPaise: payment.amount,
    via: via || 'qr',
    source: `webhook:${event}`,
  });
  return true;
}
