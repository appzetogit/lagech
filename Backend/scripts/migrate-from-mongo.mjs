/**
 * One-off import of the legacy MongoDB export into Postgres.
 *
 *   node scripts/migrate-from-mongo.mjs <export-dir> [--apply]
 *
 * Without --apply it reports what it would do and writes nothing.
 *
 * Two things make this tractable rather than a rewrite. The Postgres schema was
 * translated from these exact Mongoose models, so collection names line up with
 * table names; and ids stayed 24-char hex, so a Mongo ObjectId is already a
 * valid primary key here and needs no remapping.
 *
 * Insert order is derived from the live foreign keys rather than hand-listed.
 * There are 74 of them, and a hand-written order silently rots the first time
 * someone adds a relation.
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { Signer } from '@aws-sdk/rds-signer';
import 'dotenv/config';

const [dir, ...flags] = process.argv.slice(2);
const APPLY = flags.includes('--apply');
if (!dir) {
    console.error('usage: migrate-from-mongo.mjs <export-dir> [--apply]');
    process.exit(1);
}

// Collections whose name does not match its table.
const TABLE_FOR = {
    foodbusinesssettings: 'food_business_settings',
    topbanners: 'top_banners',
    food_user_wallets: 'wallets',
    food_delivery_wallets: 'wallets',
};

// The unified wallets table discriminates by entityType. Mongo kept one
// collection per owner kind, so the value has to be supplied on the way in.
const EXTRA_FIELDS = {
    food_user_wallets: { entityType: 'user' },
    food_delivery_wallets: { entityType: 'deliveryBoy' },
};

// Mongo kept nested subdocuments; the Postgres schema flattened them. These
// reshape a document into the flat column names before the generic insert.
// Only collections that actually need it appear here.
const RESHAPE = {
    food_restaurants: (d) => {
        const loc = d.location || {};
        const c = Array.isArray(loc.coordinates) ? loc.coordinates : [];
        return {
            ...d,
            latitude: loc.latitude ?? c[1],
            longitude: loc.longitude ?? c[0],
            formattedAddress: loc.formattedAddress ?? loc.address,
            addressLine1: loc.addressLine1 ?? loc.formattedAddress,
            addressLine2: loc.addressLine2,
            area: loc.area ?? d.area,
            city: loc.city ?? d.city,
            state: loc.state ?? d.state,
            pincode: loc.pincode ?? d.pincode,
            landmark: loc.landmark,
        };
    },
    // One collection per owner kind in Mongo; one table with a discriminator here.
    food_user_wallets: (d) => ({ ...d, entityId: d.userId }),
    food_delivery_wallets: (d) => ({ ...d, entityId: d.deliveryBoyId ?? d.deliveryPartnerId ?? d.userId }),
    food_delivery_partners: (d) => {
        const loc = d.location || d.lastLocation || {};
        const c = Array.isArray(loc.coordinates) ? loc.coordinates : [];
        return { ...d, lastLat: loc.latitude ?? c[1], lastLng: loc.longitude ?? c[0] };
    },
};

/** Extended JSON ({$oid}, {$date}, {$numberDecimal}) to plain JS. */
const plain = (v) => {
    if (v === null || v === undefined) return v;
    if (Array.isArray(v)) return v.map(plain);
    if (typeof v !== 'object') return v;
    if ('$oid' in v) return v.$oid;
    if ('$date' in v) return new Date(typeof v.$date === 'object' ? Number(v.$date.$numberLong) : v.$date);
    if ('$numberDecimal' in v) return v.$numberDecimal;
    if ('$numberInt' in v) return Number(v.$numberInt);
    if ('$numberLong' in v) return Number(v.$numberLong);
    if ('$binary' in v) return null;
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]));
};

