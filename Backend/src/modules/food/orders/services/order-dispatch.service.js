import { prisma } from '../../../../config/prisma.js';
import { toOrder, orderInclude } from '../order.mapper.js';
import { ValidationError, NotFoundError } from '../../../../core/auth/errors.js';
import { logger } from '../../../../utils/logger.js';
import { config } from '../../../../config/env.js';
import { getIO, rooms } from '../../../../config/socket.js';
import { addOrderJob } from '../../../../queues/producers/order.producer.js';
import {
  buildDeliverySocketPayload,
  buildOrderIdentityFilter,
  getBusyDeliveryPartnerIds,
  haversineKm,
  notifyOwnersActionableAlert,
  notifyOwnersSafely,
} from './order.helpers.js';
import { fetchDrivingRoute } from '../utils/googleMaps.js';
import { parseGeoPoint } from '../../shared/geo.utils.js';

/** Everything a dispatch broadcast needs about the order. */
const dispatchInclude = { ...orderInclude, restaurant: true, user: true };

/**
 * Resolve restaurant → customer road distance once per dispatch broadcast.
 * Falls back to pricing Haversine when Directions is unavailable.
 */
async function enrichPayloadWithTripRoadDistance(order, payload) {
  const existingRoadKm = order?.tripDistanceKm ?? order?.pricing?.roadDistanceKm;
  if (Number.isFinite(Number(existingRoadKm))) {
    const km = Number(Number(existingRoadKm).toFixed(2));
    const minsRaw = order?.tripDurationMins ?? order?.pricing?.roadDurationMins;
    const tripDurationMins = Number.isFinite(Number(minsRaw))
      ? Math.ceil(Number(minsRaw))
      : payload.tripDurationMins;
    return { ...payload, tripDistanceKm: km, tripDurationMins: tripDurationMins ?? null, distanceKm: km };
  }

  const restaurantPoint = parseGeoPoint(order?.restaurantId);
  const customerPoint = parseGeoPoint(order?.deliveryAddress);
  if (!restaurantPoint || !customerPoint) return payload;

  try {
    const route = await fetchDrivingRoute(restaurantPoint, customerPoint);
    if (route.distanceKm != null) {
      const tripDurationMins =
        route.durationSeconds != null ? Math.ceil(route.durationSeconds / 60) : null;

      // Persist so subsequent offers / reconnects reuse the road distance.
      if (order?.id) {
        prisma.foodOrder
          .update({
            where: { id: order.id },
            data: {
              tripDistanceKm: route.distanceKm,
              tripDurationMins,
              roadDistanceKm: route.distanceKm,
              roadDurationMins: tripDurationMins,
            },
          })
          .catch(() => {});
      }

      return { ...payload, tripDistanceKm: route.distanceKm, tripDurationMins, distanceKm: route.distanceKm };
    }
  } catch (err) {
    logger.warn(`Trip road distance enrichment failed: ${err?.message || err}`);
  }

  return payload;
}

/**
 * Driver acceptance window. Single source of truth — the client countdown, the
 * re-queue delay and acceptanceDeadlineAt all derive from this, so they cannot
 * drift apart.
 */
const DRIVER_ACCEPT_WINDOW_MS = 45000;

/**
 * Flat, string-only data map for the incoming-order push.
 *
 * FCM data values must be strings. Everything the full-screen alert needs is
 * included so the app can render it with no follow-up API call — important when
 * the device is locked or the app was killed.
 */
