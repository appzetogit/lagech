/**
 * Resolve a human-readable customer delivery address from order payload shapes
 * (socket offer, accept response, current-trip sync).
 */
export function resolveCustomerAddress(order) {
  if (!order) return '';

  const saved =
    order.customerAddress ||
    order.customer_address ||
    order.deliveryAddress?.formattedAddress ||
    order.deliveryAddress?.address ||
    '';

  if (String(saved).trim()) return String(saved).trim();

  const deliveryAddress = order.deliveryAddress || {};
  const addressParts = [
    deliveryAddress.street,
    deliveryAddress.additionalDetails,
    deliveryAddress.city,
    deliveryAddress.state,
    deliveryAddress.zipCode,
  ]
    .map((v) => String(v || '').trim())
    .filter(Boolean);

  return addressParts.length ? addressParts.join(', ') : '';
}

/** Open Google Maps with a searchable address (same pattern as restaurant pickup). */
export function openGoogleMapsForAddress(address) {
  const query = String(address || '').trim();
  if (!query) return false;
  window.open(
    `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`,
    '_blank',
  );
  return true;
}

/**
 * Resolve the restaurant pickup address the same way.
 *
 * The list and offer payloads carry the restaurant as a populated relation with
 * the address split across `addressLine1`, `area`, `city` and `pincode` -- there
 * is no single `restaurantAddress` string and no `location.address`. The offer
 * card looked only for those two, so every incoming order told the rider
 * "Address not available" while the address sat in the payload.
 */
export function resolveRestaurantAddress(order) {
  if (!order) return '';

  const restaurant = order.restaurant || order.restaurantId || {};

  const saved =
    order.restaurantAddress ||
    order.restaurant_address ||
    restaurant.formattedAddress ||
    restaurant.address ||
    restaurant.location?.address ||
    order.restaurantLocation?.address ||
    '';

  if (String(saved).trim()) return String(saved).trim();

  const parts = [
    restaurant.addressLine1,
    restaurant.addressLine2,
    restaurant.area,
    restaurant.landmark,
    restaurant.city,
    restaurant.state,
    restaurant.pincode,
  ]
    .map((v) => String(v || '').trim())
    .filter(Boolean);

  return parts.length ? parts.join(', ') : '';
}
