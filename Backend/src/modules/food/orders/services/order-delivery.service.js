import { prisma } from '../../../../config/prisma.js';
import { toOrder, toOrders, orderInclude } from '../order.mapper.js';
import {
  ValidationError,
  ForbiddenError,
  NotFoundError,
} from '../../../../core/auth/errors.js';
import { buildPaginatedResult, buildPaginationOptions } from '../../../../utils/helpers.js';
import { logger } from '../../../../utils/logger.js';
import { getIO, rooms } from '../../../../config/socket.js';
import { getFirebaseDB } from '../../../../config/firebase.js';
import { fetchDrivingRoute } from '../utils/googleMaps.js';

import * as foodTransactionService from './foodTransaction.service.js';
import * as dispatchService from './order-dispatch.service.js';
import * as paymentService from './order-payment.service.js';

import {
  buildOrderIdentityFilter,
  emitDeliveryDropOtpToUser,
  enqueueOrderEvent,
  generateFourDigitDeliveryOtp,
  haversineKm,
  notifyOwnerSafely,
  notifyOwnersSafely,
  partnerHasActiveDelivery,
  pushStatusHistory,
  sanitizeOrderForDeliveryPartner,
  TERMINAL_ORDER_STATUSES,
  isStatusAdvance,
} from './order.helpers.js';

/**
 * The restaurant fields the rider app needs.
 *
 * All four image fields are included because the model carries two separate pairs
 * and onboarding does not consistently fill the same one: coverImage is the single
 * hero (falling back to coverImages[0]), and galleryImages/menuImages are distinct
 * arrays. Selecting one pair returns empty for restaurants that filled the other.
 * ownerPhone backs the tap-to-call button; lat/lng give the exact pin.
 */
const DELIVERY_RESTAURANT_SELECT = {
  id: true, restaurantName: true, ownerPhone: true, primaryContactNumber: true,
  latitude: true, longitude: true, addressLine1: true, area: true, city: true,
  state: true, pincode: true, landmark: true, profileImage: true,
  coverImage: true, coverImages: true, galleryImages: true, menuImages: true,
};

const deliveryInclude = {
  ...orderInclude,
  restaurant: { select: DELIVERY_RESTAURANT_SELECT },
  user: { select: { id: true, name: true, phone: true, email: true } },
};

function mergeTransactionIntoOrder(order, tx) {
  if (!tx) return order;
  return {
    ...order,
    paymentMethod: tx.payment?.method || tx.paymentMethod || order.paymentMethod,
    payment: tx.payment || order.payment,
    pricing: tx.pricing || order.pricing,
    amounts: tx.amounts || order.amounts,
    transactionStatus: tx.status || order.transactionStatus,
  };
}

/** Load the per-order splits for a batch of orders, keyed by order id. */
async function loadTransactionsByOrder(orderIds) {
  if (!orderIds.length) return new Map();
  const rows = await prisma.foodTransaction.findMany({ where: { orderId: { in: orderIds } } });
  const { toFoodTransaction } = await import('../order.mapper.js');
  return new Map(rows.map((tx) => [tx.orderId, toFoodTransaction(tx)]));
}

function emitOrderUpdate(order, deliveryPartnerId) {
  try {
    const io = getIO();
    if (io) {
      const payload = {
        orderMongoId: order.id,
        orderId: order.id,
        orderStatus: order.orderStatus,
        deliveryState: order.deliveryState,
        deliveryVerification: order.deliveryVerification,
      };
      io.to(rooms.delivery(deliveryPartnerId)).emit('order_status_update', payload);
      io.to(rooms.restaurant(order.restaurantId?.id ?? order.restaurantId)).emit('order_status_update', payload);
      io.to(rooms.user(order.userId?.id ?? order.userId)).emit('order_status_update', payload);
    }

    // Push only for the key delivery milestones.
    const status = order.orderStatus;
    if (!['picked_up', 'reached_drop', 'delivered'].includes(status)) return;

    const orderId = order.id;
    let userTitle = '';
    let userBody = '';
    let riderTitle = '';
    let riderBody = '';

    if (status === 'picked_up') {
      userTitle = 'Order on the way!';
      userBody = `Partner has picked up your order #${orderId} and is heading your way.`;
      riderTitle = 'Order picked up!';
      riderBody = `You have picked up order #${orderId}. Proceed to the customer location.`;
    } else if (status === 'reached_drop') {
      userTitle = 'Partner nearby!';
      userBody = `Your delivery partner has reached your location for order #${orderId}.`;
      riderTitle = 'Arrived at drop!';
      riderBody = `You have reached the customer location for order #${orderId}.`;
    } else if (status === 'delivered') {
      userTitle = `Order #${orderId} delivered!`;
      userBody = "Hope you enjoyed your meal! Don't forget to rate your experience.";
      riderTitle = 'Delivery successful!';
      riderBody = `Order #${orderId} has been successfully delivered.`;

      if (order.payment?.method === 'cash' || order.paymentMethod === 'cash') {
        riderTitle = 'Payment collected!';
        const amt = order.pricing?.total || order.amounts?.totalCustomerPaid || 0;
        riderBody = `You have collected Rs ${amt} cash for Order #${orderId}.`;
      }
    }

    if (userTitle) {
      void notifyOwnersSafely(
        [
          { ownerType: 'RESTAURANT', ownerId: order.restaurantId?.id ?? order.restaurantId },
          { ownerType: 'USER', ownerId: order.userId?.id ?? order.userId },
        ],
        {
          title: userTitle,
          body: userBody,
          // Visible banner + data for deep-linking. Without the notification block
          // these milestones stay silent when the app is backgrounded.
          data: { type: 'order_status_update', orderId, orderMongoId: orderId, orderStatus: status },
        },
      );
    }

    if (riderTitle) {
      void notifyOwnerSafely(
        { ownerType: 'DELIVERY_PARTNER', ownerId: deliveryPartnerId },
        {
          title: riderTitle,
          body: riderBody,
          data: {
            type: status === 'delivered' ? 'order_completed' : 'order_status_update',
            orderId,
            orderMongoId: orderId,
            paymentMethod: order.payment?.method || order.paymentMethod,
            amountCollected: String(order.pricing?.total || order.amounts?.totalCustomerPaid || 0),
          },
        },
      );
    }
  } catch (error) {
    logger.error(`Error emitting delivery order update: ${error?.message || error}`);
  }
}

