import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { ValidationError } from '../../../../core/auth/errors.js';
import { MAX_SHEET_ROWS, missingHeaders, readSheet, writeSheet } from '../../shared/sheet.util.js';
import {
    ADDON_COLUMNS,
    ADDON_NOTES,
    CATEGORY_COLUMNS,
    CATEGORY_NOTES,
    RESTAURANT_COLUMNS,
    RESTAURANT_EXPORT_COLUMNS,
    RESTAURANT_NOTES,
    addonExportRow,
    categoryExportRow,
    phoneKey,
    restaurantExportRow,
    validateAddonRow,
    validateCategoryRow,
    validateRestaurantRow,
} from './bulkRows.js';
import { createCategory, updateCategory } from './adminCategory.service.js';
import { createRestaurantByAdmin } from './adminRestaurantWrite.service.js';
import { findZoneForPoint } from '../../shared/zone.service.js';

/**
 * Bulk import and export of categories, add-ons and restaurants, as the old
 * panel had for each. Every import:
 *
 *   - takes CSV or Excel with the template's headers (extra columns ignored);
 *   - checks every row first and reports each bad row with all its problems;
 *   - writes the good rows one at a time through the same rules as the admin
 *     forms, so an import can never create something the form would refuse;
 *   - returns { created, updated, failed, errors: [{ row, name, errors }] }.
 *
 * Foods already have their own bulk upload (bulkUpload.service.js).
 */

const SPECS = {
    categories: { name: 'Categories', columns: CATEGORY_COLUMNS, notes: CATEGORY_NOTES, required: ['Name*'] },
    addons: { name: 'Addons', columns: ADDON_COLUMNS, notes: ADDON_NOTES, required: ['Restaurant Id*', 'Name*', 'Price*'] },
    restaurants: {
        name: 'Restaurants',
        columns: RESTAURANT_COLUMNS,
        notes: RESTAURANT_NOTES,
        required: ['Restaurant Name*', 'Owner Name*', 'Owner Phone*'],
    },
};

const formatOf = (raw) => (String(raw || '').toLowerCase() === 'csv' ? 'csv' : 'xlsx');

const specFor = (entity) => {
    const spec = SPECS[entity];
    if (!spec) throw new ValidationError('Unknown import type');
    return spec;
};

/** An empty template: headers, plus a "How to fill" sheet in Excel. */
export async function buildTemplate(entity, format) {
    const spec = specFor(entity);
    return writeSheet({ format: formatOf(format), name: `${spec.name}_Template`, headers: spec.columns, notes: spec.notes });
}

async function readRecords(entity, file) {
    if (!file) throw new ValidationError('Choose a CSV or Excel (.xlsx) file to upload');
    const spec = specFor(entity);
    let sheet;
    try {
        sheet = await readSheet(file);
    } catch {
        throw new ValidationError('The file could not be read. Upload a CSV or Excel (.xlsx) file made from the template.');
    }
    const missing = missingHeaders(sheet.headers, spec.required);
    if (missing.length) throw new ValidationError(`The file is missing column(s): ${missing.join(', ')}`);
    if (!sheet.records.length) throw new ValidationError('The file has no rows to import');
    if (sheet.records.length > MAX_SHEET_ROWS) {
        throw new ValidationError(`At most ${MAX_SHEET_ROWS} rows per file; split it into smaller files`);
    }
    return sheet.records;
}

const newReport = () => ({ created: 0, updated: 0, failed: 0, errors: [] });
const fail = (report, row, name, errors) => {
    report.failed += 1;
    report.errors.push({ row, name: name || '', errors: Array.isArray(errors) ? errors : [errors] });
};

const zoneLookup = async () => {
    const zones = await prisma.foodZone.findMany({ select: { id: true, name: true, zoneName: true } });
    const byName = new Map();
    for (const z of zones) {
        byName.set(z.id, z);
        if (z.name) byName.set(z.name.trim().toLowerCase(), z);
        if (z.zoneName) byName.set(z.zoneName.trim().toLowerCase(), z);
    }
    return (raw) => byName.get(String(raw || '').trim().toLowerCase()) || null;
};

