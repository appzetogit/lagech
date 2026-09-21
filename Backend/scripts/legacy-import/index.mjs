/**
 * Imports the previous (6amMart, MySQL) system's data into this one.
 *
 * Reads a MySQL database loaded from a BACKUP -- never the live site. The live
 * account has been flagged for database load before, and an import that
 * iterates on it would add exactly that load.
 *
 *   LEGACY_MYSQL_URL=mysql://user:pass@127.0.0.1:3306/legacy_lagech \
 *   DATABASE_URL=postgresql://... UPLOAD_STORAGE_ROOT=/srv/lagech/uploads \
 *   node scripts/legacy-import/index.mjs zones categories
 *
 * Steps run in dependency order whatever order they are named in. Re-running is
 * safe: rows already imported are updated through legacy.id_map, not duplicated.
 * Every row that is skipped or changed on the way in is listed at the end --
 * nothing is dropped silently.
 */
import 'dotenv/config';
import mysql from 'mysql2/promise';
import { prisma } from '../../src/config/prisma.js';
import { ensureIdMap } from './idMap.mjs';
import { importZones } from './steps/zones.mjs';
import { importCategories } from './steps/categories.mjs';
import { importRestaurants } from './steps/restaurants.mjs';
import { importFoods } from './steps/foods.mjs';
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

const STEPS = [
    ['zones', importZones],
    ['categories', importCategories],
    ['restaurants', importRestaurants],
    ['foods', importFoods],
    ['customers', importCustomers],
    ['riders', importDeliveryPartners],
    ['payment-details', importPaymentDetails],
    ['orders', importOrders],
    ['balances', importBalances],
    ['ratings', importRatings],
    ['banners', importBanners],
    ['cancel-reasons', importCancelReasons],
    ['promotions', importPromotions],
    ['favorites', importFavorites],
    ['settings', importSettings],
];

const createReport = () => {
    const counts = {};
    const skipped = [];
    const warnings = [];
    const bump = (entity, key) => {
        counts[entity] ??= { created: 0, updated: 0, skipped: 0 };
        counts[entity][key] += 1;
    };
    return {
        done: (entity, outcome) => bump(entity, outcome),
        skip: (entity, legacyId, name, reason) => {
            bump(entity, 'skipped');
            skipped.push(`${entity} #${legacyId} "${name}": ${reason}`);
        },
        warn: (entity, legacyId, name, message) => warnings.push(`${entity} #${legacyId} "${name}": ${message}`),
        print: () => {
            console.log('\n── import summary ──');
            for (const [entity, c] of Object.entries(counts)) {
                console.log(`${entity.padEnd(12)} created ${c.created}  updated ${c.updated}  skipped ${c.skipped}`);
            }
            if (skipped.length) console.log(`\nskipped (${skipped.length}):\n  ${skipped.join('\n  ')}`);
            if (warnings.length) console.log(`\nwarnings (${warnings.length}):\n  ${warnings.join('\n  ')}`);
            return skipped.length;
        },
    };
};

const requested = new Set(process.argv.slice(2));
const unknown = [...requested].filter((name) => !STEPS.some(([step]) => step === name));
if (!requested.size || unknown.length) {
    console.error(`Usage: node scripts/legacy-import/index.mjs <${STEPS.map(([s]) => s).join('|')}> ...`);
    if (unknown.length) console.error(`Unknown step(s): ${unknown.join(', ')}`);
    process.exit(1);
}
if (!process.env.LEGACY_MYSQL_URL) {
    console.error('LEGACY_MYSQL_URL is required (the MySQL database restored from the backup).');
    process.exit(1);
}

const legacy = await mysql.createConnection({
    uri: process.env.LEGACY_MYSQL_URL,
    // Old ids are BIGINT; returned as strings they can never lose precision.
    supportBigNumbers: true,
    bigNumberStrings: true,
    dateStrings: false,
});

const report = createReport();
try {
    await ensureIdMap();
    for (const [name, run] of STEPS) {
        if (!requested.has(name)) continue;
        console.log(`→ ${name}`);
        await run(legacy, report);
    }
} finally {
    await legacy.end();
    await prisma.$disconnect();
}

// Non-zero when anything was skipped, so a scripted run cannot pass unnoticed.
process.exitCode = report.print() > 0 ? 2 : 0;
