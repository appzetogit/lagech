/**
 * Customer favourites: `wishlists` -> food_user_favorites. A row names either a
 * store or an item; rows whose customer, restaurant or dish wasn't imported are
 * skipped. The unique (user, type, entity) key makes re-runs a no-op.
 */
import { prisma } from '../../../src/config/prisma.js';
import { loadIdMap } from '../idMap.mjs';

const ENTITY = 'favorite';

export async function importFavorites(mysql, report, ctx = {}) {
    const users = await loadIdMap('user');
    const restaurants = await loadIdMap('restaurant');
    const foods = await loadIdMap('food');
    const SQL = 'SELECT id, user_id, store_id, item_id, created_at FROM wishlists ORDER BY id';
    const [rows] = await mysql.query(SQL);
    // Favourites keep no id map. A sync takes only those added in the old
    // system since the baseline copy: one imported before and removed by the
    // customer here must not come back.
    const baseline = ctx.sync ? await ctx.baselineRows(SQL) : null;
    for (const row of rows) {
        if (ctx.sync && baseline.has(String(row.id))) {
            report.done(ENTITY, 'unchanged');
            continue;
        }
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
        // Nothing is written for a favourite that is already there.
        report.done(ENTITY, exists ? 'unchanged' : 'created');
    }
}
