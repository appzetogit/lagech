/**
 * The import run behind index.mjs: parses the steps and flags, opens the old
 * database copies, runs the steps in order, and prints the summary.
 */
import 'dotenv/config';
import mysql from 'mysql2/promise';
import { prisma } from '../../src/config/prisma.js';
import { ensureIdMap, mappedThisRun } from './idMap.mjs';
import { byId, classifyProtected } from './sync.mjs';
import { printWallets, walletRows, walletsHere, walletsOld } from './wallets.mjs';
import { importZones } from './steps/zones.mjs';
import { importCategories } from './steps/categories.mjs';
import { importRestaurants } from './steps/restaurants.mjs';
import { importFoods } from './steps/foods.mjs';
import { importNutrition } from './steps/nutrition.mjs';
import { importCustomers } from './steps/customers.mjs';
import { importDeliveryPartners } from './steps/deliveryPartners.mjs';
import { importOrders } from './steps/orders.mjs';
import { importBalances } from './steps/balances.mjs';
import { importPaymentDetails } from './steps/paymentDetails.mjs';
import { importSettings } from './steps/settings.mjs';
import { importRatings } from './steps/ratings.mjs';
import { importBanners } from './steps/banners.mjs';
import { importCancelReasons } from './steps/cancelReasons.mjs';
import { importPromotions } from './steps/promotions.mjs';
import { importFavorites } from './steps/favorites.mjs';
import { importNewsletter } from './steps/newsletter.mjs';
import { importWithdrawalMethods } from './steps/withdrawalMethods.mjs';
import { importSocialMedia } from './steps/socialMedia.mjs';
import { importCoupons } from './steps/coupons.mjs';

const STEPS = [
    ['zones', importZones],
    ['categories', importCategories],
    ['restaurants', importRestaurants],
    ['foods', importFoods],
    ['nutrition', importNutrition],
    ['customers', importCustomers],
    ['riders', importDeliveryPartners],
    ['payment-details', importPaymentDetails],
    ['withdrawal-methods', importWithdrawalMethods],
    ['orders', importOrders],
    ['balances', importBalances],
    ['ratings', importRatings],
    ['banners', importBanners],
    ['cancel-reasons', importCancelReasons],
    ['promotions', importPromotions],
    ['coupons', importCoupons],
    ['favorites', importFavorites],
    ['newsletter', importNewsletter],
    ['social-media', importSocialMedia],
    ['settings', importSettings],
];
const FLAGS = new Set(['--sync', '--dry-run']);

/**
 * Outcomes per entity:
 *   created    a new row
 *   updated    an existing row changed
 *   unchanged  nothing to do
 *   protected  the old system changed it, but this system's copy wins (sync)
 *   skipped    not imported, with the reason listed
 */