const dropCaches = async (patterns) => {
    try {
        const { invalidateCache } = await import('../../../../middleware/cache.js');
        await Promise.all(patterns.map((p) => invalidateCache(p)));
    } catch {
        // A cache that will not clear must not fail an import that succeeded;
        // entries expire on their own.
    }
};

// ─── categories ──────────────────────────────────────────────────────────────

export async function importCategories(file) {
    const records = await readRecords('categories', file);
    const report = newReport();
    const findZone = await zoneLookup();

    // Existing global categories by name, so a parent named in the sheet -- or
    // created earlier in the same sheet -- resolves, and a duplicate is caught.
    const globals = await prisma.foodCategory.findMany({
        where: { restaurantId: null },
        select: { id: true, name: true, parentId: true },
    });
    const key = (name, parentId) => `${String(parentId || '')}|${name.trim().toLowerCase()}`;
    const byKey = new Map(globals.map((c) => [key(c.name, c.parentId), c]));
    const globalIds = new Set(globals.map((c) => c.id));
    const topLevelByName = new Map(globals.filter((c) => !c.parentId).map((c) => [c.name.trim().toLowerCase(), c]));

    for (const { row, data } of records) {
        const checked = validateCategoryRow(data);
        if (checked.errors) {
            fail(report, row, data.name, checked.errors);
            continue;
        }
        const v = checked.value;
        const errors = [];
        let parentId = null;
        if (v.parentName) {
            const parent = topLevelByName.get(v.parentName.toLowerCase());
            if (!parent) errors.push(`Parent Category "${v.parentName}" is not an existing top-level category`);
            else parentId = parent.id;
        }
        let zoneId;
        if (v.zoneName) {
            const zone = findZone(v.zoneName);
            if (!zone) errors.push(`Zone "${v.zoneName}" does not exist`);
            else zoneId = zone.id;
        }
        if (v.id && !globalIds.has(v.id)) errors.push('No category has this Id; leave Id blank to add it as new');
        const clash = byKey.get(key(v.name, parentId));
        if (clash && clash.id !== v.id) errors.push(`A category named "${v.name}" already exists here`);
        if (errors.length) {
            fail(report, row, v.name, errors);
            continue;
        }

        const body = {
            name: v.name,
            image: v.image,
            parentId: parentId || null,
            zoneId: zoneId || 'global',
            isActive: v.isActive,
            sortOrder: v.sortOrder,
            ...(v.foodTypeScope ? { foodTypeScope: v.foodTypeScope } : {}),
        };
        try {
            let saved;
            if (v.id) {
                saved = await updateCategory(v.id, body);
                if (!saved) {
                    fail(report, row, v.name, 'No category has this Id; leave Id blank to add it as new');
                    continue;
                }
                report.updated += 1;
            } else {
                saved = await createCategory(body);
                report.created += 1;
            }
            globalIds.add(saved.id);
            byKey.set(key(saved.name, saved.parentId), saved);
            if (!saved.parentId) topLevelByName.set(saved.name.trim().toLowerCase(), saved);
        } catch (error) {
            fail(report, row, v.name, error?.message || 'Could not be saved');
        }
    }

    if (report.created || report.updated) await dropCaches(['categories:*']);
    return report;
}

export async function exportCategories(query = {}) {
    const where = { restaurantId: null };
    if (String(query.parentId || '') === 'root') where.parentId = null;
    else if (String(query.parentId || '') === 'sub') where.parentId = { not: null };
    const rows = await prisma.foodCategory.findMany({
        where,
        orderBy: [{ parentId: { sort: 'asc', nulls: 'first' } }, { sortOrder: 'asc' }, { name: 'asc' }],
        include: { parent: { select: { name: true } }, zone: { select: { name: true, zoneName: true } } },
    });
    return writeSheet({
        format: formatOf(query.format),
        name: 'Categories',
        headers: CATEGORY_COLUMNS,
        rows: rows.map(categoryExportRow),
    });
}

