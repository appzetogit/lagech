/**
 * Payout method types: `withdrawal_methods` -> food_withdrawal_methods, then
 * each restaurant's and rider's chosen method from
 * `disbursement_withdrawal_methods` -> food_payout_method_details.
 *
 * Old method fields are [{ input_type, input_name, placeholder, is_required }];
 * input_name becomes the field's storage key, so the values payees entered
 * under it in the old app line up. The bank and UPI columns are filled by the
 * payment-details step and are not touched here.
 *
 * A payee who has already chosen a method on this system keeps their choice.
 */
import { prisma } from '../../../src/config/prisma.js';
import { loadIdMap, recordId } from '../idMap.mjs';
import { fieldFromLegacy } from '../../../src/modules/food/admin/services/payoutMethods.util.js';

const ENTITY = 'withdrawal_method';

const parseJson = (value, fallback) => {
    if (value && typeof value === 'object') return value;
    try {
        return JSON.parse(value || '') ?? fallback;
    } catch {
        return fallback;
    }
};

async function importMethods(mysql, report) {
    const idMap = await loadIdMap(ENTITY);
    const [rows] = await mysql.query('SELECT * FROM withdrawal_methods ORDER BY id');
    let defaultId = null;

    for (const [index, row] of rows.entries()) {
        const name = String(row.method_name || '').trim().slice(0, 80);
        const raw = parseJson(row.method_fields, []);
        const seen = new Set();
        const fields = (Array.isArray(raw) ? raw : [])
            .map(fieldFromLegacy)
            .filter((field) => field.key && !seen.has(field.key) && seen.add(field.key));
        if (!name || !fields.length) {
            report.skip(ENTITY, row.id, name || '(no name)', !name ? 'no method name' : 'no usable fields');
            continue;
        }

        const data = {
            name,
            fields,
            isActive: Number(row.is_active) === 1,
            // Set below, once, so two legacy defaults cannot both survive.
            isDefault: false,
            sortOrder: index,
            ...(row.created_at ? { createdAt: row.created_at } : {}),
        };
        const mappedId = idMap.get(String(row.id));
        const exists = mappedId && (await prisma.foodWithdrawalMethod.count({ where: { id: mappedId } })) > 0;
        const saved = exists
            ? await prisma.foodWithdrawalMethod.update({ where: { id: mappedId }, data, select: { id: true } })
            : await prisma.foodWithdrawalMethod.create({ data, select: { id: true } });
        await recordId(ENTITY, row.id, saved.id);
        if (Number(row.is_default) === 1 && data.isActive) defaultId = saved.id;
        report.done(ENTITY, exists ? 'updated' : 'created');
    }

    if (defaultId) {
        await prisma.$transaction([
            prisma.foodWithdrawalMethod.updateMany({ where: { id: { not: defaultId } }, data: { isDefault: false } }),
            prisma.foodWithdrawalMethod.update({ where: { id: defaultId }, data: { isDefault: true } }),
        ]);
    }
}

async function importPayeeChoices(mysql, report) {
    const entity = 'payout_method_detail';
    const methods = await loadIdMap(ENTITY);
    const restaurants = await loadIdMap('restaurant');
    const riders = await loadIdMap('delivery_partner');

    let rows = [];
    try {
        [rows] = await mysql.query('SELECT * FROM disbursement_withdrawal_methods ORDER BY id');
    } catch (error) {
        report.warn(entity, '-', 'disbursement_withdrawal_methods', `not read: ${error.message}`);
        return;
    }

    // One choice per payee: their default row, else their latest.
    const chosen = new Map();
    for (const row of rows) {
        const key = row.store_id ? `restaurant:${row.store_id}` : row.delivery_man_id ? `rider:${row.delivery_man_id}` : null;
        if (!key) continue;
        const current = chosen.get(key);
        if (!current || Number(row.is_default) === 1 || Number(current.is_default) !== 1) chosen.set(key, row);
    }

    for (const [key, row] of chosen) {
        const [ownerType, legacyOwner] = key.split(':');
        const ownerId = (ownerType === 'restaurant' ? restaurants : riders).get(String(legacyOwner));
        const methodId = methods.get(String(row.withdrawal_method_id ?? ''));
        if (!ownerId) {
            report.skip(entity, row.id, key, `${ownerType} not imported`);
            continue;
        }
        if (!methodId) {
            report.skip(entity, row.id, key, 'its withdrawal method was not imported');
            continue;
        }

        const method = await prisma.foodWithdrawalMethod.findUnique({ where: { id: methodId }, select: { fields: true } });
        const known = new Set((method?.fields || []).map((field) => field.key));
        const values = Object.fromEntries(
            Object.entries(parseJson(row.method_fields, {}) || {})
                .map(([name, value]) => [String(name).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, ''), String(value ?? '').trim()])
                .filter(([name, value]) => known.has(name) && value),
        );

        const existing = await prisma.foodPayoutMethodDetail.findUnique({
            where: { ownerType_ownerId: { ownerType, ownerId } },
            select: { id: true },
        });
        if (existing) {
            report.skip(entity, row.id, key, 'already has a payout method chosen on this system');
            continue;
        }
        await prisma.foodPayoutMethodDetail.create({ data: { ownerType, ownerId, methodId, values } });
        report.done(entity, 'created');
    }
}

export async function importWithdrawalMethods(mysql, report) {
    await importMethods(mysql, report);
    await importPayeeChoices(mysql, report);
}
