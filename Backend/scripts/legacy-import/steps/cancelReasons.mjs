/**
 * Order cancel reasons: `order_cancel_reasons` -> food_cancel_reasons, with the
 * old "user type" mapped to who cancels here.
 */
import { prisma } from '../../../src/config/prisma.js';
import { loadIdMap, recordId } from '../idMap.mjs';

const ENTITY = 'cancel_reason';
const USER_TYPES = { admin: 'admin', customer: 'customer', deliveryman: 'rider', vendor: 'restaurant', store: 'restaurant', restaurant: 'restaurant' };

export async function importCancelReasons(mysql, report, ctx = {}) {
    const idMap = await loadIdMap(ENTITY);
    const SQL = 'SELECT * FROM order_cancel_reasons ORDER BY id';
    const [rows] = await mysql.query(SQL);
    const baseline = ctx.sync ? await ctx.baselineRows(SQL) : null;
    for (const [index, row] of rows.entries()) {
        // Sync: settings-like; the new admin's now. An old-side change is only reported.
        if (ctx.sync && idMap.has(String(row.id))) {
            ctx.leaveAlone(report, ENTITY, row, baseline, ['reason', 'user_type', 'status']);
            continue;
        }
        const userType = USER_TYPES[String(row.user_type || '').toLowerCase()];
        if (!userType) {
            report.skip(ENTITY, row.id, row.reason, `unknown user type "${row.user_type}"`);
            continue;
        }
        const data = {
            reason: String(row.reason || '').trim(),
            userType,
            isActive: row.status === 1,
            sortOrder: index,
            ...(row.created_at ? { createdAt: row.created_at } : {}),
        };
        const mappedId = idMap.get(String(row.id));
        const exists = mappedId && (await prisma.foodCancelReason.count({ where: { id: mappedId } })) > 0;
        const saved = exists
            ? await prisma.foodCancelReason.update({ where: { id: mappedId }, data, select: { id: true } })
            : await prisma.foodCancelReason.create({ data, select: { id: true } });
        await recordId(ENTITY, row.id, saved.id);
        report.done(ENTITY, exists ? 'updated' : 'created');
    }
}