function buildIncomingOrderPushData(order, payload, acceptanceDeadlineAt) {
  const s = (v) => (v === undefined || v === null ? '' : String(v));

  const earning = s(payload?.riderEarning ?? 0);
  const distance = s(payload?.tripDistanceKm ?? '');
  const bodyLines = [
    payload?.restaurantName ? `Pickup: ${s(payload.restaurantName)}` : '',
    payload?.customerAddress ? `Drop: ${s(payload.customerAddress)}` : '',
    distance ? `${distance} km` : '',
    `Earning: Rs.${earning}`,
  ].filter(Boolean);

  return {
    type: 'new_order',
    // Carried INSIDE data on purpose: this push is data-only, so FCM omits the
    // notification block and an app reading message.notification.title renders a
    // blank notification. These give the rider app ready-made strings.
    title: 'New order available!',
    body: bodyLines.join('\n'),
    orderId: s(order?.id),
    orderMongoId: s(order?.id),
    orderDisplayId: s(order?.order_id || order?.id),
    restaurantName: s(payload?.restaurantName),
    restaurantAddress: s(payload?.restaurantAddress),
    customerAddress: s(payload?.customerAddress),
    tripDistanceKm: s(payload?.tripDistanceKm ?? ''),
    tripDurationMins: s(payload?.tripDurationMins ?? ''),
    riderEarning: s(payload?.riderEarning ?? 0),
    earnings: s(payload?.earnings ?? payload?.riderEarning ?? 0),
    paymentMethod: s(payload?.paymentMethod || order?.payment?.method),
    total: s(payload?.total ?? order?.pricing?.total ?? 0),
    acceptanceDeadlineAt: s(acceptanceDeadlineAt?.toISOString?.() || acceptanceDeadlineAt),
    // The offer window, so the client countdown is driven by the server rather
    // than a constant compiled into the app. The absolute deadline above is more
    // accurate, but a message delayed in Doze arrives already expired — sending
    // both lets the app prefer the deadline and fall back to this.
    acceptTimeoutSeconds: s(Math.round(DRIVER_ACCEPT_WINDOW_MS / 1000)),
    pickupAddress: s(payload?.restaurantAddress),
    dropAddress: s(payload?.customerAddress),
    price: s(payload?.earnings ?? payload?.riderEarning ?? 0),
    distance: s(payload?.tripDistanceKm ?? ''),

    // Everything below exists so the alert can be drawn with ZERO network calls.
    // The background isolate rendering it often runs in Doze, where an HTTP
    // request is deferred or refused — and the rider has 45 seconds to decide.
    orderNumber: s(order?.order_id || ''),
    restaurantImage: s(payload?.restaurantCoverImage || ''),
    pickupLat: s(payload?.restaurantLocation?.latitude ?? ''),
    pickupLng: s(payload?.restaurantLocation?.longitude ?? ''),
    dropLat: s(payload?.customerLocation?.latitude ?? ''),
    dropLng: s(payload?.customerLocation?.longitude ?? ''),
    customerName: s(payload?.customerName || order?.customerName || ''),
    customerPhone: s(payload?.customerPhone || order?.customerPhone || ''),
    itemsCount: s(Array.isArray(order?.items) ? order.items.length : ''),
  };
}

/**
 * Riders already holding as much cash as they are allowed to.
 *
 * The limit existed as an admin setting and was shown to riders, but nothing
 * enforced it. Only applied to orders the rider physically collects money for —
 * a prepaid order adds nothing to their float. A limit of 0 means "no limit",
 * which is the default, so an unconfigured install excludes nobody.
 *
 * @returns {Promise<Set<string>>} partner ids to skip
 */
async function getCashBlockedPartnerIds(partnerIds) {
  if (!partnerIds.length) return new Set();

  const settings = await prisma.foodDeliveryCashLimit.findFirst({
    where: { isActive: true },
    select: { deliveryCashLimit: true },
  });
  const limit = Number(settings?.deliveryCashLimit) || 0;
  if (limit <= 0) return new Set();

  // Wallets are one table now, keyed by (entityType, entityId).
  const wallets = await prisma.wallet.findMany({
    where: {
      entityType: 'deliveryBoy',
      entityId: { in: partnerIds.map(String) },
      cashInHand: { gte: limit },
    },
    select: { entityId: true },
  });

  return new Set(wallets.map((w) => w.entityId));
}

/** Cash the rider has to physically collect, so it counts against their float. */
function orderCollectsCash(order) {
  const method = String(order?.payment?.method || order?.paymentMethod || '').toLowerCase();
  return method === 'cash' || method === 'razorpay_qr';
}