export const createReport = ({ dryRun = false } = {}) => {
    const counts = {};
    const skipped = [];
    const warnings = [];
    const details = {};
    const bump = (entity, key) => {
        counts[entity] ??= { created: 0, updated: 0, unchanged: 0, protected: 0, skipped: 0 };
        counts[entity][key] += 1;
    };
    const detail = (entity, fields) => {
        details[entity] ??= {};
        for (const field of fields) details[entity][field] = (details[entity][field] || 0) + 1;
    };
    return {
        counts,
        done: (entity, outcome) => bump(entity, outcome),
        detail,
        protect: (entity, legacyId, name, columns) => {
            bump(entity, 'protected');
            detail(entity, columns.map((column) => `${column} (left alone)`));
        },
        skip: (entity, legacyId, name, reason) => {
            bump(entity, 'skipped');
            skipped.push(`${entity} #${legacyId} "${name}": ${reason}`);
        },
        warn: (entity, legacyId, name, message) => warnings.push(`${entity} #${legacyId} "${name}": ${message}`),
        print: () => {
            const w = dryRun ? 'would ' : '';
            console.log(`\n── ${dryRun ? 'DRY RUN (nothing was written) ' : ''}import summary ──`);
            console.log(`${'entity'.padEnd(24)}${[`${w}add`, `${w}update`, 'unchanged', 'left alone*', 'skipped'].map((h) => h.padStart(14)).join('')}`);
            for (const [entity, c] of Object.entries(counts)) {
                console.log(`${entity.padEnd(24)}${[c.created, c.updated, c.unchanged, c.protected, c.skipped].map((n) => String(n).padStart(14)).join('')}`);
            }
            console.log('* left alone: changed in the old system since the last import, kept as this system has it');
            for (const [entity, fields] of Object.entries(details)) {
                console.log(`  ${entity}: ${Object.entries(fields).sort((a, b) => b[1] - a[1]).map(([f, n]) => `${f} ×${n}`).join(', ')}`);
            }
            if (skipped.length) {
                // Grouped by reason, so a thousand rows skipped for one cause read as one line.
                const byReason = new Map();
                for (const line of skipped) {
                    const [, entity, id, reason] = /^(\S+) #(\S+) ".*?": (.*)$/s.exec(line) || [null, '?', '?', line];
                    const key = `${entity}: ${reason.replace(/\d+/g, 'N')}`;
                    byReason.set(key, [...(byReason.get(key) || []), id]);
                }
                console.log(`\nskipped (${skipped.length}), by reason:`);
                for (const [key, ids] of byReason) {
                    console.log(`  ${key} — ${ids.length}: #${ids.slice(0, 12).join(', #')}${ids.length > 12 ? ', …' : ''}`);
                }
            }
            if (warnings.length) console.log(`\nwarnings (${warnings.length}):\n  ${warnings.join('\n  ')}`);
            return skipped.length;
        },
    };
};

const args = process.argv.slice(2);
const flags = new Set(args.filter((arg) => arg.startsWith('--')));
const requested = new Set(args.filter((arg) => !arg.startsWith('--')));
const unknown = [...requested].filter((name) => !STEPS.some(([step]) => step === name));
const unknownFlags = [...flags].filter((flag) => !FLAGS.has(flag));
if (!requested.size || unknown.length || unknownFlags.length) {
    console.error(`Usage: node scripts/legacy-import/index.mjs [--sync] [--dry-run] <${STEPS.map(([s]) => s).join('|')}> ...`);
    if (unknown.length) console.error(`Unknown step(s): ${unknown.join(', ')}`);
    if (unknownFlags.length) console.error(`Unknown flag(s): ${unknownFlags.join(', ')}`);
    process.exit(1);
}
const sync = flags.has('--sync');
const dryRun = flags.has('--dry-run');
if (!process.env.LEGACY_MYSQL_URL) {
    console.error('LEGACY_MYSQL_URL is required (the MySQL database restored from the backup).');
    process.exit(1);
}
if (sync && !process.env.LEGACY_BASELINE_MYSQL_URL) {
    console.error('--sync needs LEGACY_BASELINE_MYSQL_URL: the old-database copy the previous import read, to tell what changed since.');
    process.exit(1);
}

const connect = (uri) => mysql.createConnection({
    uri,
    // Old ids are BIGINT; returned as strings they can never lose precision.
    supportBigNumbers: true,
    bigNumberStrings: true,
    dateStrings: false,
});

const legacy = await connect(process.env.LEGACY_MYSQL_URL);
const baseline = sync ? await connect(process.env.LEGACY_BASELINE_MYSQL_URL) : null;
if (sync) {
    const [[{ source }]] = await legacy.query('SELECT DATABASE() AS source');
    const [[{ base }]] = await baseline.query('SELECT DATABASE() AS base');
    console.log(`sync: source ${source}, baseline ${base}${dryRun ? ' — DRY RUN' : ''}`);
    if (source === base) console.warn('warning: source and baseline are the same database; nothing will read as changed in the old system');
}

