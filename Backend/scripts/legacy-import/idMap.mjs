/**
 * Old id -> new id, for everything the import has written.
 *
 * The previous system numbered rows; this one uses 24-char hex ids. Every later
 * step needs to turn an old foreign key (an order's user_id, a food's store_id)
 * into the new row, and every re-run needs to know a row already exists so it
 * updates rather than duplicates.
 *
 * Kept in its own `legacy` schema: Prisma only manages `public`, so this table
 * never shows up as drift, and dropping the schema removes every trace of the
 * import once it is no longer needed.
 */
import { prisma } from '../../src/config/prisma.js';

export const ensureIdMap = async () => {
    await prisma.$executeRawUnsafe('CREATE SCHEMA IF NOT EXISTS legacy');
    await prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS legacy.id_map (
            entity     TEXT        NOT NULL,
            legacy_id  BIGINT      NOT NULL,
            new_id     VARCHAR(24) NOT NULL,
            mapped_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (entity, legacy_id)
        )
    `);
};

/** @returns {Promise<Map<string, string>>} legacy id (as string) -> new id */
export const loadIdMap = async (entity) => {
    const rows = await prisma.$queryRaw`
        SELECT legacy_id::text AS legacy_id, new_id FROM legacy.id_map WHERE entity = ${entity}
    `;
    return new Map(rows.map((row) => [row.legacy_id, row.new_id]));
};

/** entity -> legacy id -> new id, for rows this run mapped for the first time. */
const firstMapped = new Map();

export const recordId = async (entity, legacyId, newId) => {
    const [row] = await prisma.$queryRaw`
        INSERT INTO legacy.id_map (entity, legacy_id, new_id)
        VALUES (${entity}, ${BigInt(legacyId)}, ${newId})
        ON CONFLICT (entity, legacy_id) DO UPDATE SET new_id = EXCLUDED.new_id, mapped_at = now()
        RETURNING (xmax = 0) AS inserted
    `;
    if (row?.inserted) {
        if (!firstMapped.has(entity)) firstMapped.set(entity, new Map());
        firstMapped.get(entity).set(String(legacyId), newId);
    }
};

/**
 * Rows this run brought in for the first time (created, or linked to an
 * account that already existed here), by entity. A sync uses it to tell what
 * is new: those rows get the full import treatment in later steps.
 *
 * @returns {Map<string, string>} legacy id -> new id
 */
export const mappedThisRun = (entity) => firstMapped.get(entity) || new Map();