async function listNearbyOnlineDeliveryPartners(restaurant, { maxKm = 15, limit = 25 } = {}) {
  const rLat = Number(restaurant?.latitude);
  const rLng = Number(restaurant?.longitude);
  if (!Number.isFinite(rLat) || !Number.isFinite(rLng)) {
    // Without restaurant coords we cannot safely match riders by zone/proximity.
    return { partners: [] };
  }

  const allOnline = await prisma.foodDeliveryPartner.findMany({
    where: { availabilityStatus: 'online' },
    select: { id: true, status: true, lastLat: true, lastLng: true, lastLocationAt: true, name: true },
  });

  const scored = [];
  const allowedStatuses =
    process.env.NODE_ENV === 'production' ? ['approved'] : ['approved', 'pending'];

  // A rider is only dropped for staleness after this long WITHOUT any GPS ping.
  //
  // This was 10 minutes, which silently starved the offer path: Doze suppresses
  // the background location upload, the GPS goes stale, the rider is excluded, so
  // no push is sent to wake the app, so the GPS stays stale. Coordinates half an
  // hour old and 3 km away still beat offering the order to nobody.
  const STALE_GPS_MS = Number(process.env.DISPATCH_STALE_GPS_MS) || 45 * 60 * 1000;

  let droppedStale = 0;
  for (const p of allOnline) {
    if (!allowedStatuses.includes(p.status)) continue;

    // No coordinates at all → genuinely unplaceable (never score as 999, which
    // used to bypass the maxKm gate entirely).
    if (p.lastLat == null || p.lastLng == null) {
      droppedStale += 1;
      continue;
    }
    if (!p.lastLocationAt || Date.now() - new Date(p.lastLocationAt).getTime() > STALE_GPS_MS) {
      droppedStale += 1;
      continue;
    }

    const d = haversineKm(rLat, rLng, p.lastLat, p.lastLng);
    if (Number.isFinite(d) && d <= maxKm) {
      scored.push({ partnerId: p.id, distanceKm: d, status: p.status });
    }
  }

  // Without this, a starved dispatch is indistinguishable from "no riders online".
  if (droppedStale > 0) {
    logger.warn(
      `[Dispatch] ${droppedStale}/${allOnline.length} online riders skipped for missing/stale GPS ` +
        `(restaurant ${restaurant.id}, maxKm ${maxKm}). ${scored.length} eligible.`,
    );
  }

  scored.sort((a, b) => a.distanceKm - b.distanceKm);
  const picked = scored.slice(0, Math.max(1, limit));

  // Do NOT fall back to any online partner worldwide (cross-zone bug). The caller
  // retries later when nearby GPS updates.
  if (picked.length === 0) return { partners: [] };

  const final = config.nodeEnv === 'production' ? picked.filter((p) => p.status === 'approved') : picked;
  return { partners: final };
}

export async function getDispatchSettings() {
  return { dispatchMode: 'auto' };
}

export async function updateDispatchSettings(dispatchMode, adminId) {
  // Always set to auto.
  await prisma.foodSettings.upsert({
    where: { key: 'dispatch' },
    create: {
      key: 'dispatch',
      dispatchMode: 'auto',
      updatedByRole: 'ADMIN',
      updatedByAdminId: adminId ? String(adminId) : null,
      updatedAtBy: new Date(),
    },
    update: {
      dispatchMode: 'auto',
      updatedByRole: 'ADMIN',
      updatedByAdminId: adminId ? String(adminId) : null,
      updatedAtBy: new Date(),
    },
  });
  return getDispatchSettings();
}

