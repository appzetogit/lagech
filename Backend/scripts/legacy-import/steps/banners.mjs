/**
 * Home banners: `banners` (food module) -> food_hero_banners, the carousel at
 * the top of the customer app.
 *
 * A "store_wise" banner promoted one restaurant, and tapping it opened that
 * restaurant; here that is the banner's linked restaurant. A banner's own link
 * (several pointed at Instagram pages) becomes its tap-through link. Switched-off
 * banners come across switched off, newest first as the old app showed them.
 */
import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '../../../src/config/prisma.js';
import { config } from '../../../src/config/env.js';
import { buildPublicUrl } from '../../../src/services/storage.service.js';
import { loadIdMap, recordId } from '../idMap.mjs';

const ENTITY = 'banner';
const IMAGE_DIR = 'legacy/banner';

export async function importBanners(mysql, report) {
    const idMap = await loadIdMap(ENTITY);
    const restaurants = await loadIdMap('restaurant');
    const [[foodModule]] = await mysql.query(
        "SELECT id FROM modules WHERE module_type = 'food' ORDER BY status DESC, id LIMIT 1",
    );
    const [rows] = await mysql.query('SELECT * FROM banners WHERE module_id = ? ORDER BY id DESC', [foodModule.id]);

    for (const [index, row] of rows.entries()) {
        const file = String(row.image || '').trim();
        if (!file || !fs.existsSync(path.join(config.uploadStorageRoot || 'uploads', IMAGE_DIR, file))) {
            report.skip(ENTITY, row.id, row.title, `image ${file || '(none)'} not found in the copied storage`);
            continue;
        }

        const linked = row.type === 'store_wise' ? restaurants.get(String(row.data)) : null;
        if (row.type === 'store_wise' && !linked) {
            report.warn(ENTITY, row.id, row.title, `restaurant ${row.data} was not imported; banner kept without a link to it`);
        }
        const title = String(row.title || '').trim();

        const data = {
            imageUrl: buildPublicUrl(`${IMAGE_DIR}/${file}`),
            publicId: '',
            // "1", "2" and "3" were placeholders typed into the old form.
            title: /^\d+$/.test(title) ? null : title || null,
            ctaLink: String(row.default_link || '').trim() || null,
            linkedRestaurantIds: linked ? [linked] : [],
            sortOrder: index,
            isActive: row.status === 1,
            ...(row.created_at ? { createdAt: row.created_at } : {}),
        };

        const mappedId = idMap.get(String(row.id));
        const exists = mappedId && (await prisma.foodHeroBanner.count({ where: { id: mappedId } })) > 0;
        const banner = exists
            ? await prisma.foodHeroBanner.update({ where: { id: mappedId }, data, select: { id: true } })
            : await prisma.foodHeroBanner.create({ data, select: { id: true } });
        await recordId(ENTITY, row.id, banner.id);
        report.done(ENTITY, exists ? 'updated' : 'created');
    }
}