/** Lazy wrapper to avoid a circular ESM init race. */
async function syncRazorpayQrPayment(orderDoc) {
  return paymentService.syncRazorpayQrPayment(orderDoc);
}

/** Fetch one order by identity, mapped, or throw. */
async function loadOrder(orderId, include = orderInclude) {
  const identity = buildOrderIdentityFilter(orderId);
  if (!identity) throw new ValidationError('Order id required');
  const row = await prisma.foodOrder.findFirst({ where: identity, include });
  if (!row) throw new NotFoundError('Order not found');
  return { row, order: toOrder(row) };
}

function assertOwnedBy(row, deliveryPartnerId) {
  if (String(row.dispatchDeliveryPartnerId || '') !== String(deliveryPartnerId)) {
    throw new ForbiddenError('Not your order');
  }
}

export async function getCurrentTripDelivery(deliveryPartnerId) {
  if (!deliveryPartnerId) throw new ValidationError('Delivery partner ID required');

  const row = await prisma.foodOrder.findFirst({
    where: {
      dispatchDeliveryPartnerId: String(deliveryPartnerId),
      dispatchStatus: 'accepted',
      orderStatus: { in: ['confirmed', 'preparing', 'ready_for_pickup', 'picked_up'] },
    },
    include: deliveryInclude,
    orderBy: { updatedAt: 'desc' },
  });

  if (!row) return null;

  const txByOrder = await loadTransactionsByOrder([row.id]);
  return sanitizeOrderForDeliveryPartner(
    mergeTransactionIntoOrder(toOrder(row), txByOrder.get(row.id) || null),
  );
}

export async function listOrdersAvailableDelivery(deliveryPartnerId, query) {
  const { page, limit, skip } = buildPaginationOptions(query);
  const partnerId = String(deliveryPartnerId);
  const hasActiveDelivery = await partnerHasActiveDelivery(partnerId);

  const where = hasActiveDelivery
    ? {
        dispatchDeliveryPartnerId: partnerId,
        dispatchStatus: 'accepted',
        orderStatus: { notIn: TERMINAL_ORDER_STATUSES },
      }
    : {
        OR: [
          {
            dispatchStatus: 'unassigned',
            // The $not/$elemMatch guard becomes a relation filter: no deassign
            // record for this rider on this order.
            dispatchOffers: { none: { partnerId, action: 'deassigned' } },
            orderStatus: { in: ['confirmed', 'preparing', 'ready_for_pickup'] },
          },
          {
            dispatchDeliveryPartnerId: partnerId,
            dispatchStatus: { in: ['assigned', 'accepted'] },
            orderStatus: { notIn: TERMINAL_ORDER_STATUSES },
          },
        ],
      };

  // For idle partners, pull a wider candidate set then proximity-filter in memory.
  // Avoids returning another city's orders that the poll hydrate could lock into the modal.
  const queryLimit = hasActiveDelivery ? limit : Math.max(limit * 5, 50);

  const rows = await prisma.foodOrder.findMany({
    where,
    include: deliveryInclude,
    orderBy: { createdAt: 'desc' },
    take: queryLimit,
  });

  const txByOrder = await loadTransactionsByOrder(rows.map((r) => r.id));

  let enriched = toOrders(rows).map((order) =>
    sanitizeOrderForDeliveryPartner(
      mergeTransactionIntoOrder(order, txByOrder.get(order.id) || null),
    ),
  );

  if (!hasActiveDelivery) {
    const partner = await prisma.foodDeliveryPartner.findUnique({
      where: { id: partnerId },
      select: { lastLat: true, lastLng: true, lastLocationAt: true },
    });

    const MAX_OFFER_KM = 20; // slightly wider than the dispatch radius (15km)
    const partnerLat = partner?.lastLat;
    const partnerLng = partner?.lastLng;
    const hasPartnerGps =
      partnerLat != null && partnerLng != null &&
      Number.isFinite(Number(partnerLat)) && Number.isFinite(Number(partnerLng));

    const withMeta = enriched.map((order) => {
      const assignedTo = order?.dispatch?.deliveryPartnerId;
      const assignedToMe = Boolean(
        assignedTo && String(assignedTo?.id ?? assignedTo) === partnerId,
      );

      const offeredToMe = Array.isArray(order?.dispatch?.offeredTo)
        ? order.dispatch.offeredTo.some((entry) => String(entry?.partnerId) === partnerId)
        : false;

      let distanceKm = null;
      const restaurant = order?.restaurantId;
      if (hasPartnerGps && restaurant?.latitude != null && restaurant?.longitude != null) {
        const d = haversineKm(
          Number(partnerLat), Number(partnerLng),
          Number(restaurant.latitude), Number(restaurant.longitude),
        );
        if (Number.isFinite(d)) distanceKm = d;
      }

      return { order, assignedToMe, offeredToMe, distanceKm };
    });

    const kept = withMeta.filter(({ assignedToMe, offeredToMe, distanceKm }) => {
      if (assignedToMe) return true;
      // No partner GPS: only show orders already offered to this rider (safe vs a global leak).
      if (!hasPartnerGps) return offeredToMe;
      // Missing/unresolvable restaurant coords: same offered-only rule.
      if (distanceKm == null) return offeredToMe;
      if (distanceKm <= MAX_OFFER_KM) return true;
      // Already offered to this rider: allow a small GPS-drift buffer, else drop.
      return offeredToMe && distanceKm <= MAX_OFFER_KM * 1.5;
    });

    // Rank so consumers that take the head (reconnect recovery, poll hydrate)
    // surface the order this rider was actually offered — not just the newest in
    // range, which could sit somewhere else entirely.
    kept.sort((a, b) => {
      if (a.assignedToMe !== b.assignedToMe) return a.assignedToMe ? -1 : 1;
      if (a.offeredToMe !== b.offeredToMe) return a.offeredToMe ? -1 : 1;
      const da = a.distanceKm == null ? Infinity : a.distanceKm;
      const db = b.distanceKm == null ? Infinity : b.distanceKm;
      return da - db;
    });

    // Surface the rider → restaurant distance already computed for filtering. The
    // socket offer carries pickupDistanceKm, so REST must too — otherwise a rider
    // polling sees the earning without the travel distance.
    enriched = kept.map(({ order, distanceKm }) => ({
      ...order,
      pickupDistanceKm: distanceKm == null ? null : Number(Number(distanceKm).toFixed(2)),
    }));
  }

  const total = enriched.length;
  const paged = hasActiveDelivery ? enriched.slice(0, limit) : enriched.slice(skip, skip + limit);

  return buildPaginatedResult({ docs: paged, total, page, limit });
}

