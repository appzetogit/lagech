/**
 * Display labels for entities the API may return as either a string or a
 * populated relation.
 *
 * Under Mongo, an order's `restaurant` came back as a plain name. The Postgres
 * API returns the relation object instead -- `{ id, restaurantName, area, city,
 * ownerPhone, zoneId }` -- and every place that rendered the field directly
 * started throwing React error #31, "Objects are not valid as a React child".
 * That unmounts the whole tree, so a single order row took down the entire
 * admin panel.
 *
 * Both shapes are handled rather than one being declared correct: responses
 * differ by endpoint, and some still return the string.
 */
export const restaurantLabel = (value, fallback = '') => {
    if (value === null || value === undefined) return fallback;
    if (typeof value === 'string') return value || fallback;
    if (typeof value === 'number') return String(value);
    if (typeof value === 'object') {
        return value.restaurantName || value.name || value.title || fallback;
    }
    return fallback;
};

/** Same problem, same shape, for a populated user relation. */
export const personLabel = (value, fallback = '') => {
    if (value === null || value === undefined) return fallback;
    if (typeof value === 'string') return value || fallback;
    if (typeof value === 'object') {
        return value.name || value.fullName || value.phone || fallback;
    }
    return fallback;
};

/** Zones arrive as `{ id, name, zoneName }` from Postgres, a string from Mongo. */
export const zoneLabel = (value, fallback = '') => {
    if (value === null || value === undefined) return fallback;
    if (typeof value === 'string') return value || fallback;
    if (typeof value === 'object') {
        return value.zoneName || value.name || fallback;
    }
    return fallback;
};
