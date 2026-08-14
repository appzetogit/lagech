import { prisma } from '../../../config/prisma.js';

/**
 * Restaurant ids whose cuisine list contains the term, case-insensitively.
 *
 * Prisma can only ask exact questions of a String[] (has / hasSome), and both
 * the search service and the public feed matched a substring, so this stays
 * raw. Shared because two callers needed the identical query.
 *
 * ponytail: ILIKE over unnest cannot use the GIN index on cuisines, so it is a
 * scan. Fine at this catalogue size; a pg_trgm index on
 * array_to_string(cuisines,' ') is the fix if it ever shows up in a slow log.
 */
export const restaurantIdsMatchingCuisine = async (term, limit = 500) => {
    const needle = String(term || '').trim();
    if (!needle) return [];

    const rows = await prisma.$queryRaw`
        SELECT "id" FROM "food_restaurants"
        WHERE EXISTS (
            SELECT 1 FROM unnest("cuisines") AS c WHERE c ILIKE ${`%${needle}%`}
        )
        LIMIT ${limit}
    `;
    return rows.map((row) => row.id);
};

/**
 * Restaurants within `radiusKm` of a point, nearest first, with their distance.
 *
 * Replaces Mongo's $geoNear. `location` is a GIST-indexed geography column kept
 * in step with latitude/longitude by the sync_geography trigger, and is
 * invisible to Prisma Client (Unsupported), so it has to be queried raw.
 *
 * ST_DWithin rather than a computed distance in the WHERE clause: only the
 * former can use the index.
 *
 * @returns {Promise<Array<{id: string, distanceInKm: number}>>}
 */
export const restaurantsNearPoint = async (lat, lng, radiusKm = null, cap = 2000) => {
    const latitude = Number(lat);
    const longitude = Number(lng);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return [];

    // No radius means "rank everything by distance", so the bound is generous
    // rather than absent — an unbounded sort over the whole table is not
    // something a public endpoint should be able to ask for.
    const radiusMeters = radiusKm === null ? 100_000 : Math.max(0.1, Number(radiusKm)) * 1000;

    const rows = await prisma.$queryRaw`
        SELECT "id",
               ROUND((ST_Distance("location", ST_MakePoint(${longitude}, ${latitude})::geography) / 1000)::numeric, 2) AS "distanceInKm"
        FROM "food_restaurants"
        WHERE "status" = 'approved'
          AND "location" IS NOT NULL
          AND ST_DWithin("location", ST_MakePoint(${longitude}, ${latitude})::geography, ${radiusMeters})
        ORDER BY "location" <-> ST_MakePoint(${longitude}, ${latitude})::geography
        LIMIT ${cap}
    `;

    return rows.map((row) => ({ id: row.id, distanceInKm: Number(row.distanceInKm) }));
};