/**
 * Rejects an accept when the rider is already at their cash ceiling.
 *
 * Dispatch skips over-limit riders, but an offer sent a moment BEFORE they crossed
 * the line is still sitting on their phone — and a client-side block would be
 * trivially bypassed anyway. This is the authoritative check.
 *
 * Prepaid orders are unaffected. A limit of 0 means no limit, matching the default.
 */
async function assertCashLimitAllows(deliveryPartnerId, order) {
  const method = String(order?.payment?.method || order?.paymentMethod || '').toLowerCase();
  if (method !== 'cash' && method !== 'razorpay_qr') return;

  const [settings, wallet] = await Promise.all([
    prisma.foodDeliveryCashLimit.findFirst({
      where: { isActive: true },
      select: { deliveryCashLimit: true },
    }),
    prisma.wallet.findUnique({
      where: { entityType_entityId: { entityType: 'deliveryBoy', entityId: String(deliveryPartnerId) } },
      select: { cashInHand: true },
    }),
  ]);

  const limit = Number(settings?.deliveryCashLimit) || 0;
  if (limit <= 0) return;

  const inHand = Number(wallet?.cashInHand) || 0;
  if (inHand >= limit) {
    throw new ValidationError(
      `You are holding Rs.${inHand} in cash, which is at your Rs.${limit} limit. ` +
        'Deposit your cash to keep accepting cash orders.',
    );
  }
}

