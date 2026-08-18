import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { logger } from '../../../../utils/logger.js';
import { haversineKm as geoHaversineKm, parseGeoPoint } from '../../shared/geo.utils.js';
import {
  notifyOwnersActionableAlert,
  sendNotificationToOwner,
  sendNotificationToOwners,
} from "../../../../core/notifications/firebase.service.js";
import { getIO, rooms } from '../../../../config/socket.js';
import { addOrderJob } from '../../../../queues/producers/order.producer.js';

export function enqueueOrderEvent(action, payload = {}) {
  try {
    void addOrderJob({ action, ...payload }).catch((err) => {
      logger.warn(`BullMQ enqueue order event failed: ${action} - ${err?.message || err}`);
    });
  } catch (err) {
    logger.warn(`BullMQ enqueue order event failed (sync): ${action} - ${err?.message || err}`);
  }
}

export function haversineKm(lat1, lon1, lat2, lon2) {
  return geoHaversineKm(lat1, lon1, lat2, lon2);
}

/**
 * Build a dialer URI the client can hand straight to url_launcher / Linking.
 * Strips spaces, dashes and brackets — a raw number with formatting won't dial.
 * Returns '' when there is no usable number, so the app can hide the call button.
 */
export function buildTelUri(phone) {
  const digits = String(phone || '').replace(/[^\d+]/g, '');
  if (digits.replace(/\D/g, '').length < 6) return '';
  return `tel:${digits}`;
}

export function generateFourDigitDeliveryOtp() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

export function sanitizeOrderForExternal(orderDoc) {
  const o = { ...(orderDoc || {}) };
  delete o.deliveryOtp;
  const dv = o.deliveryVerification;
  if (dv && dv.dropOtp != null) {
    const d = dv.dropOtp;
    o.deliveryVerification = {
      ...dv,
      dropOtp: {
        required: Boolean(d.required),
        verified: Boolean(d.verified),
      },
    };
  }
  o.orderMongoId = (o._id || orderDoc?._id || "").toString();
  // Ensure orderId field for UI always contains the pretty ID
  o.orderId = o.order_id || o.orderMongoId; 
  return o;
}

export function sanitizeOrderForDeliveryPartner(orderDoc) {
  const o = sanitizeOrderForExternal(orderDoc);
  const cookingNote = String(o.note || "").trim();
  const deliveryInstructions = String(o.deliveryInstructions || "").trim();
  return {
    ...o,
    cookingNote,
    deliveryInstructions,
    note: deliveryInstructions,
  };
}

export function emitDeliveryDropOtpToUser(order, plainOtp) {
  try {
    const io = getIO();
    if (!io || !plainOtp || !order?.userId) return;
    io.to(rooms.user(order.userId)).emit("delivery_drop_otp", {
      orderMongoId: order._id?.toString?.(),
      orderId: order.order_id || order._id?.toString?.(),
      otp: plainOtp,
      message:
        "Share this OTP with your delivery partner to hand over the order.",
    });
  } catch (e) {
    logger.warn(`emitDeliveryDropOtpToUser failed: ${e?.message || e}`);
  }
}

export async function notifyOwnersSafely(targets, payload) {
  try {
    await sendNotificationToOwners(targets, payload);
  } catch (error) {
    logger.warn(`FCM notification failed: ${error?.message || error}`);
  }
}

/** Re-exported so dispatch and the order helpers share one definition. */
export { notifyOwnersActionableAlert };

export async function notifyOwnerSafely(target, payload) {
  try {
    await sendNotificationToOwner({ ...target, payload });
  } catch (error) {
    logger.warn(`FCM notification failed: ${error?.message || error}`);
  }
}

export const TERMINAL_ORDER_STATUSES = [
  'delivered',
  'cancelled_by_user',
  'cancelled_by_restaurant',
  'cancelled_by_admin',
];

export async function partnerHasActiveDelivery(deliveryPartnerId) {
  if (!deliveryPartnerId) return false;

  const active = await prisma.foodOrder.findFirst({
    where: {
      dispatchDeliveryPartnerId: String(deliveryPartnerId),
      dispatchStatus: 'accepted',
      orderStatus: { notIn: TERMINAL_ORDER_STATUSES },
    },
    select: { id: true },
  });

  return Boolean(active);
}

