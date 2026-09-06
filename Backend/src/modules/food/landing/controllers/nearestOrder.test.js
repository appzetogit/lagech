import test from 'node:test';
import assert from 'node:assert/strict';

import { haversineKm } from '../../shared/geo.utils.js';

/**
 * The `nearest` ordering for the Recommended For You rail.
 *
 * Mirrors byDistanceFrom in publicLanding.controller.js. Kept pure here so the
 * comparator can be checked without a database -- a comparator that returns
 * NaN does not merely mis-sort, it leaves the array in an arbitrary order, and
 * that is exactly what a restaurant with no coordinates would cause.
 */
const byDistanceFrom = (lat, lng) => (a, b) => {
    const d = (r) =>
        Number.isFinite(r?.latitude) && Number.isFinite(r?.longitude)
            ? haversineKm(lat, lng, r.latitude, r.longitude)
            : Number.MAX_SAFE_INTEGER;
    return d(a) - d(b);
};

// Indore, roughly. Distances below are real enough to order correctly.
const HERE = { lat: 22.7196, lng: 75.8577 };

const near = { id: 'near', latitude: 22.7200, longitude: 75.8580 };   // ~50 m
const mid = { id: 'mid', latitude: 22.7500, longitude: 75.9000 };     // ~6 km
const far = { id: 'far', latitude: 23.2599, longitude: 77.4126 };     // ~180 km (Bhopal)

const names = (rows) => rows.map((r) => r.id);

test('closest first', () => {
    const rows = [far, near, mid];
    assert.deepEqual(names(rows.sort(byDistanceFrom(HERE.lat, HERE.lng))), ['near', 'mid', 'far']);
});

test('a restaurant with no coordinates sorts last, not first', () => {
    // The trap: null coordinates through haversine give NaN, and a comparator
    // returning NaN leaves the whole array in an arbitrary order -- so the
    // unplaceable one must be given a real, large distance instead.
    const unplaceable = { id: 'unplaceable', latitude: null, longitude: null };
    const rows = [unplaceable, far, near];

    assert.deepEqual(
        names(rows.sort(byDistanceFrom(HERE.lat, HERE.lng))),
        ['near', 'far', 'unplaceable'],
    );
});

test('the comparator never returns NaN', () => {
    const broken = [
        { id: 'a', latitude: null, longitude: null },
        { id: 'b', latitude: undefined, longitude: undefined },
        { id: 'c', latitude: 'nonsense', longitude: 'nonsense' },
        { id: 'd', latitude: 22.7, longitude: 75.8 },
    ];
    const cmp = byDistanceFrom(HERE.lat, HERE.lng);

    for (const a of broken) {
        for (const b of broken) {
            assert.ok(Number.isFinite(cmp(a, b)), `NaN comparing ${a.id} and ${b.id}`);
        }
    }
});

test('several unplaceable restaurants keep a stable relative order', () => {
    // They all score the same, so the sort must not scramble them.
    const rows = [
        { id: 'x', latitude: null, longitude: null },
        { id: 'y', latitude: null, longitude: null },
        { id: 'z', latitude: null, longitude: null },
    ];
    assert.deepEqual(names(rows.sort(byDistanceFrom(HERE.lat, HERE.lng))), ['x', 'y', 'z']);
});

test('a single restaurant is unchanged', () => {
    assert.deepEqual(names([near].sort(byDistanceFrom(HERE.lat, HERE.lng))), ['near']);
});

test('longitude of zero is a real coordinate, not a missing one', () => {
    // 0 is falsy; a truthiness check here would treat the prime meridian as
    // "no coordinates" and sort it to the bottom.
    const atMeridian = { id: 'meridian', latitude: 0, longitude: 0 };
    const cmp = byDistanceFrom(HERE.lat, HERE.lng);

    assert.ok(cmp(atMeridian, { id: 'none', latitude: null, longitude: null }) < 0);
});