export async function acceptOrderDelivery(orderId, deliveryPartnerId) {
  const identity = buildOrderIdentityFilter(orderId);
  if (!identity) throw new ValidationError('Order id required');

  const partnerId = String(deliveryPartnerId);
  const now = new Date();
  const acceptedStatuses = ['created', 'confirmed', 'preparing', 'ready_for_pickup', 'picked_up'];
  const cancellableStatuses = [
    'cancelled_by_user', 'cancelled_by_restaurant', 'cancelled_by_admin',
  ];

  const requested = await prisma.foodOrder.findFirst({
    where: identity,
    select: { id: true, paymentMethod: true, paymentStatus: true },
  });
  if (!requested) throw new NotFoundError('Order not found');
  const id = requested.id;

  const alreadyOnTrip = await partnerHasActiveDelivery(partnerId);
  if (alreadyOnTrip) {
    const existingActive = await prisma.foodOrder.findFirst({
      where: {
        dispatchDeliveryPartnerId: partnerId,
        dispatchStatus: 'accepted',
        orderStatus: { notIn: TERMINAL_ORDER_STATUSES },
      },
      select: { id: true },
    });

    if (existingActive?.id && existingActive.id === id) {
      const { order } = await loadOrder(id, deliveryInclude);
      return sanitizeOrderForDeliveryPartner(order);
    }

    throw new ValidationError(
      'You already have an active delivery. Complete it before accepting another order.',
    );
  }

  // Refuse before claiming the order, not after: a rider already at their cash
  // ceiling must not end up holding a cash trip they cannot be given.
  await assertCashLimitAllows(partnerId, { paymentMethod: requested.paymentMethod });

  // Atomic claim. The guard replaces findOneAndUpdate's filter — only one rider
  // can flip the order to accepted.
  const { count } = await prisma.foodOrder.updateMany({
    where: {
      id,
      orderStatus: { in: acceptedStatuses },
      OR: [
        {
          dispatchStatus: 'unassigned',
          dispatchOffers: { none: { partnerId, action: 'deassigned' } },
        },
        { dispatchStatus: 'assigned', dispatchDeliveryPartnerId: partnerId },
      ],
    },
    data: {
      dispatchDeliveryPartnerId: partnerId,
      dispatchStatus: 'accepted',
      dispatchAssignedAt: now,
      dispatchAcceptedAt: now,
    },
  });

  if (count === 0) {
    const existing = await prisma.foodOrder.findUnique({
      where: { id },
      select: { orderStatus: true, dispatchStatus: true, dispatchDeliveryPartnerId: true },
    });

    if (!existing) throw new NotFoundError('Order not found');
    if (cancellableStatuses.includes(existing.orderStatus)) {
      throw new ValidationError('Order was cancelled');
    }
    if (existing.orderStatus === 'delivered') throw new ValidationError('Order already delivered');
    if (!acceptedStatuses.includes(existing.orderStatus)) {
      throw new ValidationError('Order not ready for delivery assignment');
    }
    if (existing.dispatchStatus === 'accepted') {
      if (String(existing.dispatchDeliveryPartnerId || '') === partnerId) {
        const { order } = await loadOrder(id, deliveryInclude);
        return sanitizeOrderForDeliveryPartner(order);
      }
      throw new ForbiddenError('Order already accepted by another partner');
    }

    throw new ValidationError('Order is no longer available to accept');
  }

  await pushStatusHistory(id, {
    byRole: 'DELIVERY_PARTNER',
    byId: partnerId,
    from: 'dispatchable',
    to: 'accepted',
    note: 'Delivery partner accepted order',
  });

  const { row, order } = await loadOrder(id, deliveryInclude);
  const responseOrder = sanitizeOrderForDeliveryPartner(order);

  void (async () => {
    try {
      const rest = row.restaurant;
      const custLat = row.addrLat;
      const custLng = row.addrLng;

      if (rest?.latitude != null && rest?.longitude != null && custLat != null && custLng != null) {
        const route = await fetchDrivingRoute(
          { lat: Number(rest.latitude), lng: Number(rest.longitude) },
          { lat: Number(custLat), lng: Number(custLng) },
        );
        const polyline = route.polyline || '';

        if (route.distanceKm != null) {
          const tripDurationMins =
            route.durationSeconds != null ? Math.ceil(route.durationSeconds / 60) : null;
          prisma.foodOrder
            .update({
              where: { id },
              data: {
                tripDistanceKm: route.distanceKm,
                tripDurationMins,
                roadDistanceKm: route.distanceKm,
                roadDurationMins: tripDurationMins,
              },
            })
            .catch(() => {});
        }

        const db = getFirebaseDB();
        if (db) {
          await db
            .ref(`active_orders/${id}`)
            .set({
              polyline,
              lat: Number(rest.latitude),
              lng: Number(rest.longitude),
              boy_lat: Number(rest.latitude),
              boy_lng: Number(rest.longitude),
              restaurant_lat: Number(rest.latitude),
              restaurant_lng: Number(rest.longitude),
              customer_lat: Number(custLat),
              customer_lng: Number(custLng),
              status: 'accepted',
              last_updated: Date.now(),
            })
            .catch((error) => logger.error(`Firebase orderRef set error: ${error.message}`));
        }
      }
    } catch (error) {
      logger.error(`Error initializing Firebase order tracking: ${error?.message || error}`);
    }

    try {
      await foodTransactionService.updateTransactionRider(id, partnerId);
    } catch (error) {
      logger.error(`Error updating delivery rider transaction for ${id}: ${error?.message || error}`);
    }

    // Everyone offered this order who did not win it. Deduped: a partner can
    // appear once per re-offer round, and pushing the same withdrawal three times
    // is just noise.
    const losingPartnerIds = [
      ...new Set(
        (row.dispatchOffers || [])
          .map((offer) => String(offer.partnerId))
          .filter((pid) => pid && pid !== partnerId),
      ),
    ];

    try {
      const io = getIO();
      if (io) {
        const payload = {
          orderMongoId: id,
          orderId: id,
          orderStatus: row.orderStatus,
          dispatchStatus: 'accepted',
        };
        io.to(rooms.delivery(partnerId)).emit('order_status_update', payload);
        io.to(rooms.restaurant(row.restaurantId)).emit('order_status_update', payload);
        io.to(rooms.user(row.userId)).emit('order_status_update', payload);

        const claimedPayload = { orderId: id, orderMongoId: id, claimedBy: partnerId };
        for (const pid of losingPartnerIds) {
          io.to(rooms.delivery(pid)).emit('order_claimed', claimedPayload);
        }
        logger.info(
          `[DeliveryDispatch] Broadcast order_claimed to ${losingPartnerIds.length} other partners for order ${id}`,
        );
      }

      // The socket emit only reaches riders whose app is open. The offer itself is
      // delivered by a data-only push the app raises from its background isolate,
      // so the rider most likely still staring at a dead offer is exactly the one
      // the socket cannot reach. Withdraw over the same transport it arrived on.
      if (losingPartnerIds.length > 0) {
        try {
          await notifyOwnersSafely(
            losingPartnerIds.map((pid) => ({ ownerType: 'DELIVERY_PARTNER', ownerId: pid })),
            {
              title: 'Order taken',
              body: 'Another partner accepted this order.',
              // Data-only, like the offer: this must dismiss a UI, never add one.
              dataOnly: true,
              data: { type: 'order_taken', orderId: id, orderMongoId: id },
            },
          );
        } catch (err) {
          logger.warn(`order_taken push failed for order ${id}: ${err.message}`);
        }
      }

      await notifyOwnersSafely(
        [
          { ownerType: 'USER', ownerId: row.userId },
          { ownerType: 'RESTAURANT', ownerId: row.restaurantId },
          { ownerType: 'DELIVERY_PARTNER', ownerId: partnerId },
        ],
        {
          title: `Order ${id} accepted`,
          body: 'A delivery partner has accepted your order.',
          data: {
            type: 'delivery_accepted',
            orderId: id,
            orderMongoId: id,
            dispatchStatus: 'accepted',
            link: '/food/user/orders',
          },
        },
      );
    } catch (error) {
      logger.error(`Error notifying delivery acceptance for ${id}: ${error?.message || error}`);
    }
  })();

  enqueueOrderEvent('delivery_accepted', {
    orderMongoId: id,
    orderId: id,
    deliveryPartnerId: partnerId,
    dispatchStatus: 'accepted',
    orderStatus: row.orderStatus,
  });

  return responseOrder;
}

