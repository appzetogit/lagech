/**
 * Creates a migration by diffing the migration history against schema.prisma.
 *
 * NOT `prisma migrate dev`. That compares against the *live* database, which
 * carries everything constraints.sql adds — GIN and GIST indexes Prisma did not
 * create. It reads those as drift and either demands a full reset or emits DROP
 * INDEX for all of them. Diffing history against the schema sees only the real
 * change.
 *
 *   npm run db:migration:new -- add_something
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const name = process.argv[2];
if (!name) {
    console.error('Usage: npm run db:migration:new -- <migration_name>');
    process.exit(1);
}

const url = process.env.DATABASE_URL;
if (!url) {
    console.error('DATABASE_URL is required.');
    process.exit(1);
}
// The shadow database is scratch space for replaying history; it is created and
// dropped by Prisma, and must not be the working database.
const shadowUrl = process.env.SHADOW_DATABASE_URL || url.replace(/\/([^/?]+)(\?|$)/, '/$1_shadow$2');

// Diff FIRST. --from-migrations replays every directory under migrations/, so
// creating the new one up front makes Prisma try to replay an empty folder and
// fail with P3015.
const sql = execFileSync('npx', [
    'prisma', 'migrate', 'diff',
    '--from-migrations', './prisma/migrations',
    '--to-schema-datamodel', './prisma/schema.prisma',
    '--shadow-database-url', shadowUrl,
    '--script',
], { encoding: 'utf8', shell: true });

const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
const dir = join('prisma', 'migrations', `${stamp}_${name}`);
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'migration.sql'), sql);

const real = sql.split('\n').filter((l) => l.trim() && !l.startsWith('--')).length;
console.log(`${dir}/migration.sql  (${real} statements)`);
console.log('Review it, then: npm run db:migrate');