export async function tryAutoAssign(orderId, options = {}) {
  const id = String(orderId);
  const attempt = options.attempt || 1;
  // Small buffer above the accept window so an in-flight offer isn't reclaimed early.
  const lockTimeout = DRIVER_ACCEPT_WINDOW_MS + 5000; // 50s

  // Claim the dispatch lock atomically; only the winner proceeds.
  const { count: claimed } = await prisma.foodOrder.updateMany({
    where: {
      id,
      dispatchingAt: null,
      OR: [
        { dispatchStatus: 'unassigned' },
        {
          dispatchStatus: 'assigned',
          dispatchAcceptedAt: null,
          dispatchAssignedAt: { lt: new Date(Date.now() - lockTimeout) },
        },
      ],
    },
    data: { dispatchingAt: new Date() },
  });

  if (claimed === 0) {
    logger.info(
      `tryAutoAssign: Skip for ${id} (already dispatching, accepted, or multi-attempt lock active).`,
    );
    return null;
  }

  const row = await prisma.foodOrder.findUnique({ where: { id }, include: dispatchInclude });
  const order = toOrder(row);

  try {
    // Ensure the restaurant accepted before dispatching to delivery partners.
    const DISPATCHABLE_STATUSES = [
      'confirmed', 'preparing', 'ready_for_pickup', 'ready', 'reached_pickup', 'picked_up', 'reached_drop',
    ];
    if (!DISPATCHABLE_STATUSES.includes(order.orderStatus)) {
      logger.info(`tryAutoAssign: Skip for ${id} (status ${order.orderStatus} not dispatchable yet).`);
      return order;
    }

    const offers = order.dispatch?.offeredTo || [];
    const offeredIds = offers.map((o) => String(o.partnerId));
    const permanentlyExcludedIds = new Set(
      offers.filter((o) => o.action === 'deassigned').map((o) => String(o.partnerId)),
    );

    // Radius expansion: attempt 1 → 15km, 2 → 25km, 3 → 40km, 4+ → 60km.
    let maxKm = 15;
    if (attempt === 2) maxKm = 25;
    if (attempt === 3) maxKm = 40;
    if (attempt >= 4) maxKm = 60;

    const { partners } = await listNearbyOnlineDeliveryPartners(row.restaurant, { maxKm, limit: 15 });
    const busyPartnerIds = await getBusyDeliveryPartnerIds();

    // Phase 3: admin alert at attempt 5+ (~6 minutes).
    if (attempt >= 6) {
      logger.error(`[CRITICAL] Order ${id} unassigned for ${attempt} mins. Triggering Admin Alert (Phase 3).`);
      try {
        await notifyOwnersSafely([{ ownerType: 'ADMIN', ownerId: 'GLOBAL' }], {
          title: 'Unassigned Order Crisis!',
          body: `Order #${order.order_id || id} has not been picked up for 5+ minutes. Manual intervention required!`,
          data: { type: 'admin_alert_unassigned', orderId: id },
        });
      } catch (err) {
        logger.warn(`Admin notification failed: ${err.message}`);
      }
    }

    // Riders at their cash ceiling are skipped for cash-collect orders only.
    const cashBlockedIds = orderCollectsCash(order)
      ? await getCashBlockedPartnerIds(partners.map((p) => p.partnerId))
      : new Set();

    const eligible = partners.filter((partner) => {
      const key = String(partner.partnerId);
      if (offeredIds.includes(key)) return false;
      if (busyPartnerIds.has(key)) return false;
      if (cashBlockedIds.has(key)) return false;
      return true;
    });

    // Without this, a cash order finding nobody looks identical to no riders being
    // online, and the real reason stays invisible.
    if (cashBlockedIds.size > 0) {
      logger.warn(
        `[Dispatch] ${cashBlockedIds.size} rider(s) skipped for order ${id}: ` +
          `cash-in-hand at or above the configured limit.`,
      );
    }

    const io = getIO();

    if (eligible.length === 0) {
      logger.info(`tryAutoAssign: No NEW eligible partners in ${maxKm}km for order ${id}. Restarting hunt...`);

      const reofferEligible = partners.filter((partner) => {
        const key = String(partner.partnerId);
        if (permanentlyExcludedIds.has(key)) return false;
        if (busyPartnerIds.has(key)) return false;
        return true;
      });

      if (reofferEligible.length > 0) {
        const basePayload = buildDeliverySocketPayload(order, row.restaurant);
        const payload = await enrichPayloadWithTripRoadDistance(order, basePayload);
        const acceptanceDeadlineAt = new Date(Date.now() + DRIVER_ACCEPT_WINDOW_MS);

        if (io) {
          for (const p of reofferEligible) {
            io.to(rooms.delivery(p.partnerId)).emit('new_order_available', {
              ...payload,
              pickupDistanceKm: p.distanceKm,
              acceptanceDeadlineAt,
            });
          }
        }

        // This branch previously emitted a socket event only, so a backgrounded or
        // locked driver was never woken on a re-offer round. Push on every round.
        try {
          await notifyOwnersActionableAlert(
            reofferEligible.map((p) => ({ ownerType: 'DELIVERY_PARTNER', ownerId: p.partnerId })),
            {
              title: 'New order available!',
              body: `Order #${order.order_id || id} is still available. Tap to accept.`,
              androidTag: `order_${id}`,
              androidChannelId: 'incoming_orders_channel_v3',
              data: buildIncomingOrderPushData(order, payload, acceptanceDeadlineAt),
            },
          );
        } catch (err) {
          logger.warn(`Re-offer push failed for order ${id}: ${err.message}`);
        }
      }

      // Re-queue to keep trying, aligned to the client countdown.
      await addOrderJob(
        { action: 'DISPATCH_TIMEOUT_CHECK', orderMongoId: id, orderId: id, attempt: attempt + 1 },
        { delay: DRIVER_ACCEPT_WINDOW_MS },
      );

      return order;
    }

    const basePayload = buildDeliverySocketPayload(order, row.restaurant);
    const payload = await enrichPayloadWithTripRoadDistance(order, basePayload);

    // tripDistanceKm = restaurant ↔ customer (road); pickupDistanceKm = rider → restaurant (ranking only)
    logger.info(`Broadcasting order ${id} to ${eligible.length} riders. tripDistanceKm=${payload.tripDistanceKm}`);
    const acceptanceDeadlineAt = new Date(Date.now() + DRIVER_ACCEPT_WINDOW_MS);

    if (io) {
      for (const p of eligible) {
        io.to(rooms.delivery(p.partnerId)).emit('new_order', {
          ...payload,
          pickupDistanceKm: p.distanceKm,
          acceptanceDeadlineAt,
        });
      }
    }

    const pushTargets = eligible.map((p) => ({ ownerType: 'DELIVERY_PARTNER', ownerId: p.partnerId }));
    if (pushTargets.length > 0) {
      try {
        await notifyOwnersActionableAlert(pushTargets, {
          title: 'New order available!',
          body: `Order #${order.order_id || id} is available. You have ${Math.round(DRIVER_ACCEPT_WINDOW_MS / 1000)} seconds to accept!`,
          // Two messages — see notifyOwnersActionableAlert. This alert needs the
          // app's own full-screen UI (only a data-only message triggers it) AND
          // delivery on ROMs that refuse to start the app (only a notification
          // block achieves that). Blending them loses the first.
          //
          // The tag is the contract with the app (cancel(0, tag:) in
          // fcm_service.dart) — change one and you must change the other.
          androidTag: `order_${id}`,
          // The app's incoming channel is the _v3 id; the service default is the
          // stale v1 name, and Android silently downgrades an unknown channel to
          // low importance — no sound, no heads-up.
          androidChannelId: 'incoming_orders_channel_v3',
          data: buildIncomingOrderPushData(order, payload, acceptanceDeadlineAt),
        });
      } catch (err) {
        logger.warn(`Push notifications failed for broadcast on order ${id}: ${err.message}`);
      }
    }

    // Conditional update, NOT a blind write. This row was loaded before several
    // awaits (rider lookup, Directions fetch, FCM batch) — seconds during which a
    // rider may have accepted. A blind write reverted that accept to unassigned,
    // so the order was re-broadcast and a second rider could claim the same trip.
    const { count: reoffered } = await prisma.foodOrder.updateMany({
      where: { id, dispatchStatus: { not: 'accepted' }, dispatchAcceptedAt: null },
      data: { dispatchStatus: 'unassigned', dispatchDeliveryPartnerId: null },
    });

    if (reoffered === 0) {
      logger.info(`tryAutoAssign: order ${id} was accepted during broadcast — leaving assignment intact.`);
      return order;
    }

    // The offeredTo[] array is its own table now, so the offers are appended
    // rather than pushed onto the document.
    await prisma.orderDispatchOffer.createMany({
      data: eligible.map((p) => ({
        orderId: id,
        partnerId: String(p.partnerId),
        at: new Date(),
        action: 'offered',
      })),
    });

    // Re-check when the offer window closes, so the next round starts exactly as
    // the client countdown hits zero.
    await addOrderJob(
      { action: 'DISPATCH_TIMEOUT_CHECK', orderMongoId: id, orderId: id, attempt: attempt + 1 },
      { delay: DRIVER_ACCEPT_WINDOW_MS },
    );

    return order;
  } finally {
    await prisma.foodOrder.update({ where: { id }, data: { dispatchingAt: null } }).catch(() => {});
  }
}