export async function getBusyDeliveryPartnerIds() {
  const rows = await prisma.foodOrder.findMany({
    where: {
      dispatchStatus: 'accepted',
      dispatchDeliveryPartnerId: { not: null },
      orderStatus: { notIn: TERMINAL_ORDER_STATUSES },
    },
    select: { dispatchDeliveryPartnerId: true },
    distinct: ['dispatchDeliveryPartnerId'],
  });

  return new Set(rows.map((row) => row.dispatchDeliveryPartnerId));
}

/** Accepts either a raw order id or the display id ("FOD-…"). */
export function buildOrderIdentityFilter(orderIdOrDisplayId) {
  const raw = String(orderIdOrDisplayId || "").trim();
  if (!raw) return null;
  if (isId(raw)) return { id: raw };

  // Both variants are still searched — orderId is the legacy alias of order_id.
  return { OR: [{ order_id: raw }, { orderId: raw }] };
}

export function toGeoPoint(lat, lng) {
  if (lat == null || lng == null) return undefined;
  const a = Number(lat);
  const b = Number(lng);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return undefined;
  return { type: "Point", coordinates: [b, a] };
}

/**
 * Append a status-history entry.
 *
 * Was a push onto an embedded array that the caller then saved; history is its own
 * table now, so this writes immediately. Pass `tx` to enlist it in a surrounding
 * transaction alongside the status change itself.
 */
export function pushStatusHistory(orderId, { byRole, byId, from, to, note = "" }, tx = prisma) {
  return tx.orderStatusHistory.create({
    data: {
      orderId: String(orderId),
      at: new Date(),
      byRole,
      byId: byId ? String(byId) : null,
      from,
      to,
      note,
    },
  });
}

export function normalizeOrderForClient(orderDoc) {
  const order = orderDoc || {};
  const mongoId = (order._id || orderDoc?._id || "").toString();
  const displayId = order.order_id || mongoId;
  const statusHistory = Array.isArray(order?.statusHistory)
    ? order.statusHistory
    : [];
  const cancellationEntry = [...statusHistory]
    .reverse()
    .find((entry) => String(entry?.to || "").toLowerCase().includes("cancel"));
  const cancellationReason =
    String(order?.cancellationReason || "").trim() ||
    String(cancellationEntry?.note || "").trim();
  const cancellationStatus = String(cancellationEntry?.to || "").toLowerCase();
  let cancelledBy = "";
  if (cancellationStatus === "cancelled_by_user") cancelledBy = "customer";
  else if (cancellationStatus === "cancelled_by_restaurant")
    cancelledBy = "restaurant";
  else if (cancellationStatus === "cancelled_by_admin") cancelledBy = "admin";
  else if (String(cancellationEntry?.byRole || "").toUpperCase() === "USER")
    cancelledBy = "customer";
  else if (
    String(cancellationEntry?.byRole || "").toUpperCase() === "RESTAURANT"
  )
    cancelledBy = "restaurant";
  else if (String(cancellationEntry?.byRole || "").toUpperCase() === "ADMIN")
    cancelledBy = "admin";

  return {
    ...order,
    orderMongoId: mongoId,
    orderId: displayId,
    status: order?.orderStatus || order?.status || "",
    cancellationReason,
    cancelledBy,
    cancelledAt: cancellationEntry?.at || null,
    deliveredAt:
      order?.deliveryState?.deliveredAt || order?.deliveredAt || null,
    deliveryPartnerId:
      order?.dispatch?.deliveryPartnerId || order?.deliveryPartnerId || null,
    rating: order?.ratings?.restaurant?.rating ?? order?.rating ?? null,
    deliveryState: {
      ...(order?.deliveryState || {}),
      currentLocation: order?.lastRiderLocation?.coordinates?.length >= 2 ? {
        lat: order.lastRiderLocation.coordinates[1],
        lng: order.lastRiderLocation.coordinates[0]
      } : (order?.deliveryState?.currentLocation || null)
    },
    eta: buildLiveEta(order)
  };
}

/** Straight-line km inflated to approximate road distance for city driving. */
const ROAD_FACTOR = 1.3;
/** Average city delivery speed (km/h) — bikes in traffic. */
const AVG_SPEED_KMPH = 22;

/**
 * Live ETA derived from the rider's last known position, recomputed on every read.
 *
 * Deliberately NOT a Directions API call: this is read on every order fetch and poll, so a
 * paid call here would be billed per refresh. Accuracy is "good enough for a countdown";
 * `source` tells the client what it is looking at.
 */
