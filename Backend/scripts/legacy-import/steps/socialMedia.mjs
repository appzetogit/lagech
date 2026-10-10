/**
 * Social media links: `social_media` (id, name, link, status) ->
 * food_social_media_links. A link that is not a web address is skipped and
 * listed rather than imported broken.
 */
import { prisma } from '../../../src/config/prisma.js';
import { loadIdMap, recordId } from '../idMap.mjs';

const ENTITY = 'social_media';

const webAddress = (value) => {
    const link = String(value || '').trim();
    if (!link) return '';
    const withScheme = /^https?:\/\//i.test(link) ? link : `https://${link}`;
    try {
        const url = new URL(withScheme);
        return url.hostname.includes('.') ? withScheme : '';
    } catch {
        return '';
    }
};

const platformName = (value) => {
    const name = String(value || '').trim();
    return name ? name.charAt(0).toUpperCase() + name.slice(1) : '';
};

export async function importSocialMedia(mysql, report, ctx = {}) {
    const idMap = await loadIdMap(ENTITY);
    const SQL = 'SELECT * FROM social_media ORDER BY id';
    const [rows] = await mysql.query(SQL);
    const baseline = ctx.sync ? await ctx.baselineRows(SQL) : null;
    for (const [index, row] of rows.entries()) {
        // Sync: the links are the new admin's now; an old-side change is only reported.
        if (ctx.sync && idMap.has(String(row.id))) {
            ctx.leaveAlone(report, ENTITY, row, baseline, ['name', 'link', 'status']);
            continue;
        }
        const platform = platformName(row.name).slice(0, 40);
        const url = webAddress(row.link);
        if (!platform || !url) {
            report.skip(ENTITY, row.id, row.name || '(no name)', !platform ? 'no platform name' : `"${row.link}" is not a web address`);
            continue;
        }
        const data = {
            platform,
            url,
            isActive: Number(row.status) === 1,
            sortOrder: index,
            ...(row.created_at ? { createdAt: row.created_at } : {}),
        };
        const mappedId = idMap.get(String(row.id));
        const exists = mappedId && (await prisma.foodSocialMediaLink.count({ where: { id: mappedId } })) > 0;
        const saved = exists
            ? await prisma.foodSocialMediaLink.update({ where: { id: mappedId }, data, select: { id: true } })
            : await prisma.foodSocialMediaLink.create({ data, select: { id: true } });
        await recordId(ENTITY, row.id, saved.id);
        report.done(ENTITY, exists ? 'updated' : 'created');
    }
}
