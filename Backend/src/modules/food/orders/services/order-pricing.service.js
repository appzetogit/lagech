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
import { applyFeeSwitches } from './feeSwitches.js';
import { evaluateCoupon, requiresFirstOrder, USED_ORDER_WHERE } from './couponRules.js';
import { resolveOrderZoneId, getZonePaymentOptions } from '../../shared/zonePayment.js';

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

const FEE_QUERY = {
  orderBy: { createdAt: 'desc' },
  include: { deliveryFeeBands: { orderBy: { minDistanceKm: 'asc' } } },
};

/**
 * Active fee settings, preferring a row scoped to the order's zone.
 *
 * Fees were global: one active row priced every trip in the country. A zone
 * row overrides it, and a zone with no row of its own falls back to the global
 * one -- so adding zone pricing never leaves a zone unpriced, and deployments
 * that never configure a zone keep the exact behaviour they had.
 *
 * The override is per field, not wholesale. A zone row is created the moment an
 * admin saves anything for that zone, and everything they did not fill in is
 * null on it. Taking the row as-is made those nulls read as "not configured",
 * so setting only a platform fee for a zone silently made delivery free there.
 * A blank field means "inherit", which is what the screen says it means.
 *
 * The cost is that a zone cannot switch a fee off that the default has on --
 * blank is inheritance, not zero. Charging nothing by accident is the worse of
 * the two, and a zone that genuinely wants no delivery fee can set it to 0.
 */
