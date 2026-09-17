/**
 * Categories and sub-categories: `categories` -> food_categories.
 *
 * Written through createCategory/updateCategory, so imported rows pass the same
 * rules as ones created in the admin panel -- including the sub-category ones:
 * a parent must be approved, global and top-level.
 *
 * Only the food module. The old system was multi-module, and the module that
 * carried the business is looked up by type rather than assumed to be id 2; the
 * rest (a switched-off demo grocery module) is left behind.
 */
import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '../../../src/config/prisma.js';
import { config } from '../../../src/config/env.js';
import { buildPublicUrl } from '../../../src/services/storage.service.js';
import { createCategory, updateCategory } from '../../../src/modules/food/admin/services/adminCategory.service.js';
import { loadIdMap, recordId } from '../idMap.mjs';

const ENTITY = 'category';

/** Where the copied legacy images live, relative to the upload root. */
const IMAGE_DIR = 'legacy/category';

/**
 * The image URL, or '' when there is none.
 *
 * 'def.png' is the old system's placeholder, not an upload. A file missing from
 * the copied storage is reported rather than linked: a URL that 404s would look
 * like a working image right up until someone opens the page.
 */
const imageFor = (file, report, row) => {
    const name = String(file || '').trim();
    if (!name || name === 'def.png') return '';
    const onDisk = path.join(config.uploadStorageRoot || 'uploads', IMAGE_DIR, name);
    if (!fs.existsSync(onDisk)) {
        report.warn(ENTITY, row.id, row.name, `image ${name} not found at ${onDisk}; imported without it`);
        return '';
    }
    return buildPublicUrl(`${IMAGE_DIR}/${name}`);
};

export async function importCategories(mysql, report) {
    const [[foodModule]] = await mysql.query(
        "SELECT id FROM modules WHERE module_type = 'food' ORDER BY status DESC, id LIMIT 1"
    );
    if (!foodModule) throw new Error('No food module in the legacy database');

    // Parents before children: a sub-category's parent must already exist.
    const [rows] = await mysql.query(
        'SELECT id, name, image, parent_id, position, status, priority, featured, created_at FROM categories WHERE module_id = ? ORDER BY position, id',
        [foodModule.id]
    );
    const idMap = await loadIdMap(ENTITY);

    for (const row of rows) {
        const isSub = row.position > 0;
        if (row.position > 1) {
            report.skip(ENTITY, row.id, row.name, 'third-level category; the new tree is one level');
            continue;
        }

        let parentId = null;
        if (isSub) {
            parentId = idMap.get(String(row.parent_id));
            if (!parentId) {
                report.skip(ENTITY, row.id, row.name, `parent ${row.parent_id} was not imported`);
                continue;
            }
        }

        const body = {
            name: String(row.name).trim(),
            image: imageFor(row.image, report, row),
            // The old categories carried no diet scope, so none is invented.
            foodTypeScope: 'Both',
            isActive: row.status === 1,
            sortOrder: Number(row.priority) || 0,
            zoneId: 'global',
            parentId,
        };

        const existingId = idMap.get(String(row.id));
        const exists = existingId
            && (await prisma.foodCategory.count({ where: { id: existingId } })) > 0;

        let category;
        try {
            category = exists ? await updateCategory(existingId, body) : await createCategory(body);
        } catch (error) {
            report.skip(ENTITY, row.id, row.name, error.message);
            continue;
        }

        if (row.created_at) {
            await prisma.foodCategory.update({ where: { id: category.id }, data: { createdAt: row.created_at } });
        }
        if (row.featured === 1) {
            report.warn(ENTITY, row.id, row.name, "was 'featured'; the new system has no featured flag");
        }

        await recordId(ENTITY, row.id, category.id);
        idMap.set(String(row.id), category.id);
        report.done(ENTITY, exists ? 'updated' : 'created');
    }
}