export function buildLiveEta(order) {
  const status = String(order?.orderStatus || '');
  if (['delivered', 'cancelled_by_user', 'cancelled_by_restaurant', 'cancelled_by_admin'].includes(status)) {
    return { minutes: null, distanceKm: null, source: 'completed', target: null };
  }

  const rider = order?.lastRiderLocation?.coordinates?.length >= 2
    ? { lat: order.lastRiderLocation.coordinates[1], lng: order.lastRiderLocation.coordinates[0] }
    : null;

  const pickedUp = Boolean(order?.deliveryState?.pickedUpAt) || ['picked_up', 'reached_drop'].includes(status);
  // Before pickup the rider is heading to the restaurant; after, to the customer.
  const dest = pickedUp ? parseGeoPoint(order?.deliveryAddress) : parseGeoPoint(order?.restaurantId);
  const target = pickedUp ? 'customer' : 'restaurant';

  if (rider && dest) {
    const straight = geoHaversineKm(rider.lat, rider.lng, dest.lat, dest.lng);
    if (Number.isFinite(straight)) {
      const km = Number((straight * ROAD_FACTOR).toFixed(2));
      const minutes = Math.max(1, Math.ceil((km / AVG_SPEED_KMPH) * 60));
      return { minutes, distanceKm: km, source: 'live', target };
    }
  }

  // No rider fix yet — fall back to the trip estimate captured at order time.
  const fallback = Number(order?.tripDurationMins ?? order?.pricing?.roadDurationMins);
  if (Number.isFinite(fallback) && fallback > 0) {
    return {
      minutes: Math.ceil(fallback),
      distanceKm: Number(order?.tripDistanceKm ?? order?.pricing?.roadDistanceKm) || null,
      source: 'estimate',
      target
    };
  }

  return { minutes: null, distanceKm: null, source: 'unavailable', target };
}

/** Tables carrying a running (rating, totalRatings) pair. */
const RATEABLE = {
  restaurant: 'food_restaurants',
  deliveryPartner: 'food_delivery_partners',
  foodItem: 'food_items',
  user: 'food_users',
};

/**
 * Fold one new rating into an entity's running average.
 *
 * Recomputed inside a single UPDATE rather than read-compute-save: two customers
 * rating the same restaurant at once both read the same totalRatings under the old
 * version, and whichever saved last silently discarded the other's rating.
 *
 * @param {keyof RATEABLE} entity
 */
export async function applyAggregateRating(entity, entityId, newRating) {
  const table = RATEABLE[entity];
  if (!table || !entityId) return;

  const rating = Number(newRating);
  if (!Number.isFinite(rating)) return;

  // Table name comes from the whitelist above, never from a caller string.
  await prisma.$executeRawUnsafe(
    `UPDATE "${table}"
        SET "rating" = ROUND((("rating" * "totalRatings") + $1) / ("totalRatings" + 1), 1),
            "totalRatings" = "totalRatings" + 1,
            "updatedAt" = now()
      WHERE "id" = $2`,
    rating,
    String(entityId),
  );
}

