/**
 * Non-overlapping map patches, one per test file.
 *
 * `findZoneForPoint` searches every active zone in the database, so it cannot be
 * scoped to the rows one test created. When two files both put a zone over
 * Indore — which four of them did — whichever runs second sees the other's zone
 * and either counts one too many or resolves a point to the wrong zone. The
 * runner executes files concurrently, so it failed perhaps one run in three.
 *
 * Each caller passes a distinct index and gets a 1° square nobody else uses.
 * Latitudes stay inside ±80 so the projection stays sane; the strip is empty
 * ocean, which is fine — PostGIS does not care.
 */
export const testPatch = (index) => {
    const lat = 30 + index;
    const lng = 60 + index;
    return {
        /** The unclosed lat/lng ring the admin UI sends. */
        ring: [
            { latitude: lat, longitude: lng },
            { latitude: lat, longitude: lng + 1 },
            { latitude: lat + 1, longitude: lng + 1 },
            { latitude: lat + 1, longitude: lng },
        ],
        /** A point comfortably inside the ring. */
        lat: lat + 0.5,
        lng: lng + 0.5,
    };
};
