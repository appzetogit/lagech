import { config } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import { AREA_KEYS, getArea, resolveEffective, storeKey } from './thirdParty.catalog.js';

/**
 * What the running server uses for each third-party area: the admin's saved
 * value where there is one, otherwise the environment (config/env.js).
 *
 * Stored documents are cached per process for CACHE_MS. A save invalidates the
 * cache of the process that handled it; other processes (PM2 cluster, workers)
 * pick it up when their copy expires. A database error keeps the last good
 * copy, or the environment when there is none, so a settings read can never
 * take payments or logins down.
 *
 * Effective values contain secrets in the clear. They stay in memory and are
 * handed only to the code that calls the provider: never log them, never put
 * them in a response.
 */

export const CACHE_MS = 30_000;

const docs = new Map(); // area -> { doc, at }
const inflight = new Map(); // area -> Promise
let loadedOnce = false;

// Tests run without warming, and must not leave a database query behind them
// that keeps the process alive; the server warms at boot (warmThirdPartySettings).
const autoLoad = () => !process.env.NODE_TEST_CONTEXT;

async function loadDoc(area) {
    const { prisma } = await import('../../config/prisma.js');
    const row = await prisma.foodSystemSetting.findUnique({ where: { key: storeKey(area) } });
    return row?.value || null;
}

function refresh(area) {
    if (inflight.has(area)) return inflight.get(area);
    const promise = loadDoc(area)
        .then((doc) => {
            docs.set(area, { doc, at: Date.now() });
            loadedOnce = true;
            return doc;
        })
        .catch((error) => {
            logger.warn(`Third-party settings "${area}" not read, using the last known values: ${error?.message || error}`);
            const previous = docs.get(area);
            // Retry after a short pause rather than on every call.
            docs.set(area, { doc: previous?.doc ?? null, at: Date.now() - CACHE_MS + 5_000 });
            return previous?.doc ?? null;
        })
        .finally(() => inflight.delete(area));
    inflight.set(area, promise);
    return promise;
}

const isFresh = (entry) => entry && Date.now() - entry.at < CACHE_MS;

/** Effective settings for an area, reading the database when the copy is old. */
export async function getThirdPartySettings(area) {
    getArea(area);
    const entry = docs.get(area);
    const doc = isFresh(entry) ? entry.doc : await refresh(area);
    return resolveEffective(area, doc, config).values;
}

/**
 * The same, synchronously, for callers that cannot wait (the Razorpay helper's
 * sync API). Uses the cached copy, or the environment before the first load,
 * and refreshes in the background when the copy is old.
 */
export function getThirdPartySettingsSync(area) {
    getArea(area);
    const entry = docs.get(area);
    if (!isFresh(entry) && (entry || loadedOnce || autoLoad())) refresh(area);
    return resolveEffective(area, entry?.doc ?? null, config).values;
}

/** Drops the cached copy so the next read sees a save. */
export function invalidateThirdPartySettings(area) {
    if (area) docs.delete(area);
    else docs.clear();
}

/** Loads every area. Called at server start so the first payment already sees saved keys. */
export async function warmThirdPartySettings() {
    await Promise.all(AREA_KEYS.map((area) => refresh(area)));
}

/** Puts a document straight into the cache (after a save, and in tests). */
export function primeThirdPartySettings(area, doc) {
    getArea(area);
    docs.set(area, { doc, at: Date.now() });
    loadedOnce = true;
}
