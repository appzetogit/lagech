/**
 * Nutrition facts and allergens on dishes.
 *
 * The old system kept both as free-text tags shared between dishes:
 * `nutritions(id, nutrition)` joined to items through `item_nutrition`, and
 * `allergies(id, allergy)` through `item_allergy`. Each dish gets its own
 * list here (food_items.nutrition / allergens), tidied the way the admin form
 * tidies them. Allergens are imported only when the backup has those tables.
 *
 * Runs after `foods`: dishes are found through the id map that step wrote. A
 * dish's list is replaced, not appended to, so a re-run gives the same result.
 */
import { prisma } from '../../../src/config/prisma.js';
import { loadIdMap, mappedThisRun } from '../idMap.mjs';
import { normalizeFacts } from '../../../src/modules/food/shared/nutrition.util.js';

const ENTITY = 'nutrition';

const tableExists = async (mysql, table) => {
    const [rows] = await mysql.query(
        'SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?',
        [table],
    );
    return Number(rows[0]?.n) > 0;
};

/** item id (string) -> raw labels, from a tag table and its join table. */
const loadTags = async (mysql, { tags, join, label, key }) => {
    if (!(await tableExists(mysql, tags)) || !(await tableExists(mysql, join))) return null;
    const [rows] = await mysql.query(
        `SELECT j.item_id, t.\`${label}\` AS label FROM \`${join}\` j JOIN \`${tags}\` t ON t.id = j.\`${key}\` ORDER BY j.item_id, t.id`,
    );
    const byItem = new Map();
    for (const row of rows) {
        const id = String(row.item_id);
        byItem.set(id, [...(byItem.get(id) || []), row.label]);
    }
    return byItem;
};

export async function importNutrition(mysql, report, ctx = {}) {
    const foodMap = await loadIdMap('food');
    if (!foodMap.size) {
        report.warn(ENTITY, '-', '(all)', 'no dishes have been imported yet; run the foods step first');
        return;
    }

    const nutrition = await loadTags(mysql, { tags: 'nutritions', join: 'item_nutrition', label: 'nutrition', key: 'nutrition_id' });
    const allergens = await loadTags(mysql, { tags: 'allergies', join: 'item_allergy', label: 'allergy', key: 'allergy_id' });
    if (!nutrition) report.warn(ENTITY, '-', '(all)', 'the backup has no nutritions/item_nutrition tables; nutrition not imported');
    if (!allergens) report.warn(ENTITY, '-', '(all)', 'the backup has no allergies/item_allergy tables; allergens not imported');

    // Sync: nutrition belongs to the dish, and dishes imported before are the
    // new admin's; only dishes this run brought in get theirs.
    const newDishes = ctx.sync ? mappedThisRun('food') : null;
    const baseline = ctx.sync
        ? {
            nutrition: await loadTags(ctx.baseline, { tags: 'nutritions', join: 'item_nutrition', label: 'nutrition', key: 'nutrition_id' }),
            allergens: await loadTags(ctx.baseline, { tags: 'allergies', join: 'item_allergy', label: 'allergy', key: 'allergy_id' }),
        }
        : null;

    const itemIds = new Set([...(nutrition?.keys() || []), ...(allergens?.keys() || [])]);
    for (const legacyId of itemIds) {
        if (ctx.sync && !newDishes.has(legacyId)) {
            if (!foodMap.has(legacyId)) continue;
            const was = JSON.stringify([baseline.nutrition?.get(legacyId) || [], baseline.allergens?.get(legacyId) || []]);
            const now = JSON.stringify([nutrition?.get(legacyId) || [], allergens?.get(legacyId) || []]);
            report.done(ENTITY, was === now ? 'unchanged' : 'protected');
            continue;
        }
        const foodId = foodMap.get(legacyId);
        if (!foodId) {
            report.skip(ENTITY, legacyId, `item ${legacyId}`, 'dish was not imported (see the foods step)');
            continue;
        }
        const data = {};
        if (nutrition) data.nutrition = normalizeFacts(nutrition.get(legacyId) || []);
        if (allergens) data.allergens = normalizeFacts(allergens.get(legacyId) || []);
        const { count } = await prisma.foodItem.updateMany({ where: { id: foodId }, data });
        if (!count) {
            report.skip(ENTITY, legacyId, `item ${legacyId}`, 'dish no longer exists here');
            continue;
        }
        report.done(ENTITY, 'updated');
    }

    report.warn(ENTITY, '-', '(all)',
        `nutrition on ${nutrition?.size ?? 0} old dish(es), allergens on ${allergens?.size ?? 0}`);
}
