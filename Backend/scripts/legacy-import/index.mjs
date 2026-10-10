/**
 * Imports the previous (6amMart, MySQL) system's data into this one.
 *
 * Reads a MySQL database loaded from a BACKUP -- never the live site. The live
 * account has been flagged for database load before, and an import that
 * iterates on it would add exactly that load.
 *
 *   LEGACY_MYSQL_URL=mysql://user:pass@127.0.0.1:3306/legacy_lagech \
 *   DATABASE_URL=postgresql://... UPLOAD_STORAGE_ROOT=/srv/lagech/uploads \
 *   node scripts/legacy-import/index.mjs [--sync] [--dry-run] zones categories ...
 *
 *   --sync     incremental: bring in what the old system added or changed
 *              since the first import, without undoing edits made here (see
 *              sync.mjs for the rules). Needs LEGACY_BASELINE_MYSQL_URL, the
 *              copy the previous import read.
 *   --dry-run  do everything inside one Postgres transaction that is rolled
 *              back, and print what would have happened. Nothing is written.
 *
 * Steps run in dependency order whatever order they are named in. Every row
 * that is skipped or changed on the way in is listed at the end -- nothing is
 * dropped silently.
 *
 * This file only sets up --dry-run before anything touches the database: the
 * dry-run client has to be in place before the first module that imports the
 * Prisma client is loaded. The import itself is run.mjs.
 */
import { register } from 'node:module';

if (process.argv.includes('--dry-run')) {
    register('./dryRun/hooks.mjs', {
        parentURL: import.meta.url,
        data: { shimUrl: new URL('./dryRun/prisma.mjs', import.meta.url).href },
    });
}

await import('./run.mjs');