export async function rejectOrderDelivery(orderId, deliveryPartnerId) {
  const { row, order } = await loadOrder(orderId);
  assertOwnedBy(row, deliveryPartnerId);

  // Only an order that hasn't been collected may be rejected. Without this a rider
  // could pick the food up and then reject: the order was re-dispatched while rider
  // #1 still held it, and every earnings/cash aggregation keyed on the partner id
  // lost the order — including the COD cash they were carrying.
  if (
    Boolean(row.pickedUpAt) ||
    ['picked_up', 'reached_drop', 'delivered'].includes(String(row.orderStatus || ''))
  ) {
    throw new ValidationError(
      'This order has already been picked up and cannot be rejected. Use emergency reassignment instead.',
    );
  }
  if (TERMINAL_ORDER_STATUSES.includes(String(row.orderStatus || ''))) {
    throw new ValidationError('This order is already closed');
  }

  const offer = (row.dispatchOffers || []).find(
    (item) => String(item.partnerId) === String(deliveryPartnerId) && item.action === 'offered',
  );

  await prisma.$transaction([
    ...(offer
      ? [prisma.orderDispatchOffer.update({ where: { id: offer.id }, data: { action: 'rejected' } })]
      : []),
    prisma.foodOrder.update({
      where: { id: row.id },
      data: {
        dispatchStatus: 'unassigned',
        dispatchDeliveryPartnerId: null,
        dispatchAssignedAt: null,
        dispatchAcceptedAt: null,
      },
    }),
  ]);

  await pushStatusHistory(row.id, {
    byRole: 'DELIVERY_PARTNER',
    byId: deliveryPartnerId,
    from: 'assigned',
    to: 'unassigned',
    note: 'Rejected',
  });

  enqueueOrderEvent('delivery_rejected', {
    orderMongoId: row.id,
    orderId: row.id,
    deliveryPartnerId,
  });

  void dispatchService
    .tryAutoAssign(row.id)
    .catch((error) => logger.error(`SmartDispatch: Auto-assign after reject failed: ${error.message}`));

  return order;
}

export async function confirmReachedPickupDelivery(orderId, deliveryPartnerId) {
  const { row, order } = await loadOrder(orderId);
  assertOwnedBy(row, deliveryPartnerId);

  if (row.orderStatus === 'delivered') throw new ValidationError('Order already delivered');

  const currentPhase = row.deliveryPhase || '';
  const currentStatus = row.deliveryStatus || '';
  if (currentPhase === 'at_pickup' || currentStatus === 'reached_pickup') return order;

  const from = currentStatus || currentPhase || row.orderStatus;

  const updated = toOrder(await prisma.foodOrder.update({
    where: { id: row.id },
    data: {
      deliveryPhase: 'at_pickup',
      deliveryStatus: 'reached_pickup',
      reachedPickupAt: row.reachedPickupAt || new Date(),
    },
    include: orderInclude,
  }));

  await pushStatusHistory(row.id, {
    byRole: 'DELIVERY_PARTNER',
    byId: deliveryPartnerId,
    from,
    to: 'reached_pickup',
    note: 'Reached pickup location',
  });

  emitOrderUpdate(updated, deliveryPartnerId);

  try {
    const [restaurant, partner] = await Promise.all([
      prisma.foodRestaurant.findUnique({
        where: { id: row.restaurantId },
        select: { restaurantName: true },
      }),
      prisma.foodDeliveryPartner.findUnique({
        where: { id: String(deliveryPartnerId) },
        select: { name: true },
      }),
    ]);

    await notifyOwnersSafely([{ ownerType: 'RESTAURANT', ownerId: row.restaurantId }], {
      title: 'Rider arrived!',
      body: `${partner?.name || 'The delivery partner'} has arrived at ${
        restaurant?.restaurantName || 'your restaurant'
      } to pick up Order .`,
      data: { type: 'rider_arrived', orderMongoId: row.id, partnerName: partner?.name || '' },
    });
  } catch (error) {
    logger.error(
      `Error notifying restaurant about rider arrival for ${row.id}: ${error?.message || error}`,
    );
  }

  enqueueOrderEvent('reached_pickup', {
    orderMongoId: row.id,
    orderId: row.id,
    deliveryPartnerId,
    orderStatus: updated.orderStatus,
    deliveryPhase: updated.deliveryState?.currentPhase,
    deliveryStatus: updated.deliveryState?.status,
  });

  return updated;
}

