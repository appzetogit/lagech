/**
 * Applies prisma/constraints.sql after a migration.
 *
 * Prisma manages tables, columns and the indexes declared in schema.prisma —
 * and treats anything else it finds as drift. Every `prisma migrate dev` that
 * follows therefore emits DROP INDEX for the GIN and GIST indexes here, because
 * it did not create them and cannot see why they exist. Constraints, triggers
 * and exclusion constraints it ignores entirely.
 *
 * So this file is not optional cleanup: without it, one routine schema change
 * silently removes every array and geo index in the database, and the only
 * symptom is queries getting slower.
 *
 * constraints.sql is idempotent (drop-then-add, CREATE INDEX IF NOT EXISTS,
 * CREATE OR REPLACE FUNCTION), so running it repeatedly is safe and is the
 * intended usage. `npm run db:migrate` runs both steps in order.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';

const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(here, 'constraints.sql'), 'utf8');

const prisma = new PrismaClient();

try {
    // One statement at a time: $executeRawUnsafe will not accept a multi-command
    // string, and a per-statement failure names the statement that broke.
    //
    // Splitting on ';' alone is wrong here — the sync_geography() body is
    // dollar-quoted and full of semicolons, so a naive split cuts the function
    // in half and Postgres reports an unterminated dollar-quoted string.
    const statements = [];
    let buffer = '';
    let dollarTag = null;

    for (const line of sql.split('\n')) {
        // A comment line outside a function body carries no SQL.
        if (!dollarTag && /^\s*--/.test(line)) continue;

        buffer += line + '\n';

        for (const match of line.matchAll(/\$[A-Za-z_]*\$/g)) {
            const tag = match[0];
            if (!dollarTag) dollarTag = tag;
            else if (dollarTag === tag) dollarTag = null;
        }

        if (!dollarTag && /;\s*$/.test(line)) {
            const statement = buffer.trim().replace(/;$/, '').trim();
            if (statement) statements.push(statement);
            buffer = '';
        }
    }
    if (buffer.trim()) statements.push(buffer.trim().replace(/;$/, '').trim());

    let applied = 0;
    for (const statement of statements) {
        try {
            await prisma.$executeRawUnsafe(statement);
            applied += 1;
        } catch (err) {
            console.error(`\nFailed:\n${statement}\n\n${err.message}`);
            process.exitCode = 1;
            break;
        }
    }

    if (!process.exitCode) {
        console.log(`constraints.sql applied — ${applied} statements`);
    }
} finally {
    await prisma.$disconnect();
}
