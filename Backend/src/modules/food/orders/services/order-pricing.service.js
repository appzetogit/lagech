import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { ValidationError } from '../../../../core/auth/errors.js';
import {
  calculateDistanceKm,
  normalizeDeliveryAddress,
  parseGeoPoint,
} from '../../shared/geo.utils.js';
import { fetchDrivingRoute } from '../utils/googleMaps.js';
import { attachOutletTimingsToRestaurants } from '../../restaurant/services/outletTimings.service.js';
import { getRestaurantAvailabilityStatus } from '../../restaurant/helpers/restaurantAvailability.helper.js';
import { resolveOrderCartItems } from '../helpers/order-cart-items.helper.js';

const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;

/**
 * GST on the delivery fee, at the rate the admin configured.
 *
 * This used to be a hardcoded 18% that nothing exposed and no one could switch
 * off — it was folded silently into the total, so customers paid it without a
 * line item ever naming it. It is now `deliveryFeeGstRate` in the fee settings
 * alongside the item GST rate, and unset means not charged.
 */
export function resolveDeliveryFeeGstRate(feeSettings = {}) {
  const rate = Number(feeSettings.deliveryFeeGstRate);
  return Number.isFinite(rate) && rate > 0 ? rate : 0;
}

export function computeDeliveryFeeGst(deliveryFee, ratePercent = 0) {
  const base = Math.max(0, Number(deliveryFee) || 0);
  const rate = Number(ratePercent);
  if (base <= 0 || !Number.isFinite(rate) || rate <= 0) return 0;
  return round2((base * rate) / 100);
}

const applyDeliveryModePricing = (pricing, deliveryMode, quickSurcharge = 0) => {
  const surcharge = Math.max(0, Number(quickSurcharge) || 0);
  const mode = deliveryMode === 'quick' ? 'quick' : 'basic';
  if (mode !== 'quick' || surcharge <= 0) {
    return {
      ...pricing,
      deliveryMode: mode,
      quickDeliveryFee: 0,
    };
  }
  const platformFee = round2((Number(pricing.platformFee) || 0) + surcharge);
  const total = round2((Number(pricing.total) || 0) + surcharge);
  return {
    ...pricing,
    platformFee,
    total,
    deliveryMode: mode,
    quickDeliveryFee: surcharge,
  };
};

export async function loadRestaurantForOrdering(restaurantId) {
  if (!isId(restaurantId)) {
    throw new ValidationError('Restaurant not found');
  }

  const doc = await prisma.foodRestaurant.findUnique({
    where: { id: String(restaurantId) },
    select: {
      id: true,
      status: true,
      restaurantName: true,
      zoneId: true,
      // Flat lat/lng rather than a nested location object — parseGeoPoint reads
      // these off the entity directly, so distance calculations are unchanged.
      latitude: true,
      longitude: true,
      isAcceptingOrders: true,
      outsideHoursOverride: true,
      openingTime: true,
      closingTime: true,
      openDays: true,
    },
  });

  if (!doc) throw new ValidationError('Restaurant not found');
  if (doc.status !== 'approved') throw new ValidationError('Restaurant not available');

  const [withTimings] = await attachOutletTimingsToRestaurants([doc], {
    useDefaults: false,
  });
  return withTimings;
}

export function assertRestaurantOpenForOrdering(restaurant, at = new Date()) {
  const availability = getRestaurantAvailabilityStatus(restaurant, at);
  if (availability.isOpen) return availability;

  if (availability.reason === 'not-accepting-orders') {
    throw new ValidationError('Restaurant is currently offline. Please try again later.');
  }

  throw new ValidationError('Restaurant is currently closed. Please try again later.');
}

/**
 * Single source of truth for restaurant ↔ customer trip distance.
 * Prefer Google driving/road km (matches delivery partner Rest→User UI);
 * fall back to Haversine when Directions is unavailable.
 */
export async function getDeliveryDistanceKm(restaurant, deliveryAddress) {
  const straightLineKm = calculateDistanceKm(restaurant, deliveryAddress);

  const restaurantPoint = parseGeoPoint(restaurant);
  const customerPoint = parseGeoPoint(deliveryAddress);
  if (!restaurantPoint || !customerPoint) {
    return straightLineKm;
  }

  try {
    const route = await fetchDrivingRoute(
      { lat: restaurantPoint.lat, lng: restaurantPoint.lng },
      { lat: customerPoint.lat, lng: customerPoint.lng },
    );
    if (route?.distanceKm != null && Number.isFinite(Number(route.distanceKm))) {
      return Number(route.distanceKm);
    }
  } catch {
    // Fall through to Haversine.
  }

  return straightLineKm;
}

