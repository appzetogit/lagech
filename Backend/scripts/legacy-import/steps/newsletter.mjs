/**
 * Newsletter subscribers: `newsletters` -> food_newsletter_subscribers.
 * Emails are matched lower-cased, so an address already subscribed here (or
 * listed twice in the old table) is updated rather than duplicated.
 */
import { prisma } from '../../../src/config/prisma.js';
import { normalizeEmail } from '../../../src/modules/food/shared/customerRewards.util.js';
import { loadIdMap, recordId } from '../idMap.mjs';

const ENTITY = 'newsletter';

export async function importNewsletter(mysql, report, ctx = {}) {
    const idMap = await loadIdMap(ENTITY);
    const SQL = 'SELECT id, email, created_at, updated_at FROM newsletters ORDER BY id';
    const [rows] = await mysql.query(SQL);
    const baseline = ctx.sync ? await ctx.baselineRows(SQL) : null;
    for (const row of rows) {
        // Sync: a subscriber imported before may have unsubscribed here; left alone.
        if (ctx.sync && idMap.has(String(row.id))) {
            ctx.leaveAlone(report, ENTITY, row, baseline, ['email']);
            continue;
        }
        const email = normalizeEmail(row.email);
        if (!email) {
            report.skip(ENTITY, row.id, row.email, 'not a valid email address');
            continue;
        }
        const data = {
            email,
            ...(row.created_at ? { createdAt: row.created_at } : {}),
            ...(row.updated_at ? { updatedAt: row.updated_at } : {}),
        };
        const mappedId = idMap.get(String(row.id));
        const existing = (mappedId && (await prisma.foodNewsletterSubscriber.findUnique({ where: { id: mappedId }, select: { id: true } })))
            || (await prisma.foodNewsletterSubscriber.findUnique({ where: { email }, select: { id: true } }));
        const saved = existing
            ? (ctx.sync ? existing : await prisma.foodNewsletterSubscriber.update({ where: { id: existing.id }, data, select: { id: true } }))
            : await prisma.foodNewsletterSubscriber.create({ data, select: { id: true } });
        await recordId(ENTITY, row.id, saved.id);
        report.done(ENTITY, existing ? (ctx.sync ? 'unchanged' : 'updated') : 'created');
    }
}