export async function confirmPickupDelivery(orderId, deliveryPartnerId, billImageUrl) {
  const { row } = await loadOrder(orderId);
  assertOwnedBy(row, deliveryPartnerId);

  const from = row.orderStatus;
  const nextStatus = 'picked_up';
  if (!isStatusAdvance(from, nextStatus)) {
    throw new ValidationError(`Order is already at status '${from}'. Cannot re-mark as '${nextStatus}'.`);
  }

  // Pre-generate the handover OTP so the customer sees it as soon as food is on the way.
  const existingOtp = String(row.deliveryOtp || '').trim();
  const otpPatch = existingOtp
    ? {}
    : { deliveryOtp: generateFourDigitDeliveryOtp(), dropOtpRequired: true, dropOtpVerified: false };

  const updated = toOrder(await prisma.foodOrder.update({
    where: { id: row.id },
    data: {
      orderStatus: nextStatus,
      deliveryPhase: 'en_route_to_delivery',
      deliveryStatus: 'picked_up',
      pickedUpAt: new Date(),
      billImageUrl: billImageUrl || null,
      ...otpPatch,
    },
    include: orderInclude,
  }));

  emitDeliveryDropOtpToUser(updated, String(updated.deliveryOtp || '').trim());

  await pushStatusHistory(row.id, {
    byRole: 'DELIVERY_PARTNER',
    byId: deliveryPartnerId,
    from,
    to: 'picked_up',
    note: 'Order picked up',
  });

  emitOrderUpdate(updated, deliveryPartnerId);
  enqueueOrderEvent('picked_up', {
    orderMongoId: row.id,
    orderId: row.id,
    deliveryPartnerId,
    billImageUrl: billImageUrl || null,
  });

  return updated;
}

export async function confirmReachedDropDelivery(orderId, deliveryPartnerId) {
  const { row, order } = await loadOrder(orderId);
  assertOwnedBy(row, deliveryPartnerId);

  if (row.dropOtpVerified) {
    emitOrderUpdate(order, deliveryPartnerId);
    return sanitizeOrderForDeliveryPartner(order);
  }

  const alreadyAtDrop = row.deliveryPhase === 'at_drop' || row.deliveryStatus === 'reached_drop';
  const fromPhase = row.deliveryStatus || row.deliveryPhase || row.orderStatus || '';

  // Never regenerate an OTP the customer may already be displaying. It is issued at
  // pickup (getDropOtpUser exposes it from 'picked_up' onwards), so re-rolling it
  // here invalidated the code the customer reads out — the rider then got "Invalid OTP".
  const existingOtp = String(row.deliveryOtp || '').trim();

  const updated = toOrder(await prisma.foodOrder.update({
    where: { id: row.id },
    data: {
      ...(existingOtp ? {} : { deliveryOtp: generateFourDigitDeliveryOtp() }),
      // Arm the OTP gate at drop regardless (the early return above covers verified).
      dropOtpRequired: true,
      dropOtpVerified: false,
      deliveryPhase: 'at_drop',
      deliveryStatus: 'reached_drop',
      reachedDropAt: row.reachedDropAt || new Date(),
    },
    include: orderInclude,
  }));

  if (!alreadyAtDrop) {
    await pushStatusHistory(row.id, {
      byRole: 'DELIVERY_PARTNER',
      byId: deliveryPartnerId,
      from: fromPhase,
      to: 'reached_drop',
      note: 'Reached drop location',
    });
  }

  emitDeliveryDropOtpToUser(updated, String(updated.deliveryOtp || '').trim());
  emitOrderUpdate(updated, deliveryPartnerId);
  enqueueOrderEvent('reached_drop', {
    orderMongoId: row.id,
    orderId: row.id,
    deliveryPartnerId,
    dropOtpRequired: true,
    dropOtpVerified: false,
  });

  return sanitizeOrderForDeliveryPartner(updated);
}

export async function verifyDropOtpDelivery(orderId, deliveryPartnerId, otp) {
  const { row, order } = await loadOrder(orderId);
  assertOwnedBy(row, deliveryPartnerId);

  if (row.dropOtpVerified) return { order: sanitizeOrderForDeliveryPartner(order) };

  const otpStr = String(otp || '').trim();
  if (!otpStr) throw new ValidationError('OTP is required');

  if (!row.dropOtpRequired) {
    throw new ValidationError(
      'OTP verification is not active for this order. Confirm reached drop first.',
    );
  }

  const expected = String(row.deliveryOtp || '').trim();
  if (!expected || expected !== otpStr) {
    throw new ValidationError('Invalid OTP. Ask the customer for the code shown in their app.');
  }

  const updated = toOrder(await prisma.foodOrder.update({
    where: { id: row.id },
    data: { dropOtpVerified: true },
    include: orderInclude,
  }));

  emitOrderUpdate(updated, deliveryPartnerId);
  enqueueOrderEvent('drop_otp_verified', {
    orderMongoId: row.id,
    orderId: row.id,
    deliveryPartnerId,
  });

  return { order: sanitizeOrderForDeliveryPartner(updated) };
}