export function buildDeliverySocketPayload(orderDoc, restaurantDoc = null) {
  const order = orderDoc || {};
  const restaurant = restaurantDoc || order?.restaurantId || null;
  const restaurantLocation = restaurant?.location || {};
  const deliveryAddress = order?.deliveryAddress || {};
  const customerAddressParts = [
    deliveryAddress.street,
    deliveryAddress.additionalDetails,
    deliveryAddress.city,
    deliveryAddress.state,
    deliveryAddress.zipCode,
  ]
    .map((v) => String(v || '').trim())
    .filter(Boolean);

  // Prefer robust geo parse (GeoJSON [lng,lat], lat/lng, nested location)
  const restaurantPoint =
    parseGeoPoint(restaurant) ||
    parseGeoPoint(restaurantLocation) ||
    parseGeoPoint({
      lat: restaurantLocation?.latitude ?? restaurantLocation?.lat,
      lng: restaurantLocation?.longitude ?? restaurantLocation?.lng,
    });
  const customerPoint =
    parseGeoPoint(deliveryAddress) ||
    parseGeoPoint(order?.customerLocation) ||
    parseGeoPoint({
      lat: deliveryAddress?.latitude ?? deliveryAddress?.lat,
      lng: deliveryAddress?.longitude ?? deliveryAddress?.lng,
    });

  const restaurantLat = restaurantPoint?.lat;
  const restaurantLng = restaurantPoint?.lng;
  const customerLat = customerPoint?.lat;
  const customerLng = customerPoint?.lng;

  // Prefer road distance when already computed; fall back to pricing Haversine.
  // Never use pickupDistanceKm (rider → restaurant) here — this is restaurant ↔ customer.
  const tripDistanceKmRaw =
    order?.tripDistanceKm ??
    order?.pricing?.roadDistanceKm ??
    order?.pricing?.distanceKm;
  let tripDistanceKm = Number.isFinite(Number(tripDistanceKmRaw))
    ? Number(Number(tripDistanceKmRaw).toFixed(2))
    : null;

  // If still missing, compute Haversine restaurant → customer so UI never shows blank/wrong.
  if (
    tripDistanceKm == null &&
    Number.isFinite(restaurantLat) &&
    Number.isFinite(restaurantLng) &&
    Number.isFinite(customerLat) &&
    Number.isFinite(customerLng)
  ) {
    const hv = haversineKm(restaurantLat, restaurantLng, customerLat, customerLng);
    if (Number.isFinite(hv)) {
      tripDistanceKm = Number(Number(hv).toFixed(2));
    }
  }

  const tripDurationMinsRaw =
    order?.tripDurationMins ?? order?.pricing?.roadDurationMins;
  let tripDurationMins = Number.isFinite(Number(tripDurationMinsRaw))
    ? Math.ceil(Number(tripDurationMinsRaw))
    : null;
  if (tripDurationMins == null && tripDistanceKm != null) {
    // ~25 km/h urban delivery average → minutes
    tripDurationMins = Math.max(1, Math.ceil((tripDistanceKm * 60) / 25));
  }


  return {
    orderMongoId:
      orderDoc?._id?.toString?.() || order?._id?.toString?.() || order?._id,
    orderId: order?.order_id || order?._id?.toString?.(),
    status: orderDoc?.orderStatus || order?.orderStatus,
    items: order?.items || [],
    pricing: order?.pricing,
    total: order?.pricing?.total,
    payment: order?.payment,
    paymentMethod: order?.payment?.method,
    restaurantId:
      order?.restaurantId?._id?.toString?.() ||
      order?.restaurantId?.toString?.() ||
      order?.restaurantId,
    restaurantName: restaurant?.restaurantName || order?.restaurantName,
    restaurantAddress:
      restaurantLocation?.address ||
      restaurantLocation?.formattedAddress ||
      restaurant?.addressLine1 ||
      "",
    restaurantPhone: restaurant?.phone || restaurant?.ownerPhone || "",
    // Ready-to-launch dialer URI — the app can pass this straight to url_launcher.
    restaurantCallUri: buildTelUri(restaurant?.phone || restaurant?.ownerPhone),
    // Photos of the premises so the rider can recognise the shop on arrival.
    restaurantCoverImage:
      restaurant?.coverImage || (Array.isArray(restaurant?.coverImages) ? restaurant.coverImages[0] : '') || '',
    restaurantGalleryImages: Array.isArray(restaurant?.galleryImages) ? restaurant.galleryImages : [],
    restaurantLandmark: restaurant?.landmark || "",
    restaurantLocation: {
      latitude: Number.isFinite(restaurantLat) ? restaurantLat : undefined,
      longitude: Number.isFinite(restaurantLng) ? restaurantLng : undefined,
      lat: Number.isFinite(restaurantLat) ? restaurantLat : undefined,
      lng: Number.isFinite(restaurantLng) ? restaurantLng : undefined,
      coordinates:
        Number.isFinite(restaurantLat) && Number.isFinite(restaurantLng)
          ? [restaurantLng, restaurantLat]
          : undefined,
      address:
        restaurantLocation?.address ||
        restaurantLocation?.formattedAddress ||
        restaurant?.addressLine1 ||
        "",
      area: restaurantLocation?.area || restaurant?.area || "",
      city: restaurantLocation?.city || restaurant?.city || "",
      state: restaurantLocation?.state || restaurant?.state || "",
    },
    deliveryAddress: order?.deliveryAddress,
    customerLocation: {
      latitude: Number.isFinite(customerLat) ? customerLat : undefined,
      longitude: Number.isFinite(customerLng) ? customerLng : undefined,
      lat: Number.isFinite(customerLat) ? customerLat : undefined,
      lng: Number.isFinite(customerLng) ? customerLng : undefined,
      coordinates:
        Number.isFinite(customerLat) && Number.isFinite(customerLng)
          ? [customerLng, customerLat]
          : undefined,
    },
    // Restaurant ↔ customer trip distance (NOT rider pickup distance)
    tripDistanceKm,
    tripDurationMins,
    distanceKm: tripDistanceKm,
    customerAddress: customerAddressParts.length ? customerAddressParts.join(', ') : "",
    customerName: order?.customerName || order?.deliveryAddress?.fullName || order?.deliveryAddress?.name || order?.userId?.name || "",
    customerPhone: order?.customerPhone || order?.deliveryAddress?.phone || order?.userId?.phone || "",
    customerCallUri: buildTelUri(
      order?.customerPhone || order?.deliveryAddress?.phone || order?.userId?.phone,
    ),
    userName: order?.customerName || order?.deliveryAddress?.fullName || order?.deliveryAddress?.name || order?.userId?.name || "",
    userPhone: order?.customerPhone || order?.deliveryAddress?.phone || order?.userId?.phone || "",
    note: order?.deliveryInstructions || "",
    cookingNote: order?.note || "",
    deliveryInstructions: order?.deliveryInstructions || "",
    riderEarning: order?.riderEarning || 0,
    earnings: order?.riderEarning || order?.pricing?.deliveryFee || 0,
    deliveryFee: order?.pricing?.deliveryFee || 0,
    deliveryFleet: order?.deliveryFleet,
    dispatch: order?.dispatch,
    createdAt: order?.createdAt,
    updatedAt: order?.updatedAt,
  };
}

