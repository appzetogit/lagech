/**
 * Order push messages: the old panel's Business Settings -> Notification
 * texts (`notification_messages`, food module: key, message, status) -> the
 * push_messages settings document (Business Settings -> Push Notification).
 *
 * Only messages nobody has edited here are filled; on --sync a message that
 * still holds exactly what the last import wrote follows the old system's
 * change, and anything edited here is left alone (mergeLegacyPushMessages).
 * When the old database has no food rows, the older business_settings copies
 * of the same keys ({"status":1,"message":"..."}) are used instead.
 */
import { prisma } from '../../../src/config/prisma.js';
import {
    AREA,
    LEGACY_PUSH_MESSAGE_KEYS,
    mergeLegacyPushMessages,
    invalidatePushMessages,
} from '../../../src/core/notifications/pushMessages.js';
import { rowsFromBusinessSettings } from '../settingsMaps.mjs';

const ENTITY = 'push_messages';
const KEYS = Object.keys(LEGACY_PUSH_MESSAGE_KEYS);

const MESSAGES_SQL = "SELECT id, `key`, message, status FROM notification_messages WHERE module_type = 'food' ORDER BY id";
// Only the message keys: business_settings also holds credentials, never read here.
const SETTINGS_SQL = `SELECT id, \`key\`, value FROM business_settings WHERE \`key\` IN (${KEYS.map(() => '?').join(', ')}) ORDER BY id`;

async function readRows(mysql) {
    const [rows] = await mysql.query(MESSAGES_SQL);
    if (rows.length) return rows;
    const [settings] = await mysql.query(SETTINGS_SQL, KEYS);
    return rowsFromBusinessSettings(settings);
}

export async function importNotificationMessages(mysql, report, ctx = {}) {
    const rows = await readRows(mysql);
    const baselineRows = ctx.sync ? await readRows(ctx.baseline) : null;
    const stored = await prisma.foodSystemSetting.findUnique({ where: { key: AREA } });
    const { value, outcomes } = mergeLegacyPushMessages(stored?.value || {}, rows, { baselineRows });

    for (const { legacyKey, key, outcome, reason } of outcomes) {
        if (outcome === 'skipped') report.skip(ENTITY, legacyKey, legacyKey, reason);
        else if (outcome === 'protected') report.protect(ENTITY, legacyKey, key, ['message (edited here)']);
        else report.done(ENTITY, outcome);
    }
    if (!outcomes.some((o) => o.outcome === 'created' || o.outcome === 'updated')) return;
    await prisma.foodSystemSetting.upsert({
        where: { key: AREA },
        create: { key: AREA, value },
        update: { value },
    });
    invalidatePushMessages();
}