export async function completeDelivery(orderId, deliveryPartnerId, body = {}) {
  const { row, order } = await loadOrder(orderId);
  assertOwnedBy(row, deliveryPartnerId);

  const { otp, ratings } = body;
  logger.info(
    `[DeliveryComplete] Attempting to complete order ${row.id} for partner ${deliveryPartnerId}. Status: ${row.orderStatus}`,
  );

  // Pickup must have happened. dropOtpRequired is only set at pickup/reached-drop,
  // so completing straight after accept skipped BOTH OTP guards below and still
  // paid the rider, credited totalDeliveries and marked COD collected — for food
  // never collected.
  const hasPickedUp =
    Boolean(row.pickedUpAt) || ['picked_up', 'reached_drop'].includes(String(row.orderStatus || ''));
  if (!hasPickedUp) throw new ValidationError('Confirm pickup before completing this delivery.');

  let otpVerifiedNow = false;
  if (otp && row.dropOtpRequired && !row.dropOtpVerified) {
    const expected = String(row.deliveryOtp || '').trim();
    if (expected && expected === String(otp).trim()) {
      otpVerifiedNow = true;
      logger.info(`[DeliveryComplete] OTP verified during completion call for ${row.id}`);
    } else {
      throw new ValidationError('Invalid handover OTP provided.');
    }
  }

  if (row.dropOtpRequired && !row.dropOtpVerified && !otp) {
    throw new ValidationError(
      'Customer handover OTP is required. Verify the OTP from the customer before completing delivery.',
    );
  }

  const from = row.orderStatus;
  const nextStatus = 'delivered';
  if (!isStatusAdvance(from, nextStatus)) {
    logger.warn(`[DeliveryComplete] Status advance check failed for ${row.id}. Current: ${from}`);
    throw new ValidationError(`Order is already at status '${from}'. Cannot re-mark as '${nextStatus}'.`);
  }

  const tx = await foodTransactionService.getTransactionByOrder(row.id);
  const prevPayStatus = String(
    tx?.payment?.status || order?.payment?.status || 'unpaid',
  ).toLowerCase();
  const payMethod = String(
    tx?.payment?.method || order?.payment?.method || 'cash',
  ).toLowerCase();

  logger.info(`[DeliveryComplete] Order ${row.id} payment: ${payMethod}, status: ${prevPayStatus}`);

  if (payMethod === 'razorpay_qr') {
    const syncedPayment = await syncRazorpayQrPayment(order);
    if (String(syncedPayment?.status || '').toLowerCase() !== 'paid') {
      throw new ValidationError('QR payment not verified yet');
    }
  }

  const codBecomesPaid = payMethod === 'cash' && row.paymentStatus === 'cod_pending';
  if (codBecomesPaid) {
    logger.info(`[DeliveryComplete] COD order ${row.id} marked as paid upon delivery.`);
  }

  const updated = toOrder(await prisma.foodOrder.update({
    where: { id: row.id },
    data: {
      orderStatus: 'delivered',
      deliveryPhase: 'delivered',
      deliveryStatus: 'delivered',
      deliveredAt: new Date(),
      ...(otpVerifiedNow ? { dropOtpVerified: true } : {}),
      ...(codBecomesPaid ? { paymentStatus: 'paid' } : {}),
      ...(ratings?.customer
        ? {
            customerRating: ratings.customer.rating,
            customerRatingComment: ratings.customer.comment || '',
            customerRatedAt: new Date(),
          }
        : {}),
    },
    include: orderInclude,
  }));

  await pushStatusHistory(row.id, {
    byRole: 'DELIVERY_PARTNER',
    byId: deliveryPartnerId,
    from,
    to: 'delivered',
    note: 'Delivery completed successfully',
  });

  // Lifetime completed-delivery counter (best-effort).
  prisma.foodDeliveryPartner
    .update({
      where: { id: String(deliveryPartnerId) },
      data: { totalDeliveries: { increment: 1 } },
    })
    .catch((e) => logger.warn(`totalDeliveries increment failed: ${e?.message || e}`));

  // Referral reward: pays the rider who referred THIS rider, once they complete
  // their first delivery. Idempotent, never throws.
  import('../../delivery/services/deliveryReferral.service.js')
    .then(({ creditDeliveryReferralOnFirstDelivery }) =>
      creditDeliveryReferralOnFirstDelivery(String(deliveryPartnerId)),
    )
    .catch((e) => logger.warn(`referral credit hook failed: ${e?.message || e}`));

  // Customer cashback on the delivered order. Idempotent per order, never throws.
  import('../../user/services/cashback.service.js')
    .then(({ awardOrderCashback }) => awardOrderCashback(row.id))
    .catch((e) => logger.warn(`cashback award hook failed: ${e?.message || e}`));

  const ledgerKind =
    payMethod === 'cash' && prevPayStatus === 'cod_pending'
      ? 'cod_marked_paid_on_delivery'
      : 'payment_snapshot_sync';

  await foodTransactionService.updateTransactionStatus(row.id, ledgerKind, {
    status: 'captured',
    recordedByRole: 'DELIVERY_PARTNER',
    recordedById: deliveryPartnerId,
    note: `Delivery completed. Prev status: ${prevPayStatus}`,
  });

  emitOrderUpdate(updated, deliveryPartnerId);
  enqueueOrderEvent('delivery_completed', {
    orderMongoId: row.id,
    orderId: row.id,
    deliveryPartnerId,
    payMethod,
    prevPayStatus,
    paymentStatus: updated.payment?.status,
  });

  return sanitizeOrderForDeliveryPartner(updated);
}

