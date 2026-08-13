import { normalizeRestaurantLocation } from '../shared/geo.utils.js';

/**
 * Translates between the flat `food_restaurants` row and the nested `location`
 * object the rest of the codebase and the clients speak.
 *
 * Mongo stored a 13-field `location` subdocument that duplicated the flat address
 * columns beside it — and kept the two in sync with a 60-line pre('validate')
 * hook, because either could be written independently. Postgres keeps one copy:
 * the address columns are the record, `latitude`/`longitude` are the point, and
 * the PostGIS geography column is derived by a trigger.
 *
 * Callers still read `restaurant.location.city`, `location.formattedAddress` and
 * `location.coordinates`, so the nesting is rebuilt on the way out. This is the
 * same trick order.mapper.js uses, for the same reason.
 */

const str = (v) => (v == null ? '' : String(v));
const finite = (v) => {
    const n = typeof v === 'number' ? v : parseFloat(String(v));
    return Number.isFinite(n) ? n : null;
};

/**
 * Flat row → the nested `location` object, or null when the row carries no
 * address at all (matching the old behaviour, where a restaurant with nothing
 * filled in had no location subdocument rather than an empty one).
 */
export function toRestaurantLocation(row) {
    if (!row) return null;

    const lat = finite(row.latitude);
    const lng = finite(row.longitude);

    const hasAnything =
        lat !== null || lng !== null ||
        row.formattedAddress || row.addressLine1 || row.addressLine2 ||
        row.area || row.city || row.state || row.pincode || row.landmark;

    if (!hasAnything) return null;

    // Run it through the shared normaliser so coordinates/lat/lng agree, exactly
    // as the public restaurant feed already did.
    return normalizeRestaurantLocation({
        type: 'Point',
        coordinates: lat !== null && lng !== null ? [lng, lat] : undefined,
        latitude: lat ?? undefined,
        longitude: lng ?? undefined,
        formattedAddress: str(row.formattedAddress),
        // Mongo carried `address` and `formattedAddress` as separate keys that
        // were always written together; both read from the one column.
        address: str(row.formattedAddress),
        addressLine1: str(row.addressLine1),
        addressLine2: str(row.addressLine2),
        area: str(row.area),
        city: str(row.city),
        state: str(row.state),
        pincode: str(row.pincode),
        landmark: str(row.landmark),
    });
}

/** The proposed location awaiting admin approval, in the same nested shape. */
export function toPendingLocation(row) {
    if (!row) return null;
    const lat = finite(row.pendingLatitude);
    const lng = finite(row.pendingLongitude);
    if (lat === null && lng === null) return null;

    return normalizeRestaurantLocation({
        type: 'Point',
        coordinates: lat !== null && lng !== null ? [lng, lat] : undefined,
        latitude: lat ?? undefined,
        longitude: lng ?? undefined,
    });
}

/**
 * Flat row → the row plus a nested `location` (and `pendingLocation`), which is
 * what every existing consumer expects. The flat columns are left in place, so
 * code that already reads `restaurant.city` keeps working too.
 */
export function toRestaurant(row) {
    if (!row) return row;
    return {
        ...row,
        _id: row.id,
        location: toRestaurantLocation(row),
        pendingLocation: toPendingLocation(row),
    };
}

export const toRestaurants = (rows) => (rows || []).map(toRestaurant);

/**
 * Nested location input → flat Prisma columns.
 *
 * Only keys actually present are emitted, so this suits both create and a
 * partial update. Coordinates win over latitude/longitude when both are given,
 * matching the Mongoose hook's rule that "coordinates are the source of truth".
 */
export function fromRestaurantLocation(loc = {}, { pending = false } = {}) {
    if (!loc || typeof loc !== 'object') return {};

    const data = {};
    const set = (key, value) => {
        if (value !== undefined) data[key] = value;
    };

    const [coordLng, coordLat] = Array.isArray(loc.coordinates) ? loc.coordinates : [];
    const lat = finite(coordLat) ?? finite(loc.latitude ?? loc.lat);
    const lng = finite(coordLng) ?? finite(loc.longitude ?? loc.lng);

    if (pending) {
        set('pendingLatitude', lat);
        set('pendingLongitude', lng);
        return data;
    }

    set('latitude', lat);
    set('longitude', lng);

    const formatted = loc.formattedAddress ?? loc.address;
    if (formatted !== undefined) data.formattedAddress = str(formatted).trim();

    for (const key of ['addressLine1', 'addressLine2', 'area', 'city', 'state', 'pincode', 'landmark']) {
        if (loc[key] !== undefined) data[key] = str(loc[key]).trim();
    }

    return data;
}

/**
 * The derived fields the Mongoose pre('validate') hook maintained.
 *
 * They back the uniqueness constraint on (restaurantNameNormalized,
 * ownerPhoneLast10) and the fast name lookup, so they have to be recomputed on
 * every write that touches the name or phone — which is why this lives beside
 * the mapper rather than inside one caller.
 */
export function deriveRestaurantFields({ restaurantName, ownerPhone, estimatedDeliveryTime } = {}) {
    const data = {};

    if (restaurantName !== undefined) {
        const normalized = str(restaurantName).trim().toLowerCase().replace(/\s+/g, ' ');
        data.restaurantNameNormalized = normalized || null;
    }

    if (ownerPhone !== undefined) {
        // Trimmed to the last 15 digits to guard against country prefixes.
        const digits = str(ownerPhone).replace(/\D/g, '').slice(-15);
        data.ownerPhoneDigits = digits || null;
        data.ownerPhoneLast10 = digits ? digits.slice(-10) : null;
    }

    // Derive the numeric delivery time from the human string ("25-30 mins",
    // "30 mins", "45") so it can be filtered and sorted on.
    if (estimatedDeliveryTime !== undefined) {
        const match = str(estimatedDeliveryTime).match(/(\d{1,3})/);
        const minutes = match ? parseInt(match[1], 10) : NaN;
        if (Number.isFinite(minutes)) data.estimatedDeliveryTimeMinutes = minutes;
    }

    return data;
}
