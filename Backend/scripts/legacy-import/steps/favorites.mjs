/**
 * Customer favourites: `wishlists` -> food_user_favorites. A row names either a
 * store or an item; rows whose customer, restaurant or dish wasn't imported are
 * skipped. The unique (user, type, entity) key makes re-runs a no-op.
 */
import { prisma } from '../../../src/config/prisma.js';
import { loadIdMap } from '../idMap.mjs';

const ENTITY = 'favorite';

export async function importFavorites(mysql, report) {
    const users = await loadIdMap('user');
    const restaurants = await loadIdMap('restaurant');
    const foods = await loadIdMap('food');
    const [rows] = await mysql.query('SELECT id, user_id, store_id, item_id, created_at FROM wishlists ORDER BY id');
    for (const row of rows) {
        const userId = users.get(String(row.user_id));
        const [entityType, entityId] = row.store_id != null
            ? ['restaurant', restaurants.get(String(row.store_id))]
            : ['food', foods.get(String(row.item_id))];
        if (!userId || !entityId) {
            report.skip(ENTITY, row.id, `${entityType} favourite`, !userId ? 'customer not imported' : `${entityType} not imported`);
            continue;
        }
        const key = { userId_entityType_entityId: { userId, entityType, entityId } };
        const exists = (await prisma.foodUserFavorite.count({ where: key.userId_entityType_entityId })) > 0;
        if (!exists) {
            await prisma.foodUserFavorite.create({
                data: { userId, entityType, entityId, ...(row.created_at ? { createdAt: row.created_at } : {}) },
            });
        }
        report.done(ENTITY, exists ? 'updated' : 'created');
    }
}