export async function updateOrderStatusDelivery(orderId, deliveryPartnerId, orderStatus) {
  const { row } = await loadOrder(orderId);
  assertOwnedBy(row, deliveryPartnerId);

  const from = row.orderStatus;
  if (!isStatusAdvance(from, orderStatus)) {
    throw new ValidationError(
      `Current order status '${from}' is further ahead than '${orderStatus}'. Order cannot be moved backwards.`,
    );
  }

  const updated = toOrder(await prisma.foodOrder.update({
    where: { id: row.id },
    data: { orderStatus },
    include: orderInclude,
  }));

  await pushStatusHistory(row.id, {
    byRole: 'DELIVERY_PARTNER',
    byId: deliveryPartnerId,
    from,
    to: orderStatus,
  });

  enqueueOrderEvent('delivery_status_updated', {
    orderMongoId: row.id,
    orderId: row.id,
    deliveryPartnerId,
    from,
    to: orderStatus,
  });

  return updated;
}

/**
 * Driving route from the rider's current position to the next stop, for the
 * active-trip map.
 *
 * `target` picks the destination; when omitted it is inferred from the trip phase —
 * the restaurant before pickup, the customer after. Returns empty-but-valid fields
 * rather than throwing when Directions has nothing to give, so the client can
 * degrade instead of erroring.
 */
async function loadOrderForRoute(orderId) {
  const identity = buildOrderIdentityFilter(orderId);
  if (!identity) throw new ValidationError('Order id required');

  const row = await prisma.foodOrder.findFirst({
    where: identity,
    include: {
      restaurant: {
        select: { id: true, latitude: true, longitude: true, addressLine1: true, restaurantName: true },
      },
    },
  });
  if (!row) throw new NotFoundError('Order not found');
  return row;
}

export async function getOrderRouteForDelivery(orderId, deliveryPartnerId, query = {}) {
  const row = await loadOrderForRoute(orderId);

  if (String(row.dispatchDeliveryPartnerId || '') !== String(deliveryPartnerId)) {
    throw new ForbiddenError('Not your order');
  }

  return computeOrderRoute(row, query);
}

/**
 * Customer-facing twin of the rider's route endpoint.
 *
 * The tracking map previously drew the RTDB polyline, computed ONCE at accept time
 * as restaurant→customer and never re-cut. Before pickup it drew a route the rider
 * isn't on, and after pickup it never followed them.
 *
 * Unlike the rider's version this ignores any client lat/lng and always uses the
 * rider's server-side last known position. Letting the customer pass arbitrary
 * coordinates would make this an open Directions proxy billed to us.
 */
export async function getOrderRouteForUser(orderId, userId, query = {}) {
  const row = await loadOrderForRoute(orderId);

  if (String(row.userId || '') !== String(userId)) throw new ForbiddenError('Not your order');

  return computeOrderRoute(row, { target: query?.target });
}

async function computeOrderRoute(row, query = {}) {
  // Origin: the rider's live position from the query, else their last known ping.
  const qLat = Number(query.lat);
  const qLng = Number(query.lng);
  const hasQueryOrigin = Number.isFinite(qLat) && Number.isFinite(qLng);

  let origin = hasQueryOrigin
    ? { lat: qLat, lng: qLng }
    : row.riderLat != null && row.riderLng != null
      ? { lat: Number(row.riderLat), lng: Number(row.riderLng) }
      : null;

  // Fall back to the partner's own last known position.
  //
  // The order's rider position is only written when the rider emits a location
  // update FOR THIS ORDER, which before pickup has usually not happened. The rider
  // app never noticed because it passes live coordinates in the query; the customer
  // app cannot, so every pre-pickup call returned an empty polyline without ever
  // reaching Directions. The partner's lastLat/lastLng is refreshed by the
  // availability ping regardless of any order, so it is the right fallback.
  if (!origin && row.dispatchDeliveryPartnerId) {
    const partner = await prisma.foodDeliveryPartner.findUnique({
      where: { id: row.dispatchDeliveryPartnerId },
      select: { lastLat: true, lastLng: true },
    });
    const pLat = Number(partner?.lastLat);
    const pLng = Number(partner?.lastLng);
    if (Number.isFinite(pLat) && Number.isFinite(pLng)) origin = { lat: pLat, lng: pLng };
  }

  const pickedUp =
    Boolean(row.pickedUpAt) || ['picked_up', 'reached_drop'].includes(String(row.orderStatus || ''));
  const target = ['restaurant', 'customer'].includes(String(query.target || ''))
    ? String(query.target)
    : pickedUp
      ? 'customer'
      : 'restaurant';

  const destination =
    target === 'customer'
      ? row.addrLat != null && row.addrLng != null
        ? { lat: Number(row.addrLat), lng: Number(row.addrLng) }
        : null
      : row.restaurant?.latitude != null && row.restaurant?.longitude != null
        ? { lat: Number(row.restaurant.latitude), lng: Number(row.restaurant.longitude) }
        : null;

  const empty = {
    polyline: '',
    distanceMeters: null,
    distanceKm: null,
    durationSeconds: null,
    durationMins: null,
    target,
    origin,
    destination,
  };
  if (!origin || !destination) return empty;

  const route = await fetchDrivingRoute(origin, destination);
  const durationSeconds = Number.isFinite(Number(route?.durationSeconds))
    ? Number(route.durationSeconds)
    : null;

  return {
    polyline: route?.polyline || '',
    distanceMeters: route?.distanceMeters ?? null,
    distanceKm: route?.distanceKm ?? null,
    durationSeconds,
    durationMins: durationSeconds != null ? Math.max(1, Math.ceil(durationSeconds / 60)) : null,
    target,
    origin,
    destination,
  };
}