export async function processDispatchTimeout(orderId, partnerId) {
  const id = String(orderId);
  const row = await prisma.foodOrder.findUnique({ where: { id }, include: orderInclude });
  if (!row) return;

  const offerCount = row.dispatchOffers?.length || 0;

  const stillAssigned =
    row.dispatchStatus === 'assigned' &&
    String(row.dispatchDeliveryPartnerId) === String(partnerId) &&
    !row.dispatchAcceptedAt;

  if (stillAssigned) {
    logger.info(`Dispatch timeout for partner ${partnerId} on order ${id}. Re-trying hunt...`);

    const offer = row.dispatchOffers.find(
      (o) => String(o.partnerId) === String(partnerId) && o.action === 'offered',
    );
    if (offer) {
      await prisma.orderDispatchOffer.update({ where: { id: offer.id }, data: { action: 'timeout' } });
    }

    await prisma.foodOrder.update({
      where: { id },
      data: { dispatchStatus: 'unassigned', dispatchDeliveryPartnerId: null },
    });

    await tryAutoAssign(id, { attempt: offerCount + 1 });
  } else if (row.dispatchStatus === 'unassigned') {
    // Already unassigned (e.g. from a previous timeout) — just keep hunting.
    await tryAutoAssign(id, { attempt: offerCount + 1 });
  }
}

