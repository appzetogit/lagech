/**
 * FAQs: `f_a_q_s` (question, answer, user_type customer / vendor /
 * deliveryman, status) -> food_faqs, in the old order. user_type becomes the
 * audience (customer / restaurant / rider). The old `translations` rows for
 * App\Models\FAQ are English copies of the same text, so they are not read.
 *
 * Sync: an FAQ imported before is the admin's here now; an old-side change is
 * only reported. New old rows are added at the end.
 */
import { prisma } from '../../../src/config/prisma.js';
import { loadIdMap, recordId } from '../idMap.mjs';
import { mapLegacyFaq } from '../settingsMaps.mjs';
import { invalidateFaqCache } from '../../../src/modules/food/admin/services/faq.service.js';

const ENTITY = 'faq';
const SQL = 'SELECT id, question, answer, page_type, user_type, status, created_at FROM f_a_q_s ORDER BY id';

export async function importFaqs(mysql, report, ctx = {}) {
    const idMap = await loadIdMap(ENTITY);
    const [rows] = await mysql.query(SQL);
    const baseline = ctx.sync ? await ctx.baselineRows(SQL) : null;
    const last = await prisma.foodFaq.findFirst({ orderBy: { sortOrder: 'desc' }, select: { sortOrder: true } });
    let next = last ? last.sortOrder + 1 : 0;
    for (const row of rows) {
        const mappedId = idMap.get(String(row.id));
        if (ctx.sync && mappedId) {
            ctx.leaveAlone(report, ENTITY, { ...row, name: row.question }, baseline, ['question', 'answer', 'user_type', 'status']);
            continue;
        }
        const exists = mappedId && (await prisma.foodFaq.count({ where: { id: mappedId } })) > 0;
        const { data, skip } = mapLegacyFaq(row, next);
        if (skip) {
            report.skip(ENTITY, row.id, row.question || '(no question)', skip);
            continue;
        }
        // A re-run keeps the place the FAQ has here.
        if (exists) delete data.sortOrder;
        const saved = exists
            ? await prisma.foodFaq.update({ where: { id: mappedId }, data, select: { id: true } })
            : await prisma.foodFaq.create({ data, select: { id: true } });
        if (!exists) next += 1;
        await recordId(ENTITY, row.id, saved.id);
        report.done(ENTITY, exists ? 'updated' : 'created');
    }
    invalidateFaqCache();
}