// ─── add-ons ─────────────────────────────────────────────────────────────────

export async function importAddons(file) {
    const records = await readRecords('addons', file);
    const report = newReport();

    const restaurantIds = [...new Set(records.map((r) => String(r.data['restaurant id'] || '').trim().toLowerCase()).filter(isId))];
    const [restaurants, categories, existing] = await Promise.all([
        prisma.foodRestaurant.findMany({ where: { id: { in: restaurantIds } }, select: { id: true } }),
        prisma.foodAddonCategory.findMany({ select: { id: true, name: true } }),
        prisma.foodAddon.findMany({
            where: { restaurantId: { in: restaurantIds }, isDeleted: false },
            select: { id: true, restaurantId: true, draft: true, published: true, approvalStatus: true },
        }),
    ]);
    const knownRestaurants = new Set(restaurants.map((r) => r.id));
    const categoryByName = new Map(categories.map((c) => [c.name.trim().toLowerCase(), c.id]));
    const addonById = new Map(existing.map((a) => [a.id, a]));
    const nameKey = (restaurantId, name) => `${restaurantId}|${String(name || '').trim().toLowerCase()}`;
    const idByName = new Map(existing.map((a) => [nameKey(a.restaurantId, a.draft?.name), a.id]));

    const now = new Date();
    for (const { row, data } of records) {
        const checked = validateAddonRow(data);
        if (checked.errors) {
            fail(report, row, data.name, checked.errors);
            continue;
        }
        const v = checked.value;
        const errors = [];
        if (!knownRestaurants.has(v.restaurantId)) errors.push('No restaurant has this Restaurant Id');
        let categoryId = null;
        if (v.categoryName) {
            categoryId = categoryByName.get(v.categoryName.toLowerCase()) || null;
            if (!categoryId) errors.push(`Addon Category "${v.categoryName}" does not exist`);
        }
        const target = v.id ? addonById.get(v.id) : null;
        if (v.id && !target) errors.push('No add-on has this Id; leave Id blank to add it as new');
        if (target && target.restaurantId !== v.restaurantId) errors.push('This add-on belongs to a different restaurant');
        const sameName = idByName.get(nameKey(v.restaurantId, v.name));
        if (sameName && sameName !== v.id) errors.push(`The restaurant already has an add-on named "${v.name}"`);
        if (errors.length) {
            fail(report, row, v.name, errors);
            continue;
        }

        const content = {
            name: v.name,
            description: v.description,
            foodType: v.foodType,
            price: v.price,
            image: v.image,
            images: v.image ? [v.image] : [],
        };
        try {
            if (target) {
                // An admin edit is already approved: both copies change together.
                await prisma.foodAddon.update({
                    where: { id: target.id },
                    data: {
                        draft: { ...(target.draft || {}), ...content },
                        published: { ...(target.published || target.draft || {}), ...content },
                        approvalStatus: 'approved',
                        approvedAt: now,
                        rejectionReason: '',
                        rejectedAt: null,
                        groupName: v.groupName,
                        categoryId,
                        isAvailable: v.isAvailable,
                    },
                });
                report.updated += 1;
            } else {
                const created = await prisma.foodAddon.create({
                    data: {
                        restaurantId: v.restaurantId,
                        draft: content,
                        published: content,
                        foodIds: [],
                        groupName: v.groupName,
                        categoryId,
                        isAvailable: v.isAvailable,
                        approvalStatus: 'approved',
                        approvedAt: now,
                    },
                    select: { id: true },
                });
                idByName.set(nameKey(v.restaurantId, v.name), created.id);
                report.created += 1;
            }
        } catch (error) {
            fail(report, row, v.name, error?.message || 'Could not be saved');
        }
    }

    if (report.created || report.updated) await dropCaches(['restaurant_addons:*']);
    return report;
}