// Single money-rounding rule (2 decimals) so preview and charged totals always match.

const deliveryFeeBands = (feeSettings = {}) =>
  (Array.isArray(feeSettings.deliveryFeeRanges) ? feeSettings.deliveryFeeRanges : []).filter(
    (range) => Number.isFinite(Number(range?.fee)) && Number(range.fee) >= 0,
  );

/**
 * The fee to charge when the distance bands cannot decide.
 *
 * Configured bands always win now. The flat `deliveryFee` used to take priority
 * over them, which is how a fee higher than every band ended up on carts whose
 * distance was not known yet — a number no band would ever have produced. The
 * flat fee is only a fallback for the case it was meant for: no bands set up at
 * all.
 *
 * With bands present the cheapest one is the honest pre-address estimate; the
 * real distance replaces it as soon as an address is picked.
 */
function resolveBaseDeliveryFee(feeSettings = {}) {
  const bands = deliveryFeeBands(feeSettings);
  if (bands.length > 0) {
    return Math.min(...bands.map((range) => Number(range.fee)));
  }

  const flat = Number(feeSettings.deliveryFee);
  return Number.isFinite(flat) && flat >= 0 ? flat : 0;
}

/**
 * A trip longer than every configured band still has to be priced. Charging the
 * cheapest band for it would undercharge the longest deliveries, so use the
 * widest band — the same fallback calculateRiderEarning already uses for pay.
 */
function widestBandFee(feeSettings = {}) {
  const bands = deliveryFeeBands(feeSettings);
  if (bands.length === 0) return null;
  const widest = [...bands].sort((a, b) => Number(a?.max ?? 0) - Number(b?.max ?? 0)).pop();
  return Number(widest.fee);
}

/**
 * How far the platform actually delivers, in km.
 *
 * Taken from the widest configured band rather than a separate setting: the
 * bands are the only place a price exists for a distance, so a trip past the
 * last one is by definition a trip nobody has priced. Null when no bands are
 * configured — then there is nothing to derive a limit from and no limit is
 * enforced.
 */
export function serviceableRadiusKm(feeSettings = {}) {
  const maxima = deliveryFeeBands(feeSettings)
    .map((range) => Number(range?.max))
    .filter((max) => Number.isFinite(max) && max > 0);
  return maxima.length > 0 ? Math.max(...maxima) : null;
}

function matchFeeRange(ranges, distanceKm, pickValue) {
  if (!Array.isArray(ranges) || ranges.length === 0 || !Number.isFinite(distanceKm)) {
    return null;
  }

  const sorted = [...ranges].sort((a, b) => Number(a.min) - Number(b.min));
  for (let i = 0; i < sorted.length; i += 1) {
    const range = sorted[i] || {};
    const min = Number(range.min);
    const max = Number(range.max);
    if (!Number.isFinite(min) || !Number.isFinite(max)) continue;

    const isLast = i === sorted.length - 1;
    const inRange = isLast
      ? distanceKm >= min && distanceKm <= max
      : distanceKm >= min && distanceKm < max;

    if (inRange) {
      const value = pickValue(range);
      return Number.isFinite(value) ? value : null;
    }
  }

  return null;
}

/**
 * Distance bands are their own table now, but every pricing function below reads
 * them as `feeSettings.deliveryFeeRanges` — an array of
 * `{ min, max, fee, deliveryBoyBasePay, deliveryBoyPerKm }`.
 *
 * Rebuilding that shape here keeps the pricing logic (and its tests) untouched
 * while the storage gains real constraints. Ordered by lower bound so
 * matchFeeRange's "last band is the widest" assumption holds without re-sorting.
 */
const toFeeRanges = (bands = []) =>
  bands.map((band) => ({
    id: band.id,
    min: Number(band.minDistanceKm),
    max: Number(band.maxDistanceKm),
    fee: Number(band.fee),
    deliveryBoyBasePay: Number(band.deliveryBoyBasePay),
    deliveryBoyPerKm: Number(band.deliveryBoyPerKm),
  }));

