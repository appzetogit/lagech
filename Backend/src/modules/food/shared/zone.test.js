import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../config/prisma.js';
import { findZoneForPoint, findZonesForPoint, backfillZoneBoundaries } from './zone.service.js';

/**
 * Zone matching moved from a JS ray-casting scan to a GIST-indexed ST_Contains,
 * with the polygon derived from the coordinate ring by a trigger. The trigger
 * and the spatial query are the things under test, so these need a real
 * Postgres — a mock would be testing nothing but itself.
 */
/** A rectangle, given as the ring the admin UI sends: unclosed, lat/lng objects. */
const rect = (minLat, minLng, maxLat, maxLng) => [
    { latitude: minLat, longitude: minLng },
    { latitude: minLat, longitude: maxLng },
    { latitude: maxLat, longitude: maxLng },
    { latitude: maxLat, longitude: minLng },
];

const created = [];

const makeZone = async (name, coordinates, isActive = true) => {
    const zone = await prisma.foodZone.create({ data: { name, country: 'India', coordinates, isActive } });
    created.push(zone.id);
    return zone;
};

test.after(async () => {
    await prisma.foodZone.deleteMany({ where: { id: { in: created } } });
    await prisma.$disconnect();
});

test('an unclosed ring still becomes a valid polygon', async () => {
    // The admin UI never repeats the first point; the trigger has to close it.
    const zone = await makeZone('Test Outer', rect(22.70, 75.83, 22.76, 75.90));

    const [row] = await prisma.$queryRaw`
        SELECT ST_GeometryType(boundary::geometry) AS kind,
               ST_IsClosed(ST_ExteriorRing(boundary::geometry)) AS closed,
               ST_IsValid(boundary::geometry) AS valid
        FROM "food_zones" WHERE id = ${zone.id}
    `;
    assert.equal(row.kind, 'ST_Polygon');
    assert.equal(row.closed, true);
    assert.equal(row.valid, true);
});

test('a point inside resolves to its zone', async () => {
    const match = await findZoneForPoint(22.72, 75.85);
    assert.ok(match, 'expected a zone match');
    assert.equal(match.name, 'Test Outer');
});

test('a point outside every zone resolves to nothing', async () => {
    assert.equal(await findZoneForPoint(23.50, 80.00), null);
});

test('an inactive zone never matches', async () => {
    const zone = await makeZone('Test Inactive', rect(10.0, 10.0, 11.0, 11.0), false);
    assert.equal(await findZoneForPoint(10.5, 10.5), null);

    await prisma.foodZone.update({ where: { id: zone.id }, data: { isActive: true } });
    assert.equal((await findZoneForPoint(10.5, 10.5))?.name, 'Test Inactive');
});

test('the tightest zone wins when zones overlap', async () => {
    // Overlap is an admin mistake rather than something the schema forbids, so
    // the resolution has to be deterministic instead of whichever row came back
    // first — which is exactly what the old array scan did.
    await makeZone('Test Inner', rect(22.71, 75.84, 22.73, 75.86));

    const all = await findZonesForPoint(22.72, 75.85);
    assert.equal(all.length, 2);
    assert.equal(all[0].name, 'Test Inner', 'smallest zone should sort first');
    assert.equal((await findZoneForPoint(22.72, 75.85)).name, 'Test Inner');
});

test('a ring with fewer than 3 points is refused outright', async () => {
    // zone_polygon_min_points catches this before the trigger runs, which is the
    // stronger outcome: the admin is told, rather than getting a saved zone that
    // silently matches nothing.
    await assert.rejects(
        () => makeZone('Test TooFewPoints', [
            { latitude: 1, longitude: 1 },
            { latitude: 2, longitude: 2 },
        ]),
        /zone_polygon_min_points/,
    );
});

test('a ring with unusable coordinates yields no boundary, and does not throw', async () => {
    // Three entries satisfies the CHECK, so this reaches the trigger. Missing
    // lat/lng collapses the line — it must fail closed (no boundary, matches
    // nothing) rather than error the write or store a broken geometry.
    const zone = await makeZone('Test Malformed', [
        { latitude: null, longitude: null },
        { latitude: null, longitude: null },
        { latitude: null, longitude: null },
    ]);

    const [row] = await prisma.$queryRaw`
        SELECT boundary IS NULL AS "isNull" FROM "food_zones" WHERE id = ${zone.id}
    `;
    assert.equal(row.isNull, true);
});

test('editing the ring re-derives the boundary', async () => {
    const zone = await makeZone('Test Moving', rect(30.0, 30.0, 31.0, 31.0));
    assert.equal((await findZoneForPoint(30.5, 30.5))?.name, 'Test Moving');

    await prisma.foodZone.update({
        where: { id: zone.id },
        data: { coordinates: rect(40.0, 40.0, 41.0, 41.0) },
    });

    assert.equal(await findZoneForPoint(30.5, 30.5), null, 'old area should no longer match');
    assert.equal((await findZoneForPoint(40.5, 40.5))?.name, 'Test Moving');
});

test('backfill rebuilds boundaries for rows written before the trigger', async () => {
    const zone = await makeZone('Test Backfill', rect(50.0, 50.0, 51.0, 51.0));
    // Simulate a pre-trigger row.
    await prisma.$executeRaw`UPDATE "food_zones" SET boundary = NULL WHERE id = ${zone.id}`;
    assert.equal(await findZoneForPoint(50.5, 50.5), null);

    const stats = await backfillZoneBoundaries();
    assert.ok(stats.total >= 1);
    assert.equal((await findZoneForPoint(50.5, 50.5))?.name, 'Test Backfill');
});