const report = createReport({ dryRun });
const affected = { restaurant: new Set(), rider: new Set() };
const ctx = {
    sync,
    dryRun,
    baseline,
    baselineRows: async (sql, params = []) => byId((await baseline.query(sql, params))[0]),
    /** A row of a kind this system owns now: report whether the old system changed it; never write. */
    leaveAlone: (rep, entity, row, baselineById, columns) => {
        const { outcome, columns: changed } = classifyProtected(baselineById.get(String(row.id)), row, columns);
        if (outcome === 'protected') {
            rep.protect(entity, row.id, row.name ?? row.title ?? '', changed);
        } else {
            rep.done(entity, 'unchanged');
            if (changed.length) rep.detail(entity, changed);
        }
    },
    isCreated: (entity, legacyId) => mappedThisRun(entity).has(String(legacyId)),
    affect: (kind, id) => {
        if (id) affected[kind].add(String(id));
    },
    affected: (kind) => affected[kind],
};

async function runSteps() {
    await ensureIdMap();
    const walletsBefore = sync ? await walletsHere() : null;
    for (const [name, run] of STEPS) {
        if (!requested.has(name)) continue;
        console.log(`→ ${name}`);
        await run(legacy, report, ctx);
    }
    if (sync) {
        const rows = walletRows({
            before: walletsBefore,
            after: await walletsHere(),
            oldBase: await walletsOld(baseline),
            oldNow: await walletsOld(legacy),
        });
        printWallets(rows, { dryRun });
    }
}

/** Row counts of every table, and the newest updatedAt where there is one: the dry run's proof of no writes. */
async function snapshot(client) {
    const tables = await client.$queryRaw`
        SELECT table_schema AS schema, table_name AS name,
               EXISTS (SELECT 1 FROM information_schema.columns c
                        WHERE c.table_schema = t.table_schema AND c.table_name = t.table_name AND c.column_name = 'updatedAt') AS stamped
          FROM information_schema.tables t
         WHERE table_type = 'BASE TABLE' AND table_schema IN ('public', 'legacy')
         ORDER BY 1, 2`;
    const out = new Map();
    for (const { schema, name, stamped } of tables) {
        const [row] = await client.$queryRawUnsafe(
            `SELECT COUNT(*)::bigint AS n${stamped ? ', MAX("updatedAt") AS stamp' : ''} FROM "${schema}"."${name}"`,
        );
        out.set(`${schema}.${name}`, `${row.n}${row.stamp ? ` @ ${new Date(row.stamp).toISOString()}` : ''}`);
    }
    return out;
}

class DryRunRollback extends Error {}

try {
    if (dryRun) {
        const { realPrisma, nestable, setActive } = await import('./dryRun/prisma.mjs');
        const before = await snapshot(realPrisma);
        try {
            await realPrisma.$transaction(async (tx) => {
                // Fail fast rather than queue behind the live app's row locks,
                // and never hold anything for long.
                await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '10s'");
                setActive(nestable(tx));
                try {
                    await runSteps();
                } finally {
                    setActive(null);
                }
                throw new DryRunRollback('rolled back');
            }, { timeout: 60 * 60 * 1000, maxWait: 60 * 1000 });
        } catch (error) {
            if (!(error instanceof DryRunRollback) && error?.message !== 'rolled back') throw error;
        }
        const after = await snapshot(realPrisma);
        const moved = [...before].filter(([table, value]) => after.get(table) !== value);
        console.log(`\ndry run rolled back. Tables compared before/after: ${before.size}; differing: ${moved.length}`);
        for (const [table, value] of moved) {
            console.log(`  ${table}: ${value} → ${after.get(table)} (not this run: its writes were rolled back; the live app is writing here)`);
        }
    } else {
        await runSteps();
    }
} finally {
    await legacy.end();
    await baseline?.end();
    await prisma.$disconnect();
}

// Non-zero when anything was skipped, so a scripted run cannot pass unnoticed.
process.exitCode = report.print() > 0 ? 2 : 0;
