/**
 * Fills in pictures that were missing when a row was imported: dishes,
 * restaurant logos and covers, categories and rider photos whose old image
 * file was not in the copied storage yet. Run after the missing files have
 * been copied under UPLOAD_STORAGE_ROOT/legacy/...
 *
 * Only ever fills a blank: a picture set here (by a restaurant or an admin)
 * is never replaced.
 *
 *   LEGACY_MYSQL_URL=... UPLOAD_STORAGE_ROOT=/srv/lagech/uploads UPLOAD_BASE_URL=/uploads \
 *   node scripts/legacy-import/fillImages.mjs [--dry-run]
 */
import fs from 'node:fs';
import path from 'node:path';
import mysql from 'mysql2/promise';
import { prisma } from '../../src/config/prisma.js';
import { config } from '../../src/config/env.js';
import { buildPublicUrl } from '../../src/services/storage.service.js';
import { loadIdMap } from './idMap.mjs';

const dryRun = process.argv.includes('--dry-run');
const legacy = await mysql.createConnection({ uri: process.env.LEGACY_MYSQL_URL, supportBigNumbers: true, bigNumberStrings: true });

const urlFor = (dir, file) => {
    const name = String(file || '').trim();
    if (!name || name === 'def.png') return '';
    return fs.existsSync(path.join(config.uploadStorageRoot || 'uploads', 'legacy', dir, name))
        ? buildPublicUrl(`legacy/${dir}/${name}`)
        : '';
};
const parseJson = (raw) => {
    try { return JSON.parse(raw || '[]') || []; } catch { return []; }
};
const blank = (value) => !value || (Array.isArray(value) && value.length === 0);
const counts = {};
const count = (what) => { counts[what] = (counts[what] || 0) + 1; };

async function fill(entity, sql, model, build) {
    const ids = await loadIdMap(entity);
    const [rows] = await legacy.query(sql);
    for (const row of rows) {
        const id = ids.get(String(row.id));
        if (!id) continue;
        const current = await prisma[model].findUnique({ where: { id } });
        if (!current) continue;
        const patch = {};
        for (const [field, value] of Object.entries(build(row))) {
            if (!blank(value) && blank(current[field])) patch[field] = value;
        }
        if (!Object.keys(patch).length) continue;
        Object.keys(patch).forEach((field) => count(`${entity}.${field}`));
        if (!dryRun) await prisma[model].update({ where: { id }, data: patch });
    }
}

await fill('food', 'SELECT id, image, images FROM items', 'foodItem', (row) => ({
    image: urlFor('product', row.image),
    images: parseJson(row.images).map((entry) => urlFor('product', entry?.img)).filter(Boolean),
}));
await fill('restaurant', 'SELECT id, logo, cover_photo FROM stores', 'foodRestaurant', (row) => {
    const cover = urlFor('store/cover', row.cover_photo);
    return { profileImage: urlFor('store', row.logo), coverImage: cover, coverImages: cover ? [cover] : [] };
});
await fill('category', 'SELECT id, image FROM categories', 'foodCategory', (row) => ({
    image: urlFor('category', row.image),
}));
await fill('delivery_partner', 'SELECT id, image FROM delivery_men', 'foodDeliveryPartner', (row) => ({
    profilePhoto: urlFor('delivery-man', row.image),
}));

console.log(`${dryRun ? 'DRY RUN — would fill' : 'filled'}:`, counts);
await legacy.end();
await prisma.$disconnect();
