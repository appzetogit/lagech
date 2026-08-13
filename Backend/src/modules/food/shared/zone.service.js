import { prisma } from '../../../config/prisma.js';

/**
 * Which service zone a point falls in.
 *
 * This was a JS ray-casting scan: load every active zone, then walk each ring
 * edge by edge in Node. It ran on every restaurant address save and grew
 * linearly with the number of zones, and the ring maths was a copy of an
 * algorithm Postgres already ships.
 *
 * `boundary` is a GIST-indexed polygon maintained by the zone_boundary_sync
 * trigger, so this is one indexed containment test. Raw because Prisma Client
 * cannot select or filter an Unsupported column.
 *
 * `ST_Contains` deliberately, not `ST_Intersects`: a point exactly on a shared
 * edge should belong to one zone, not two. Casting to geometry keeps that strict
 * planar semantic — the geography version measures on the spheroid, which is
 * right for distance and wrong for "is this inside".
 *
 * @returns {Promise<{id: string, name: string, zoneName: string|null} | null>}
 */
export async function findZoneForPoint(latitude, longitude) {
    const lat = Number(latitude);
    const lng = Number(longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

    const rows = await prisma.$queryRaw`
        SELECT "id", "name", "zoneName"
        FROM "food_zones"
        WHERE "isActive" = true
          AND "boundary" IS NOT NULL
          AND ST_Contains(
                "boundary"::geometry,
                ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)
              )
        -- Smallest matching zone wins. Overlapping zones are an admin mistake
        -- rather than something the schema forbids, and picking the tightest one
        -- is both deterministic and the more useful answer.
        ORDER BY ST_Area("boundary"::geometry) ASC
        LIMIT 1
    `;

    return rows[0] || null;
}

/**
 * Every active zone containing the point, tightest first.
 * Useful for surfacing an overlap to an admin rather than silently resolving it.
 */
export async function findZonesForPoint(latitude, longitude) {
    const lat = Number(latitude);
    const lng = Number(longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return [];

    return prisma.$queryRaw`
        SELECT "id", "name", "zoneName"
        FROM "food_zones"
        WHERE "isActive" = true
          AND "boundary" IS NOT NULL
          AND ST_Contains(
                "boundary"::geometry,
                ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)
              )
        ORDER BY ST_Area("boundary"::geometry) ASC
    `;
}

/**
 * Rebuild every zone's boundary from its coordinate ring.
 *
 * The trigger only fires on write, so zones that existed before it did have a
 * NULL boundary and would silently match nothing. Run once after deploying, and
 * any time the ring-building logic changes.
 *
 * @returns {Promise<{ total: number, withBoundary: number }>}
 */
export async function backfillZoneBoundaries() {
    // A no-op update still fires a BEFORE UPDATE OF "coordinates" trigger,
    // because the column is named in the SET clause.
    await prisma.$executeRaw`UPDATE "food_zones" SET "coordinates" = "coordinates"`;

    const [stats] = await prisma.$queryRaw`
        SELECT COUNT(*)::int AS total,
               COUNT("boundary")::int AS "withBoundary"
        FROM "food_zones"
    `;
    return stats;
}
