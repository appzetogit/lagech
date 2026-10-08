/**
 * The rider's heading on the live map, per order.
 *
 * The delivery app pings `update-location` every ~10 s and often has no
 * heading (no GPS course while standing still, or simply not sent). Treating a
 * missing heading as 0 snapped the customer's bike icon to face north on every
 * such ping. Instead the last heading the rider did send is kept per order and
 * reused until a new one arrives.
 *
 * Kept in process memory (the socket handler is the only writer) with Redis as
 * a backup, so a reconnect landing on another process, or a restart, still
 * finds it. Entries expire after a quiet spell, since an order's tracking ends.
 */

const REDIS_HASH = 'order:heading:hot';
const TTL_MS = 6 * 60 * 60 * 1000;
const MAX_ENTRIES = 20000;

/**
 * A usable heading in [0, 360), or null when there is none. Missing, blank,
 * non-numeric and negative values (iOS reports -1 for "unknown") are none.
 * Pure.
 */
export function normalizeHeading(raw) {
    if (raw === undefined || raw === null) return null;
    if (typeof raw === 'string' && raw.trim() === '') return null;
    if (typeof raw === 'boolean') return null;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) return null;
    return value % 360;
}

/**
 * The heading store. `createHeadingStore()` gives an isolated one (tests);
 * the socket handler uses the shared default below.
 */
export function createHeadingStore({ now = () => Date.now(), ttlMs = TTL_MS, maxEntries = MAX_ENTRIES } = {}) {
    const entries = new Map();

    const prune = () => {
        const cutoff = now() - ttlMs;
        for (const [key, entry] of entries) {
            if (entry.at < cutoff) entries.delete(key);
        }
        // Still too many: drop the oldest (Map keeps insertion order).
        while (entries.size > maxEntries) {
            entries.delete(entries.keys().next().value);
        }
    };

    const get = (orderId) => {
        const entry = entries.get(String(orderId));
        if (!entry) return null;
        if (entry.at < now() - ttlMs) {
            entries.delete(String(orderId));
            return null;
        }
        return entry.heading;
    };

    const set = (orderId, heading) => {
        const key = String(orderId);
        entries.delete(key); // re-insert so it counts as newest
        entries.set(key, { heading, at: now() });
        if (entries.size > maxEntries) prune();
    };

    /**
     * The heading to broadcast for this ping, and whether the rider sent it.
     * A valid heading is remembered; a missing one falls back to the last one
     * remembered for the order (memory, then `redis` if given), else 0.
     */
    const resolve = async (orderId, rawHeading, { redis = null } = {}) => {
        const key = String(orderId);
        const fresh = normalizeHeading(rawHeading);
        if (fresh !== null) {
            set(key, fresh);
            if (redis) {
                try {
                    await redis.hSet(REDIS_HASH, key, String(fresh));
                } catch {
                    // Memory still has it; Redis is only the backup.
                }
            }
            return { heading: fresh, headingFromDevice: true };
        }

        let last = get(key);
        if (last === null && redis) {
            try {
                last = normalizeHeading(await redis.hGet(REDIS_HASH, key));
                if (last !== null) set(key, last);
            } catch {
                last = null;
            }
        }
        return { heading: last ?? 0, headingFromDevice: false };
    };

    return { resolve, get, set, prune, size: () => entries.size };
}

export const riderHeadings = createHeadingStore();