/** Shared by the restaurant and admin resend endpoints. */
async function resetDispatchAndRehunt(row, activeStatuses) {
  if (!activeStatuses.includes(row.orderStatus)) {
    throw new ValidationError(`Cannot resend notification for order in status: ${row.orderStatus}`);
  }
  if (row.dispatchStatus === 'accepted') {
    throw new ValidationError('A delivery partner has already accepted this order.');
  }

  await prisma.$transaction([
    prisma.orderDispatchOffer.deleteMany({ where: { orderId: row.id } }),
    prisma.foodOrder.update({
      where: { id: row.id },
      data: { dispatchStatus: 'unassigned', dispatchDeliveryPartnerId: null },
    }),
  ]);

  await tryAutoAssign(row.id);
  return { success: true };
}

export async function resendDeliveryNotificationRestaurant(orderId, restaurantId) {
  const identity = buildOrderIdentityFilter(orderId);
  const row = await prisma.foodOrder.findFirst({
    where: { ...identity, restaurantId: String(restaurantId) },
    select: { id: true, orderStatus: true, dispatchStatus: true },
  });
  if (!row) throw new NotFoundError('Order not found');

  return resetDispatchAndRehunt(row, ['confirmed', 'preparing', 'ready_for_pickup', 'ready']);
}

export async function resendDeliveryNotificationAdmin(orderId) {
  const identity = buildOrderIdentityFilter(orderId);
  const row = await prisma.foodOrder.findFirst({
    where: identity,
    select: { id: true, orderStatus: true, dispatchStatus: true },
  });
  if (!row) throw new NotFoundError('Order not found');

  if (row.dispatchStatus === 'accepted') {
    throw new ValidationError(
      'A delivery partner has already accepted this order. Please use Deassign & Resend instead.',
    );
  }

  return resetDispatchAndRehunt(row, [
    'confirmed', 'preparing', 'ready_for_pickup', 'ready', 'reached_pickup',
  ]);
}