export async function exportAddons(query = {}) {
    const where = { isDeleted: false };
    if (isId(query.restaurantId)) where.restaurantId = String(query.restaurantId);
    if (isId(query.categoryId)) where.categoryId = String(query.categoryId);
    if (['pending', 'approved', 'rejected'].includes(String(query.approvalStatus || ''))) {
        where.approvalStatus = String(query.approvalStatus);
    }
    const rows = await prisma.foodAddon.findMany({
        where,
        orderBy: [{ restaurantId: 'asc' }, { createdAt: 'asc' }],
        include: { restaurant: { select: { restaurantName: true } }, category: { select: { name: true } } },
        take: 20000,
    });
    return writeSheet({ format: formatOf(query.format), name: 'Addons', headers: ADDON_COLUMNS, rows: rows.map(addonExportRow) });
}

// ─── restaurants ─────────────────────────────────────────────────────────────

export async function importRestaurants(file) {
    const records = await readRecords('restaurants', file);
    const report = newReport();
    const findZone = await zoneLookup();
    const seenPhones = new Map();

    for (const { row, data } of records) {
        const checked = validateRestaurantRow(data);
        if (checked.errors) {
            fail(report, row, data['restaurant name'], checked.errors);
            continue;
        }
        const v = checked.value;
        const phone = phoneKey(v.ownerPhone);
        if (seenPhones.has(phone)) {
            fail(report, row, v.restaurantName, `Owner Phone is the same as row ${seenPhones.get(phone)}`);
            continue;
        }
        seenPhones.set(phone, row);

        let zoneId;
        if (v.zone) {
            const zone = findZone(v.zone);
            if (!zone) {
                fail(report, row, v.restaurantName, `Zone "${v.zone}" does not exist`);
                continue;
            }
            zoneId = zone.id;
        } else if (v.location.latitude !== undefined) {
            // No zone named: the one its pin falls in, as the address form does.
            zoneId = (await findZoneForPoint(v.location.latitude, v.location.longitude).catch(() => null))?.id;
        }

        const { zone: _zone, ...body } = v;
        try {
            // The same service as Add New Restaurant: required fields, the
            // duplicate-phone check against restaurants and restaurant logins,
            // approved status and the outlet timings all come from there.
            await createRestaurantByAdmin({ ...body, ...(zoneId ? { zoneId } : {}) });
            report.created += 1;
        } catch (error) {
            fail(report, row, v.restaurantName, error?.message || 'Could not be saved');
        }
    }
    return report;
}

export async function exportRestaurants(query = {}) {
    const where = {};
    if (['pending', 'approved', 'rejected'].includes(String(query.status || ''))) where.status = String(query.status);
    if (isId(query.zoneId)) where.zoneId = String(query.zoneId);
    const rows = await prisma.foodRestaurant.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        select: {
            id: true, restaurantName: true, ownerName: true, ownerPhone: true, ownerEmail: true, primaryContactNumber: true,
            formattedAddress: true, addressLine1: true, area: true, city: true, state: true, pincode: true,
            latitude: true, longitude: true, cuisines: true, openingTime: true, closingTime: true,
            pureVegRestaurant: true, estimatedDeliveryTime: true, fssaiNumber: true, gstNumber: true, panNumber: true,
            profileImage: true, coverImage: true, status: true, isAcceptingOrders: true, rating: true, createdAt: true,
            zone: { select: { name: true, zoneName: true } },
        },
        take: 20000,
    });
    return writeSheet({
        format: formatOf(query.format),
        name: 'Restaurants',
        headers: RESTAURANT_EXPORT_COLUMNS,
        rows: rows.map(restaurantExportRow),
    });
}