export async function loadActiveFeeSettings(zoneId = null) {
  const zoned = isId(zoneId)
    ? await prisma.foodFeeSettings.findFirst({
        where: { isActive: true, zoneId: String(zoneId) },
        ...FEE_QUERY,
      })
    : null;

  const global =
    (await prisma.foodFeeSettings.findFirst({
      where: { isActive: true, zoneId: null },
      ...FEE_QUERY,
    })) ||
    // Deployments that predate zone scoping have a single active row with a
    // null zoneId, which the query above already finds. This last look covers
    // the case where every row happens to be zone-scoped and none matched.
    (await prisma.foodFeeSettings.findFirst({ where: { isActive: true }, ...FEE_QUERY }));

  const feeDoc = zoned || global;
  if (!feeDoc) {
    return { deliveryFee: 0, deliveryFeeRanges: [], platformFee: 0, gstRate: 0, zoneId: null };
  }

  const inherit = (field) =>
    feeDoc[field] === null || feeDoc[field] === undefined ? global?.[field] ?? null : feeDoc[field];

  const ownRanges = toFeeRanges(feeDoc.deliveryFeeBands);
  // No bands of its own means the zone did not override the ladder either.
  const ranges = ownRanges.length > 0 ? ownRanges : toFeeRanges(global?.deliveryFeeBands);

  // Switches resolve per field like the fees do: a zone's unset switch follows
  // the default row. A switched-off charge is priced at 0 here, so every
  // caller -- pricing, the order total, the transaction split -- agrees.
  const switches = applyFeeSwitches(
    {
      gstEnabled: feeDoc.gstEnabled,
      deliveryFeeGstEnabled: feeDoc.deliveryFeeGstEnabled,
      platformFeeEnabled: feeDoc.platformFeeEnabled,
      gstRate: inherit('gstRate'),
      deliveryFeeGstRate: inherit('deliveryFeeGstRate'),
      platformFee: inherit('platformFee'),
    },
    feeDoc === global ? null : global,
  );

  return {
    ...feeDoc,
    ...switches,
    deliveryFee: inherit('deliveryFee'),
    quickDeliveryFee: inherit('quickDeliveryFee'),
    deliveryFeeRanges: ranges,
    /// Which row actually priced this, so callers can report it.
    resolvedFromZone: Boolean(zoned),
  };
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

/**
 * Look a code up and decide whether it applies (see couponRules.js). Loads the
 * two counts the rules need -- the customer's prior orders, for first-order
 * coupons, and their uses of this coupon, for the per-customer limit -- only
 * when the coupon has that rule.
 *
 * Uses are counted from orders (food_orders.couponId), not from a running
 * counter, so a cancelled order or a failed payment gives the use back.
 */
export async function applyCouponCode(code, ctx = {}) {
  const offer = await prisma.foodOffer.findUnique({ where: { couponCode: String(code) } });
  if (!offer) return { ...evaluateCoupon(null, ctx), offer: null };

  const userId = isId(ctx.userId) ? String(ctx.userId) : null;
  let priorOrders = 0;
  let userUses = 0;
  if (userId && requiresFirstOrder(offer)) {
    priorOrders = await prisma.foodOrder.count({ where: { userId, ...USED_ORDER_WHERE } });
  }
  if (userId && Number(offer.perUserLimit) > 0) {
    userUses = await prisma.foodOrder.count({
      where: { userId, couponId: offer.id, ...USED_ORDER_WHERE },
    });
  }

  return { ...evaluateCoupon(offer, { ...ctx, priorOrders, userUses }), offer };
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

  // Zone comes from the restaurant, matching how an order records its zone
  // (order.service.js falls back to restaurant.zoneId), so the quote a
  // customer sees and the price they are charged resolve the same fee row.
  // A restaurant with no zone falls back to the default zone, as createOrder does.
  const pricingZoneId = await resolveOrderZoneId(dto?.zoneId, restaurant);
  const feeSettings = await loadActiveFeeSettings(pricingZoneId);

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
  const originalDeliveryFee = round2(deliveryFeeResult.deliveryFee);
  distanceKm = deliveryFeeResult.distanceKm ?? distanceKm;

  const deliveryFeeGstRate = resolveDeliveryFeeGstRate(feeSettings);
  const originalDeliveryFeeGst = computeDeliveryFeeGst(originalDeliveryFee, deliveryFeeGstRate);

  const codeRaw = dto.couponCode
    ? String(dto.couponCode).trim().toUpperCase()
    : "";
  const coupon = codeRaw
    ? await applyCouponCode(codeRaw, {
        userId,
        restaurantId: dto.restaurantId,
        zoneId: pricingZoneId,
        subtotal,
        deliveryFee: originalDeliveryFee,
        deliveryFeeGst: originalDeliveryFeeGst,
        // A scheduled order is checked against the time it is for.
        now: at > new Date() ? at : new Date(),
      })
    : null;

  const discount = coupon?.ok ? coupon.discount : 0;
  // A free-delivery coupon waives the delivery fee and the GST charged on it.
  // The rider's pay is worked out from the distance bands, not from this fee,
  // so it is unchanged; the platform absorbs the waived amount.
  const deliveryFeeWaived = coupon?.ok ? coupon.deliveryFeeWaived : 0;
  const deliveryFee = deliveryFeeWaived > 0 ? 0 : originalDeliveryFee;
  const deliveryFeeGst = deliveryFeeWaived > 0 ? 0 : originalDeliveryFeeGst;

  const appliedCoupon = coupon?.ok
    ? {
        code: codeRaw,
        discount,
        couponId: coupon.offer.id,
        title: coupon.offer.title || "",
        couponType: coupon.couponType,
        freeDelivery: coupon.couponType === "free_delivery",
        deliveryFeeWaived,
        // What the customer saves in total, whichever way the coupon works.
        savings: round2(discount + deliveryFeeWaived),
      }
    : null;

  // GST is charged on the post-discount item value (discount is already clamped to <= subtotal).
  const gstRate = Number(feeSettings.gstRate || 0);
  const tax =
    Number.isFinite(gstRate) && gstRate > 0
      ? Math.round(Math.max(0, subtotal - discount) * (gstRate / 100))
      : 0;

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
    // Why a code that was sent did not apply, worded for the customer. Null
    // when no code was sent or it applied.
    couponError: coupon && !coupon.ok ? coupon.message : null,
    couponErrorReason: coupon && !coupon.ok ? coupon.reason : null,
    couponId: appliedCoupon?.couponId || null,
    deliveryFeeWaived,
    originalDeliveryFee,
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
    // Which of cash / online the order's zone accepts, so checkout can hide
    // the methods createOrder would refuse.
    paymentOptions: await getZonePaymentOptions(pricingZoneId),
    pricing: {
      ...pricing,
      deliveryFeeBreakdown: {
        source: deliveryFeeResult.source,
        distanceKm: Number.isFinite(distanceKm) ? Number(distanceKm.toFixed(2)) : null,
        deliveryFee,
        originalDeliveryFee,
        deliveryFeeWaived,
        message: Number.isFinite(distanceKm)
          ? `Distance: ${Number(distanceKm).toFixed(1)} km`
          : null,
      },
    },
  };
}