export async function loadActiveFeeSettings() {
  const feeDoc = await prisma.foodFeeSettings.findFirst({
    where: { isActive: true },
    orderBy: { createdAt: 'desc' },
    include: { deliveryFeeBands: { orderBy: { minDistanceKm: 'asc' } } },
  });

  if (!feeDoc) {
    return { deliveryFee: 0, deliveryFeeRanges: [], platformFee: 0, gstRate: 0 };
  }

  return { ...feeDoc, deliveryFeeRanges: toFeeRanges(feeDoc.deliveryFeeBands) };
}

export function resolveUserDeliveryFee(feeSettings = {}, { subtotal = 0, distanceKm = null } = {}) {
  const ranges = Array.isArray(feeSettings.deliveryFeeRanges)
    ? feeSettings.deliveryFeeRanges
    : [];

  if (ranges.length > 0 && Number.isFinite(distanceKm)) {
    const matchedFee = matchFeeRange(ranges, distanceKm, (range) => Number(range.fee));
    if (Number.isFinite(matchedFee)) {
      return {
        deliveryFee: matchedFee,
        distanceKm: Number(distanceKm.toFixed(2)),
        source: 'distance',
      };
    }
  }

  // Distance known but past the last band — price it as the longest band.
  if (Number.isFinite(distanceKm)) {
    const overRangeFee = widestBandFee(feeSettings);
    if (overRangeFee != null) {
      return {
        deliveryFee: overRangeFee,
        distanceKm: Number(distanceKm.toFixed(2)),
        source: 'distance_over_range',
      };
    }
  }

  const fallbackFee = resolveBaseDeliveryFee(feeSettings);
  return {
    deliveryFee: fallbackFee,
    distanceKm: Number.isFinite(distanceKm) ? Number(distanceKm.toFixed(2)) : null,
    source: Number.isFinite(distanceKm) ? 'default_unmatched_range' : 'default',
  };
}

export function calculateRiderEarning(feeSettings = {}, distanceKm) {
  const distance = Number(distanceKm);
  if (!Number.isFinite(distance) || distance < 0) return 0;

  const ranges = Array.isArray(feeSettings.deliveryFeeRanges)
    ? feeSettings.deliveryFeeRanges
    : [];
  if (ranges.length === 0) return 0;

  // basePay and perKm are mutually exclusive (the admin UI enforces this too):
  // a flat basePay wins, otherwise pay per km of the actual trip.
  const payFor = (range) => {
    const basePay = Number(range?.deliveryBoyBasePay || 0);
    const perKm = Number(range?.deliveryBoyPerKm || 0);

    if (basePay > 0) return basePay;
    if (perKm > 0) return distance * perKm;
    return 0;
  };

  const matched = matchFeeRange(ranges, distance, payFor);
  // A matched band is authoritative — including an explicit 0.
  if (matched != null && Number.isFinite(matched)) return Math.round(matched);

  // No band covers this distance. The customer is still charged (resolveUserDeliveryFee
  // falls back to the base fee), so paying the rider 0 here would mean unpaid work on a
  // real delivery whenever the bands don't span the dispatch radius. Fall back to the
  // widest configured band instead of silently zeroing the payout.
  const widest = [...ranges].sort(
    (a, b) => Number(a?.max ?? 0) - Number(b?.max ?? 0),
  )[ranges.length - 1];
  const fallback = payFor(widest);
  return Number.isFinite(fallback) ? Math.round(fallback) : 0;
}

/**
 * The address the trip should be priced against.
 *
 * Order creation passes a full `deliveryAddress`, but the checkout preview only
 * ever sends `deliveryAddressId`, and the cart summary sends neither — nothing
 * resolved either, so `distanceKm` came out null on every preview and the
 * distance bands were skipped entirely in favour of the flat fallback fee. The
 * customer saw one delivery charge at checkout and was billed another on
 * placing the order.
 *
 * An explicitly chosen address wins even when it has no coordinates: pricing a
 * different address than the one the customer picked would be worse than
 * falling back to the flat fee.
 */
