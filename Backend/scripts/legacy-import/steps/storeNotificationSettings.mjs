/**
 * Restaurants' Notification Setup: `store_notification_settings` (store_id,
 * key, mail_status, sms_status, push_notification_status: active / inactive /
 * disable) -> food_restaurant_notification_settings, one row per restaurant
 * and event. Run after `restaurants` (store ids go through legacy.id_map).
 *
 * A row already here is the restaurant's own choice and is never overwritten,
 * on a first import or a sync -- except on --sync when it still holds exactly
 * what the old system had at the last import (the baseline copy), in which
 * case the old-side change follows. Which channels an event offers is this
 * system's: an old status for a channel not offered here becomes 'disable'.
 */
import { prisma } from '../../../src/config/prisma.js';
import { loadIdMap } from '../idMap.mjs';
import { decideStoreNotificationRow, mapStoreNotificationRow } from '../settingsMaps.mjs';
import { invalidateRestaurantNotificationSettings } from '../../../src/core/notifications/restaurantNotificationSettings.js';

const ENTITY = 'store_notification_setting';
const SQL = 'SELECT id, store_id, `key`, mail_status, sms_status, push_notification_status FROM store_notification_settings ORDER BY id';

export async function importStoreNotificationSettings(mysql, report, ctx = {}) {
    const restaurants = await loadIdMap('restaurant');
    const [rows] = await mysql.query(SQL);
    const baseline = ctx.sync ? await ctx.baselineRows(SQL) : null;
    const existing = await prisma.foodRestaurantNotificationSetting.findMany({
        where: { restaurantId: { in: [...new Set(restaurants.values())] } },
        select: { id: true, restaurantId: true, key: true, mailStatus: true, smsStatus: true, pushStatus: true },
    });
    const here = new Map(existing.map((row) => [`${row.restaurantId}:${row.key}`, row]));

    const toCreate = [];
    for (const row of rows) {
        const { data, skip } = mapStoreNotificationRow(row, restaurants);
        if (skip) {
            report.skip(ENTITY, row.id, row.key || '', skip);
            continue;
        }
        const id = `${data.restaurantId}:${data.key}`;
        const current = here.get(id);
        const base = baseline?.get(String(row.id));
        const baselineWanted = base ? mapStoreNotificationRow(base, restaurants).data : null;
        const outcome = decideStoreNotificationRow(data, current, baselineWanted);
        if (outcome === 'create') {
            toCreate.push(data);
            // Two old rows for one restaurant and event: the first wins.
            here.set(id, data);
            report.done(ENTITY, 'created');
        } else if (outcome === 'update') {
            await prisma.foodRestaurantNotificationSetting.update({
                where: { id: current.id },
                data: { mailStatus: data.mailStatus, smsStatus: data.smsStatus, pushStatus: data.pushStatus },
            });
            report.done(ENTITY, 'updated');
        } else if (outcome === 'protected') {
            report.protect(ENTITY, row.id, data.key, ['statuses (set by the restaurant here)']);
        } else {
            report.done(ENTITY, 'unchanged');
        }
    }
    for (let i = 0; i < toCreate.length; i += 500) {
        await prisma.foodRestaurantNotificationSetting.createMany({ data: toCreate.slice(i, i + 500), skipDuplicates: true });
    }
    invalidateRestaurantNotificationSettings();
}
