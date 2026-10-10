/**
 * Incremental sync: the rules for bringing a newer copy of the old database
 * into a system that has been in use since the first import.
 *
 * Three sources meet here:
 *
 *   - the BASELINE: the old-database copy the first import read
 *     (LEGACY_BASELINE_MYSQL_URL). What a row looked like when it came across.
 *   - the SOURCE: the newer copy being synced (LEGACY_MYSQL_URL).
 *   - what is HERE now, possibly edited in the new admin since.
 *
 * Comparing baseline with source says whether the old system changed a row;
 * comparing what is here with what the baseline row mapped to says whether
 * this system changed it. The rules per kind of data:
 *
 *   - new rows (not in legacy.id_map): imported as the full import would.
 *   - orders: the status, payment, cancellation, rider, rating and ledger
 *     fields follow the old system when it changed them; nothing else moves.
 *   - customers and riders: blanks are filled; nothing set here is
 *     overwritten. Active/blocked/approval status follows the old system only
 *     while this system still holds the value originally imported.
 *   - restaurants, categories, dishes, zones, coupons, banners, settings,
 *     social media, withdrawal methods: never modified. Old-side changes are
 *     counted and reported as left alone.
 *   - money: only ledger rows (by legacy id) that are new since the last
 *     import; opening-balance adjustments are never recomputed.
 *
 * The functions here are pure, so the rules can be tested without a database.
 */

/** A comparable form of a value: Prisma Decimal, Date, Buffer, JSON, '' vs null. */
export const comparable = (value) => {
    if (value === null || value === undefined || value === '') return '';
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : `d:${value.getTime()}`;
    if (typeof value === 'object' && typeof value.toFixed === 'function' && typeof value.isZero === 'function') {
        return `n:${Number(value.toString())}`;
    }
    if (typeof value === 'number') return `n:${value}`;
    if (typeof value === 'boolean') return `b:${value}`;
    if (Buffer.isBuffer(value)) return `x:${value.toString('hex')}`;
    if (typeof value === 'object') return `j:${stableJson(value)}`;
    // Numeric strings ("10.00" from MySQL DECIMAL) compare as numbers; "0123"
    // stays a string.
    const text = String(value);
    if (/^-?(0|[1-9]\d*)(\.\d+)?$/.test(text.trim())) return `n:${Number(text)}`;
    return `s:${text}`;
};

/** JSON with object keys sorted at every level, so key order never reads as a change. */
const stableJson = (value) => {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
    if (value && typeof value === 'object' && !(value instanceof Date)) {
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value ?? null);
};

export const same = (a, b) => comparable(a) === comparable(b);

/** Which of `columns` differ between two rows (either may be missing). */
export const changedColumns = (before, after, columns) => columns.filter((column) => !same(before?.[column], after?.[column]));

/** A value that counts as "not filled in". */
export const isBlank = (value) => value === null || value === undefined
    || (typeof value === 'string' && value.trim() === '')
    || (Array.isArray(value) && value.length === 0)
    || (typeof value === 'object' && !(value instanceof Date) && !Array.isArray(value)
        && typeof value.toFixed !== 'function' && Object.keys(value).length === 0);

/**
 * Customers and riders, step one: the wanted values that would only fill a
 * blank here. Anything already set here is kept, whatever the old system says.
 *
 * @returns {{ patch: object, kept: string[] }} kept: fields the old value
 *   differs from but was not written because this system has its own.
 */
export function fillBlanks(current, wanted, fields = Object.keys(wanted)) {
    const patch = {};
    const kept = [];
    for (const field of fields) {
        const value = wanted[field];
        if (isBlank(value) || same(current?.[field], value)) continue;
        if (isBlank(current?.[field])) patch[field] = value;
        else kept.push(field);
    }
    return { patch, kept };
}

/**
 * Customers and riders, step two: a status follows the old system only while
 * this system still holds exactly what was originally imported. Once an admin
 * here blocked, unblocked or re-approved someone, that decision stands.
 *
 * @param current   the field values here now
 * @param original  what the baseline row mapped to (what was imported)
 * @param target    what the newer row maps to
 * @param fields    the fields that make up the status, compared together
 * @returns {{ patch: object, protected: boolean }}
 */
export function guardedUpdate(current, original, target, fields) {
    const differs = fields.some((field) => !same(current?.[field], target?.[field]));
    if (!differs) return { patch: {}, protected: false };
    if (!original) return { patch: {}, protected: true };
    const untouchedHere = fields.every((field) => same(current?.[field], original[field]));
    if (!untouchedHere) return { patch: {}, protected: true };
    // Only the fields that make up the status, and only those that move.
    const patch = {};
    for (const field of fields) {
        if (!same(current?.[field], target[field])) patch[field] = target[field];
    }
    return { patch, protected: false };
}

/**
 * Orders: the fields the old system changed (baseline mapping vs newer
 * mapping), written where they differ from what is here. Fields the old system
 * did not change are left alone, even if they differ here.
 *
 * @returns {{ patch: object, legacyChanged: string[], conflicts: string[] }}
 *   conflicts: fields this system had also changed (here != originally
 *   imported); the old system's value is still taken, and they are listed.
 */
export function legacyChangedPatch(current, original, target, fields) {
    const legacyChanged = original
        ? fields.filter((field) => !same(original[field], target[field]))
        : [];
    const patch = {};
    const conflicts = [];
    for (const field of legacyChanged) {
        if (same(current?.[field], target[field])) continue;
        patch[field] = target[field];
        if (!same(current?.[field], original[field])) conflicts.push(field);
    }
    return { patch, legacyChanged, conflicts };
}

/** A list of child rows (history, item ratings) in a form that compares by content. */
export const signatureOf = (rows, fields) => JSON.stringify(
    (rows || []).map((row) => fields.map((field) => comparable(row[field]))).sort(),
);

/**
 * How an already-imported row of a protected kind (restaurant, dish, zone...)
 * is reported: unchanged, or changed in the old system and left alone.
 */
export function classifyProtected(baselineRow, sourceRow, columns) {
    // Mapped but not in the baseline: brought in by an earlier sync from a
    // newer copy (or the baseline is not the copy the import read). There is
    // nothing to compare with; it is left as it is, and counted.
    if (!baselineRow) return { outcome: 'unchanged', columns: [NOT_IN_BASELINE] };
    const columnsChanged = changedColumns(baselineRow, sourceRow, columns);
    return columnsChanged.length ? { outcome: 'protected', columns: columnsChanged } : { outcome: 'unchanged', columns: [] };
}

export const NOT_IN_BASELINE = '(imported before, not in the baseline copy: nothing to compare)';

/** Index rows by a key (default id) as strings. */
export const byId = (rows, key = 'id') => new Map((rows || []).map((row) => [String(row[key]), row]));
