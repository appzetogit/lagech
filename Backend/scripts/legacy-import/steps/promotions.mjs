/**
 * Advertisements and reels: `advertisements` -> food_advertisements,
 * `reels` -> food_reels, with their images and videos.
 *
 * The old ad types map as store_promotion -> a restaurant card, and
 * video_promotion -> a video. An ad or reel whose media is missing from the
 * copied storage is skipped: without it there is nothing to show.
 */
import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '../../../src/config/prisma.js';
import { config } from '../../../src/config/env.js';
import { buildPublicUrl } from '../../../src/services/storage.service.js';
import { loadIdMap, recordId } from '../idMap.mjs';

const root = () => config.uploadStorageRoot || 'uploads';
const media = (dir, file) => {
    const name = String(file || '').trim();
    if (!name) return '';
    return fs.existsSync(path.join(root(), dir, name)) ? buildPublicUrl(`${dir}/${name}`) : null;
};
const STATUS = { pending: 'pending', approved: 'approved', running: 'approved', paused: 'paused', denied: 'denied', expired: 'approved' };

async function upsert(entity, legacyId, map, delegate, data, report) {
    const mappedId = map.get(String(legacyId));
    const exists = mappedId && (await delegate.count({ where: { id: mappedId } })) > 0;
    const row = exists
        ? await delegate.update({ where: { id: mappedId }, data, select: { id: true } })
        : await delegate.create({ data, select: { id: true } });
    await recordId(entity, legacyId, row.id);
    report.done(entity, exists ? 'updated' : 'created');
}

export async function importPromotions(mysql, report) {
    const restaurants = await loadIdMap('restaurant');
    const adMap = await loadIdMap('advertisement');
    const reelMap = await loadIdMap('reel');
    const [[foodModule]] = await mysql.query("SELECT id FROM modules WHERE module_type = 'food' ORDER BY status DESC, id LIMIT 1");

    const [ads] = await mysql.query('SELECT * FROM advertisements WHERE module_id = ? ORDER BY id', [foodModule.id]);
    for (const row of ads) {
        const restaurantId = restaurants.get(String(row.store_id));
        if (!restaurantId) {
            report.skip('advertisement', row.id, row.title, `restaurant ${row.store_id} not imported`);
            continue;
        }
        const type = row.add_type === 'video_promotion' ? 'video' : 'restaurant';
        const videoUrl = media('legacy/advertisement', row.video_attachment);
        const coverImage = media('legacy/advertisement', row.cover_image);
        const logoImage = media('legacy/advertisement', row.profile_image);
        if ((type === 'video' && !videoUrl) || (type === 'restaurant' && !coverImage)) {
            report.skip('advertisement', row.id, row.title, 'its media is not in the copied storage');
            continue;
        }
        const denied = row.status === 'denied';
        await upsert('advertisement', row.id, adMap, prisma.foodAdvertisement, {
            restaurantId,
            type,
            title: String(row.title || '').trim() || 'Advertisement',
            description: String(row.description || '').trim(),
            videoUrl: videoUrl || '',
            coverImage: coverImage || '',
            logoImage: logoImage || '',
            startDate: new Date(row.start_date),
            endDate: new Date(new Date(row.end_date).setHours(23, 59, 59, 999)),
            priority: row.priority ?? null,
            showRating: row.is_rating_active === 1,
            showReviews: row.is_review_active === 1,
            status: STATUS[row.status] || 'pending',
            note: String((denied ? row.cancellation_note : row.pause_note) || '').trim(),
            createdBy: /Admin/i.test(row.created_by_type || '') ? 'admin' : 'restaurant',
            ...(row.created_at ? { createdAt: row.created_at } : {}),
        }, report);
    }

    const [reels] = await mysql.query('SELECT * FROM reels WHERE module_id = ? ORDER BY id', [foodModule.id]);
    for (const row of reels) {
        const restaurantId = restaurants.get(String(row.store_id));
        const videoUrl = media('legacy/reels', row.video);
        if (!restaurantId || !videoUrl) {
            report.skip('reel', row.id, row.description, restaurantId ? 'its video is not in the copied storage' : `restaurant ${row.store_id} not imported`);
            continue;
        }
        await upsert('reel', row.id, reelMap, prisma.foodReel, {
            restaurantId,
            description: String(row.description || '').trim(),
            videoUrl,
            thumbnail: media('legacy/reels', row.thumbnail) || '',
            alwaysVisible: row.is_always_visible === 1,
            startDate: row.start_date || null,
            endDate: row.end_date || null,
            isActive: row.status === 1,
            views: Number(row.total_views) || 0,
            likes: Number(row.total_likes) || 0,
            restaurantVisits: Number(row.total_store_visits) || 0,
            ...(row.created_at ? { createdAt: row.created_at } : {}),
        }, report);
    }
}