const url = new URL(process.env.DATABASE_URL);
const signer = new Signer({
    region: process.env.AWS_REGION || 'ap-south-1',
    hostname: url.hostname,
    port: Number(url.port) || 5432,
    username: decodeURIComponent(url.username),
});
const pool = new pg.Pool({
    host: url.hostname,
    port: Number(url.port) || 5432,
    database: url.pathname.replace(/^\//, ''),
    user: decodeURIComponent(url.username),
    password: () => signer.getAuthToken(),
    ssl: { rejectUnauthorized: true },
    max: 4,
});

const q = async (sql, params) => (await pool.query(sql, params)).rows;

const columnsFor = async (table) => {
    const rows = await q(
        'select column_name, data_type from information_schema.columns'
        + ' where table_schema = $1 and table_name = $2',
        ['public', table],
    );
    // USER-DEFINED here means the PostGIS geography columns. They are maintained
    // by triggers from the flat latitude/longitude, so writing them directly is
    // both wrong and a parse error -- Mongo held GeoJSON, not WKT.
    return new Map(rows.filter((r) => r.data_type !== 'USER-DEFINED').map((r) => [r.column_name, r]));
};

/** Order tables so a row's parents are always inserted before it. */
const insertOrder = async (tables) => {
    const edges = await q(
        'select distinct tc.table_name as child, ccu.table_name as parent'
        + ' from information_schema.table_constraints tc'
        + ' join information_schema.constraint_column_usage ccu'
        + '   on ccu.constraint_name = tc.constraint_name'
        + " where tc.constraint_type = 'FOREIGN KEY' and tc.table_schema = 'public'",
    );
    const set = new Set(tables);
    const deps = new Map(tables.map((t) => [t, new Set()]));
    for (const { child, parent } of edges) {
        // Self-references order rows within one table, not tables between themselves.
        if (set.has(child) && set.has(parent) && child !== parent) deps.get(child).add(parent);
    }
    const out = [];
    const done = new Set();
    while (out.length < tables.length) {
        const ready = tables.filter((t) => !done.has(t) && [...deps.get(t)].every((d) => done.has(d)));
        if (!ready.length) {
            // A cycle would spin here forever. Emit the remainder and let the
            // foreign key errors name whatever is actually circular.
            for (const t of tables) if (!done.has(t)) { out.push(t); done.add(t); }
            break;
        }
        for (const t of ready) { out.push(t); done.add(t); }
    }
    return out;
};

const coerce = (value, col) => {
    if (value === undefined) return null;
    const v = plain(value);
    if (v === null) return null;
    if (col.data_type === 'ARRAY') return Array.isArray(v) ? v : [v];
    if (col.data_type === 'jsonb' || col.data_type === 'json') return JSON.stringify(v);
    if (typeof v === 'object' && !(v instanceof Date)) return JSON.stringify(v);
    return v;
};

const files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
const byTable = new Map();
for (const f of files) {
    const collection = path.basename(f, '.json');
    const table = TABLE_FOR[collection] || collection;
    const docs = JSON.parse(await readFile(path.join(dir, f), 'utf8'));
    if (!docs.length) continue;
    if (!byTable.has(table)) byTable.set(table, []);
    byTable.get(table).push({ collection, docs });
}

const present = await q(
    'select table_name from information_schema.tables where table_schema = $1', ['public'],
);
const exists = new Set(present.map((r) => r.table_name));
const targets = [...byTable.keys()].filter((t) => exists.has(t));
const skipped = [...byTable.keys()].filter((t) => !exists.has(t));
const order = await insertOrder(targets);

console.log(`  ${files.length} files -> ${targets.length} tables`
    + (skipped.length ? `  (no such table: ${skipped.join(', ')})` : ''));
if (!APPLY) console.log('  DRY RUN - nothing will be written. Pass --apply to commit.');
console.log('');

if (APPLY) {
    const list = [...order].reverse().map((t) => `"${t}"`).join(', ');
    await q(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
    console.log(`  truncated ${order.length} tables`);
    console.log('');
}

let totalIn = 0;
let totalOk = 0;
const failures = [];

for (const table of order) {
    const cols = await columnsFor(table);
    for (const { collection, docs } of byTable.get(table)) {
        const extra = EXTRA_FIELDS[collection] || {};
        let ok = 0;
        let failed = 0;
        let firstError = null;

        for (const raw of docs) {
            const reshape = RESHAPE[collection];
            const doc = { ...(reshape ? reshape(raw) : raw), ...extra };
            if (doc._id !== undefined) { doc.id = doc._id; delete doc._id; }
            delete doc.__v;
            // updatedAt is NOT NULL on most tables and is not always in Mongo.
            if (cols.has('updatedAt') && doc.updatedAt === undefined) doc.updatedAt = doc.createdAt ?? new Date();
            if (cols.has('createdAt') && doc.createdAt === undefined) doc.createdAt = new Date();

            const names = Object.keys(doc).filter((k) => cols.has(k));
            const values = names.map((k) => coerce(doc[k], cols.get(k)));
            const ph = names.map((_, i) => `$${i + 1}`).join(', ');
            const quoted = names.map((n) => `"${n}"`).join(', ');
            const sql = `INSERT INTO "${table}" (${quoted}) VALUES (${ph}) ON CONFLICT DO NOTHING`;

            if (!APPLY) { ok += 1; continue; }
            try {
                await q(sql, values);
                ok += 1;
            } catch (e) {
                failed += 1;
                if (!firstError) firstError = e.message.split('\n')[0].slice(0, 120);
            }
        }

        totalIn += docs.length;
        totalOk += ok;
        const label = collection === table ? table : `${collection} -> ${table}`;
        console.log(`  ${String(ok).padStart(5)}/${String(docs.length).padEnd(5)} ${label}`
            + (failed ? `   ${failed} FAILED` : ''));
        if (firstError) failures.push(`${label}: ${firstError}`);
    }
}

console.log('');
console.log(`  ${totalOk}/${totalIn} rows`);
if (failures.length) {
    console.log('');
    console.log('  first error per table:');
    failures.forEach((f) => console.log(`    ${f}`));
}
await pool.end();