export function canExposeOrderToRestaurant(orderLike) {
  if (String(orderLike?.orderStatus || "").toLowerCase() === "pending_payment") return false;
  const method = String(orderLike?.payment?.method || "").toLowerCase();
  const status = String(orderLike?.payment?.status || "").toLowerCase();
  // razorpay_qr is a pay-at-delivery flow like cash: the rider collects via QR at the
  // door, so the restaurant must see and prepare it even though nothing is captured yet.
  // Omitting it hid those orders from the restaurant list while still dispatching them,
  // so they silently auto-cancelled at the acceptance deadline.
  if (["cash", "wallet", "razorpay_qr"].includes(method)) return true;
  return ["paid", "authorized", "captured", "settled"].includes(status);
}

export async function notifyRestaurantNewOrder(orderDoc) {
  try {
    if (!orderDoc || !canExposeOrderToRestaurant(orderDoc)) return;

    const io = getIO();
    if (io) {
      const payload = {
        ...orderDoc,
        orderMongoId: orderDoc._id || undefined,
        orderId: orderDoc.order_id || orderDoc._id,
      };
      logger.info(
        `[RestaurantOrders] Emitting new_order to ${rooms.restaurant(orderDoc.restaurantId)} for order ${orderDoc._id?.toString?.() || ''}`,
      );
      io.to(rooms.restaurant(orderDoc.restaurantId)).emit("new_order", payload);
    }

    // Atomic claim: only the caller that flips restaurantNotifiedAt from null actually
    // sends the push, so a retried webhook or duplicate code path can never ring the
    // restaurant twice. updateMany carries the guard in its WHERE clause and reports
    // how many rows it won. The socket emit above stays unguarded — it is just a UI
    // refresh and is idempotent.
    const { count: claimed } = await prisma.foodOrder.updateMany({
      where: { id: String(orderDoc._id || orderDoc.id), restaurantNotifiedAt: null },
      data: { restaurantNotifiedAt: new Date() },
    });
    if (claimed === 0) return;

    const str = (v) => (v === undefined || v === null ? "" : String(v));
    const itemCount = Array.isArray(orderDoc.items)
      ? orderDoc.items.reduce((sum, it) => sum + (Number(it?.quantity) || 0), 0)
      : 0;
    const itemsList = Array.isArray(orderDoc.items)
      ? orderDoc.items.map((it) => `${it.quantity}x ${it.name}`).join(", ")
      : "";
    // deliveryAddressSchema has street/additionalDetails/city — there is no `address`
    // or `area` field on it, so reading those yielded undefined and the restaurant
    // only ever saw the city.
    const addressStr = orderDoc.deliveryAddress
      ? [
          orderDoc.deliveryAddress.street,
          orderDoc.deliveryAddress.additionalDetails,
          orderDoc.deliveryAddress.city,
        ]
          .filter(Boolean)
          .join(", ")
      : "";
    const total = orderDoc.pricing?.total ?? 0;
    
    // Construct rich body for the custom notification layout in Flutter
    let bodyText = `Order #${orderDoc.order_id || orderDoc._id} is waiting for review.`;
    if (itemsList) bodyText += `\nItems: ${itemsList}`;
    if (total > 0) bodyText += `\nTotal: ₹${total}`;
    if (orderDoc.customerName) bodyText += `\nCustomer: ${orderDoc.customerName}`;
    if (addressStr) bodyText += `\nAddress: ${addressStr}`;

    // Two messages, not one — see notifyOwnersActionableAlert.
    //
    // Accept/Reject can only be attached by the app itself, and the app is only
    // called for a data-only message. Blending both into a single message with a
    // notification block silently removed the buttons, because Android renders
    // such a message and never wakes the handler that would have added them.
    await notifyOwnersActionableAlert(
      [{ ownerType: "RESTAURANT", ownerId: orderDoc.restaurantId }],
      {
        title: "New order received",
        body: bodyText,
        androidTag: `order_${orderDoc._id?.toString?.() || ""}`,
        // The channel the restaurant app actually creates. The service default
        // is incoming_orders_channel, which exists only in the rider app —
        // Android silently demotes an unknown channel to low importance, so the
        // alert would arrive without sound or a heads-up even once it displayed.
        androidChannelId: "new_order_channel",
        data: {
          type: "new_order",
          title: "New order received",
          body: bodyText,
          orderId: orderDoc._id.toString(),
          orderMongoId: orderDoc._id?.toString?.() || "",
          orderDisplayId: str(orderDoc.order_id || orderDoc._id),
          link: `/restaurant/orders/${orderDoc._id?.toString?.() || ""}`,
          // Everything the notification needs to render without a follow-up API
          // call, which matters when the device is locked or the app was killed.
          customerName: str(orderDoc.customerName),
          itemCount: str(itemCount),
          itemsList: str(itemsList),
          address: str(addressStr),
          total: str(total),
          paymentMethod: str(orderDoc.payment?.method),
          acceptanceDeadlineAt: str(orderDoc.acceptanceDeadlineAt?.toISOString?.() || ""),
        },
      },
    );
  } catch {
    // Do not block order/payment flow if notification fails.
  }
}

