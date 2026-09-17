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

export const recordId = (entity, legacyId, newId) => prisma.$executeRaw`
    INSERT INTO legacy.id_map (entity, legacy_id, new_id)
    VALUES (${entity}, ${BigInt(legacyId)}, ${newId})
    ON CONFLICT (entity, legacy_id) DO UPDATE SET new_id = EXCLUDED.new_id, mapped_at = now()
`;