async function resolveDeliveryAddress(userId, dto) {
  if (parseGeoPoint(dto.deliveryAddress)) return dto.deliveryAddress;
  if (!isId(userId)) return dto.deliveryAddress;

  // Addresses are their own table now; the default one sorts first so the
  // fallback below picks it without a second pass.
  const addresses = await prisma.userAddress.findMany({
    where: { userId: String(userId) },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
  });
  if (addresses.length === 0) return dto.deliveryAddress;

  const wantedId = String(dto.deliveryAddressId || '').trim();
  const chosen =
    (wantedId && addresses.find((entry) => entry.id === wantedId)) || addresses[0];

  return chosen || dto.deliveryAddress;
}

export async function calculateOrderPricing(userId, dto, options = {}) {
  const at = options.at instanceof Date ? options.at : new Date();
  const restaurant =
    options.restaurant || (await loadRestaurantForOrdering(dto.restaurantId));

  if (!options.skipAvailabilityCheck) {
    assertRestaurantOpenForOrdering(restaurant, at);
  }

  const deliveryAddress = normalizeDeliveryAddress(
    await resolveDeliveryAddress(userId, dto),
  );

  const resolvedItems = await resolveOrderCartItems(dto.restaurantId, dto.items);
  const items = resolvedItems.map((item) => ({
    ...item,
    price: Number(item.price) || 0,
    quantity: Number(item.quantity) || 1,
  }));
  const subtotal = round2(
    items.reduce(
      (sum, it) => sum + (Number(it.price) || 0) * (Number(it.quantity) || 1),
      0,
    ),
  );

  const feeSettings = await loadActiveFeeSettings();

  const packagingFee = 0;
  const platformFee = Number(feeSettings.platformFee || 0);

  let distanceKm = await getDeliveryDistanceKm(restaurant, deliveryAddress);
  const straightLineKm = calculateDistanceKm(restaurant, deliveryAddress);

  // Nothing stopped a customer ordering from a restaurant on the other side of
  // the country — one live order ran 999 km from a Punjab kitchen to an Indore
  // address, priced off the end of the bands. Refuse the order rather than
  // quote a fee for a delivery that cannot happen.
  //
  // Skipped when the distance is unknown (no address yet, or a restaurant with
  // no coordinates): an unknown distance is not evidence of a long one, and
  // blocking on it would break carts that are simply not ready to be priced.
  const radiusKm = serviceableRadiusKm(feeSettings);
  if (Number.isFinite(distanceKm) && radiusKm != null && distanceKm > radiusKm) {
    throw new ValidationError(
      `${restaurant.restaurantName || 'This restaurant'} is ${distanceKm.toFixed(
        1,
      )} km away and only delivers within ${radiusKm} km. Please choose a closer restaurant or a different address.`,
    );
  }

  const deliveryFeeResult = resolveUserDeliveryFee(feeSettings, { subtotal, distanceKm });
  const deliveryFee = round2(deliveryFeeResult.deliveryFee);
  distanceKm = deliveryFeeResult.distanceKm ?? distanceKm;

  let discount = 0;
  let appliedCoupon = null;
  const codeRaw = dto.couponCode
    ? String(dto.couponCode).trim().toUpperCase()
    : "";

  if (codeRaw) {
    const now = new Date();
    const offer = await prisma.foodOffer.findUnique({ where: { couponCode: codeRaw } });
    if (offer) {
      const offerEnd = offer.endDate ? new Date(offer.endDate) : null;
      if (offerEnd && offerEnd.getHours() === 0 && offerEnd.getMinutes() === 0) {
        offerEnd.setHours(23, 59, 59, 999);
      }
      const endOk = !offerEnd || now <= offerEnd;
      const startOk = !offer.startDate || now >= new Date(offer.startDate);
      const statusOk = offer.status === "active" && offer.showInCart !== false;
      const selectedRestaurantIds = Array.isArray(offer.restaurantIds) && offer.restaurantIds.length > 0
        ? offer.restaurantIds
        : [offer.restaurantId].filter(Boolean);
      const scopeOk =
        offer.restaurantScope !== "selected" ||
        selectedRestaurantIds.some((id) => String(id) === String(dto.restaurantId || ""));
      const minOk = subtotal >= (Number(offer.minOrderValue) || 0);
      let usageOk = true;
      if (
        Number(offer.usageLimit) > 0 &&
        Number(offer.usedCount || 0) >= Number(offer.usageLimit)
      ) {
        usageOk = false;
      }

      let perUserOk = true;
      if (isId(userId) && Number(offer.perUserLimit) > 0) {
        const usage = await prisma.foodOfferUsage.findUnique({
          where: { offerId_userId: { offerId: offer.id, userId: String(userId) } },
        });
        if (usage && Number(usage.count) >= Number(offer.perUserLimit)) {
          perUserOk = false;
        }
      }

      let firstOrderOk = true;
      // Both flags mean the same thing — the customer must have no prior orders —
      // so the count is fetched once instead of twice.
      if (isId(userId) && (offer.customerScope === 'first_time' || offer.isFirstOrderOnly === true)) {
        const priorOrders = await prisma.foodOrder.count({ where: { userId: String(userId) } });
        firstOrderOk = priorOrders === 0;
      }

      const allowed =
        statusOk &&
        startOk &&
        endOk &&
        scopeOk &&
        minOk &&
        usageOk &&
        perUserOk &&
        firstOrderOk;

      if (allowed) {
        if (offer.discountType === "percentage") {
          const raw = subtotal * (Number(offer.discountValue) / 100);
          const capped = Number(offer.maxDiscount)
            ? Math.min(raw, Number(offer.maxDiscount))
            : raw;
          discount = Math.max(0, Math.min(subtotal, Math.floor(capped)));
        } else {
          discount = Math.max(
            0,
            Math.min(subtotal, Math.floor(Number(offer.discountValue) || 0)),
          );
        }
        appliedCoupon = { code: codeRaw, discount };
      }
    }
  }

  // GST is charged on the post-discount item value (discount is already clamped to <= subtotal).
  const gstRate = Number(feeSettings.gstRate || 0);
  const tax =
    Number.isFinite(gstRate) && gstRate > 0
      ? Math.round(Math.max(0, subtotal - discount) * (gstRate / 100))
      : 0;

  const deliveryFeeGstRate = resolveDeliveryFeeGstRate(feeSettings);
  const deliveryFeeGst = computeDeliveryFeeGst(deliveryFee, deliveryFeeGstRate);

  const total = round2(
    Math.max(
      0,
      subtotal + packagingFee + deliveryFee + deliveryFeeGst + platformFee + tax - discount,
    ),
  );

  const basePricing = {
    subtotal,
    tax,
    packagingFee,
    deliveryFee,
    deliveryFeeGst,
    platformFee,
    discount,
    total,
    // The rates behind `tax` and `deliveryFeeGst`, so the apps can label the
    // bill rows ("GST (5%)") instead of showing a bare rupee figure.
    gstRate,
    deliveryFeeGstRate,
    currency: "INR",
    couponCode: appliedCoupon?.code || codeRaw || null,
    appliedCoupon,
    distanceKm: Number.isFinite(distanceKm) ? Number(distanceKm.toFixed(2)) : null,
    roadDistanceKm: Number.isFinite(distanceKm) ? Number(distanceKm.toFixed(2)) : null,
    straightLineDistanceKm: Number.isFinite(straightLineKm)
      ? Number(straightLineKm.toFixed(2))
      : null,
    deliveryFeeBreakdown: deliveryFeeResult.breakdown || null,
  };

  const pricing = applyDeliveryModePricing(
    basePricing,
    dto.deliveryMode,
    Number(feeSettings.quickDeliveryFee) || 0,
  );

  const priceChanges = (Array.isArray(dto.items) ? dto.items : [])
    .map((rawItem) => {
      const itemId = String(rawItem?.itemId || rawItem?.id || '').trim();
      const resolved = items.find((entry) => String(entry.itemId) === itemId);
      if (!resolved) return null;

      const previousPrice = Number(rawItem?.price);
      const nextPrice = Number(resolved.price);
      if (!Number.isFinite(previousPrice) || previousPrice === nextPrice) return null;

      return {
        itemId,
        name: resolved.name,
        previousPrice,
        price: nextPrice,
      };
    })
    .filter(Boolean);

  return {
    items,
    priceChanges,
    pricing: {
      ...pricing,
      deliveryFeeBreakdown: {
        source: deliveryFeeResult.source,
        distanceKm: Number.isFinite(distanceKm) ? Number(distanceKm.toFixed(2)) : null,
        deliveryFee,
        message: Number.isFinite(distanceKm)
          ? `Distance: ${Number(distanceKm).toFixed(1)} km`
          : null,
      },
    },
  };
}