export const CANCELLED_ORDER_STATUSES = [
  "cancelled_by_user",
  "cancelled_by_restaurant",
  "cancelled_by_admin",
];

export const normalizeOrderStatusValue = (value) => {
  const status = String(value || "").trim().toLowerCase();
  if (!status) return "";
  return status.replace(/^canceled/, "cancelled");
};

export const isCancelledOrderStatus = (value) => {
  const status = normalizeOrderStatusValue(value);
  if (!status) return false;
  if (CANCELLED_ORDER_STATUSES.includes(status)) return true;
  if (status === "cancelled" || status === "canceled") return true;
  return status.startsWith("cancelled_by_") || status.startsWith("canceled_by_");
};

export const isCancelledOrder = (order) => {
  if (
    isCancelledOrderStatus(order?.orderStatus) ||
    isCancelledOrderStatus(order?.status)
  ) {
    return true;
  }

  const history = Array.isArray(order?.statusHistory) ? order.statusHistory : [];
  const cancellationEntry = [...history]
    .reverse()
    .find((entry) => String(entry?.to || "").toLowerCase().includes("cancel"));

  return Boolean(
    cancellationEntry && isCancelledOrderStatus(cancellationEntry.to),
  );
};

export const STATUS_PRIORITY = {
  created: 10,
  confirmed: 20,
  preparing: 30,
  ready_for_pickup: 40,
  reached_pickup: 50,
  picked_up: 60,
  reached_drop: 70,
  delivered: 80,
  cancelled_by_user: 100,
  cancelled_by_restaurant: 100,
  cancelled_by_admin: 100,
};

/**
 * Returns true if the next status is a valid forward progression from the current status.
 * Prevents "reversing" order status (e.g. from Preparing back to Created).
 */
export function isStatusAdvance(current, next) {
  // If current status is missing, it's effectively 'created' or start of flow
  if (!current) return true;
  
  const currentPrio = STATUS_PRIORITY[current] || 0;
  const nextPrio = STATUS_PRIORITY[next] || 0;

  // Terminal states (100) cannot transition to anything else
  if (currentPrio >= 100) return false;
  
  // Delivered (80) cannot transition to anything (except maybe cancellation if allowed, but here we say no)
  if (currentPrio === 80) return false;

  // Special case: Cancellation is almost always an advance unless already delivered
  if (nextPrio === 100 && currentPrio < 80) return true;

  return nextPrio > currentPrio;
}
