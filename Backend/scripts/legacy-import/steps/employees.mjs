/**
 * Restaurant staff: `employee_roles` -> food_restaurant_roles and
 * `vendor_employees` -> food_restaurant_employees (the old store panel's
 * Employee Role and Employees). Run after `restaurants`.
 *
 * Old columns, as they are in the backup:
 *   employee_roles   id, store_id, name, modules (JSON list), status
 *   vendor_employees id, f_name, l_name, phone, email (unique), image,
 *                    employee_role_id, vendor_id, store_id, password (bcrypt,
 *                    Laravel's `$2y$`), status, and session/remember tokens
 *                    (not copied)
 *
 * Mapping:
 *   - store ids go through legacy.id_map ('restaurant'); a row of a store that
 *     was not imported is skipped.
 *   - modules map to permission keys (LEGACY_MODULE_PERMISSIONS in
 *     src/core/auth/restaurantPermissions.js); one with no counterpart here
 *     is dropped with a warning.
 *   - two roles of one store with the same name keep both, the later one
 *     suffixed with its old id (names are unique per restaurant here).
 *   - the password hash is copied as it is: login verifies `$2y$` hashes, so
 *     staff sign in with the passwords they had. It is never printed.
 *   - phone: digits with country code kept as stored; a number too short to
 *     be one, or one another employee already has, is left blank (warned) --
 *     they can still sign in by email.
 *   - images from `legacy/vendor` (the old storage/app/public/vendor).
 *
 * Sync: only rows not imported before are added. Roles and employees are the
 * restaurants' own now; an old-side change to one imported before is only
 * reported.
 */
import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '../../../src/config/prisma.js';
import { config } from '../../../src/config/env.js';
import { buildPublicUrl } from '../../../src/services/storage.service.js';
import { mapLegacyModules } from '../../../src/core/auth/restaurantPermissions.js';
import { loadIdMap, recordId } from '../idMap.mjs';

const ROLE = 'restaurant_role';
const EMPLOYEE = 'restaurant_employee';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * One old role -> food_restaurant_roles columns. Exported for the test.
 * @param {{ restaurants: Map<string, string> }} maps legacy id -> new id
 */
export function mapLegacyRole(row, maps) {
    const restaurantId = row.store_id ? maps.restaurants.get(String(row.store_id)) : null;
    if (!row.store_id) return { skip: 'no store (not a restaurant role)' };
    if (!restaurantId) return { skip: `restaurant ${row.store_id} not imported` };
    const name = String(row.name || '').trim().slice(0, 60);
    if (!name) return { skip: 'no name' };
    const { permissions, unknown } = mapLegacyModules(row.modules);
    const warnings = [];
    if (unknown.length) warnings.push(`module(s) with no counterpart here dropped: ${unknown.join(', ')}`);
    if (!permissions.length) warnings.push('no permissions; staff on it can only open the panel');
    if (Number(row.status) === 0) warnings.push('was switched off in the old system (roles have no on/off here)');
    return {
        warnings,
        data: {
            restaurantId,
            name,
            permissions,
            ...(row.created_at ? { createdAt: row.created_at } : {}),
        },
    };
}

/**
 * One old employee -> food_restaurant_employees columns (no image: the step
 * resolves the file). Exported for the test.
 * @param {{ restaurants: Map<string, string>, roles: Map<string, string> }} maps
 */
export function mapLegacyEmployee(row, maps) {
    const restaurantId = maps.restaurants.get(String(row.store_id));
    if (!restaurantId) return { skip: `restaurant ${row.store_id} not imported` };
    const roleId = maps.roles.get(String(row.employee_role_id));
    if (!roleId) return { skip: `role ${row.employee_role_id} not imported` };
    const email = String(row.email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return { skip: 'no valid email' };
    const password = String(row.password || '');
    if (!/^\$2[aby]\$\d\d\$/.test(password)) return { skip: 'password is not a bcrypt hash' };

    const warnings = [];
    let first = String(row.f_name || '').trim();
    let last = String(row.l_name || '').trim();
    if (first && first === last) last = '';
    if (!first) {
        first = last || email.split('@')[0];
        last = first === last ? '' : last;
    }
    const digits = String(row.phone || '').replace(/\D/g, '');
    let phone = '';
    if (digits.length >= 10 && digits.length <= 15) phone = String(row.phone).trim().slice(0, 20);
    else if (digits) warnings.push(`phone "${row.phone}" is not a phone number; imported without it`);

    return {
        warnings,
        imageFile: String(row.image || '').trim(),
        data: {
            restaurantId,
            roleId,
            firstName: first.slice(0, 100),
            lastName: last.slice(0, 100),
            email,
            phone,
            phoneLast10: phone ? digits.slice(-10) : '',
            password,
            isActive: Number(row.status) === 1,
            ...(row.created_at ? { createdAt: row.created_at } : {}),
        },
    };
}

const imageFrom = (file, report, row) => {
    const name = String(file || '').trim();
    if (!name || name === 'def.png') return '';
    const dir = 'legacy/vendor';
    const root = config.uploadStorageRoot || 'uploads';
    if (fs.existsSync(path.join(root, dir, name))) return buildPublicUrl(`${dir}/${name}`);
    report.warn(EMPLOYEE, row.id, row.name, `image ${name} not found in ${dir}; imported without it`);
    return '';
};

const ROLE_SQL = 'SELECT id, store_id, name, modules, status, created_at FROM employee_roles ORDER BY id';
const ROLE_COLUMNS = ['store_id', 'name', 'modules', 'status'];
// Never the password here: the baseline is only compared, and what it would show is a hash.
const EMPLOYEE_BASE_SQL = `SELECT id, CONCAT_WS(' ', f_name, l_name) AS name, f_name, l_name, phone, email, image,
           employee_role_id, store_id, status, created_at FROM vendor_employees ORDER BY id`;
const EMPLOYEE_SQL = `SELECT id, CONCAT_WS(' ', f_name, l_name) AS name, f_name, l_name, phone, email, image,
           employee_role_id, store_id, status, password, created_at FROM vendor_employees ORDER BY id`;
const EMPLOYEE_COLUMNS = ['f_name', 'l_name', 'phone', 'email', 'image', 'employee_role_id', 'store_id', 'status'];

async function importRoles(mysql, report, ctx, restaurants) {
    const idMap = await loadIdMap(ROLE);
    const [rows] = await mysql.query(ROLE_SQL);
    const baseline = ctx.sync ? await ctx.baselineRows(ROLE_SQL) : null;
    for (const row of rows) {
        if (ctx.sync && idMap.has(String(row.id))) {
            ctx.leaveAlone(report, ROLE, row, baseline, ROLE_COLUMNS);
            continue;
        }
        const mapped = mapLegacyRole(row, { restaurants });
        if (mapped.skip) {
            report.skip(ROLE, row.id, row.name || '(no name)', mapped.skip);
            continue;
        }
        for (const message of mapped.warnings) report.warn(ROLE, row.id, row.name, message);

        const mappedId = idMap.get(String(row.id));
        const exists = mappedId && (await prisma.foodRestaurantRole.count({ where: { id: mappedId } })) > 0;
        const clash = await prisma.foodRestaurantRole.findUnique({
            where: { restaurantId_name: { restaurantId: mapped.data.restaurantId, name: mapped.data.name } },
            select: { id: true },
        });
        if (clash && clash.id !== mappedId) {
            const renamed = `${mapped.data.name} (old #${row.id})`.slice(0, 60);
            report.warn(ROLE, row.id, row.name, `the restaurant already has a role named "${mapped.data.name}"; imported as "${renamed}"`);
            mapped.data.name = renamed;
        }
        const saved = exists
            ? await prisma.foodRestaurantRole.update({ where: { id: mappedId }, data: mapped.data, select: { id: true } })
            : await prisma.foodRestaurantRole.create({ data: mapped.data, select: { id: true } });
        await recordId(ROLE, row.id, saved.id);
        report.done(ROLE, exists ? 'updated' : 'created');
    }
}

async function importEmployeeRows(mysql, report, ctx, restaurants) {
    const idMap = await loadIdMap(EMPLOYEE);
    const roles = await loadIdMap(ROLE);
    const [rows] = await mysql.query(EMPLOYEE_SQL);
    const baseline = ctx.sync ? await ctx.baselineRows(EMPLOYEE_BASE_SQL) : null;
    for (const row of rows) {
        const name = String(row.name || '').trim() || '(no name)';
        if (ctx.sync && idMap.has(String(row.id))) {
            ctx.leaveAlone(report, EMPLOYEE, { ...row, password: undefined }, baseline, EMPLOYEE_COLUMNS);
            continue;
        }
        const mapped = mapLegacyEmployee(row, { restaurants, roles });
        if (mapped.skip) {
            report.skip(EMPLOYEE, row.id, name, mapped.skip);
            continue;
        }
        for (const message of mapped.warnings) report.warn(EMPLOYEE, row.id, name, message);
        const data = { ...mapped.data, image: imageFrom(mapped.imageFile, report, { ...row, name }) };

        const mappedId = idMap.get(String(row.id));
        const exists = mappedId && (await prisma.foodRestaurantEmployee.count({ where: { id: mappedId } })) > 0;
        const emailClash = await prisma.foodRestaurantEmployee.findUnique({ where: { email: data.email }, select: { id: true } });
        if (emailClash && emailClash.id !== mappedId) {
            report.skip(EMPLOYEE, row.id, name, 'its email is already used by another employee here');
            continue;
        }
        if (data.phoneLast10) {
            const phoneClash = await prisma.foodRestaurantEmployee.findFirst({
                where: { phoneLast10: data.phoneLast10, ...(mappedId ? { NOT: { id: mappedId } } : {}) },
                select: { id: true },
            });
            if (phoneClash) {
                report.warn(EMPLOYEE, row.id, name, 'its phone is already used by another employee here; imported without it (email sign-in works)');
                data.phone = '';
                data.phoneLast10 = '';
            }
        }
        if (exists) {
            // A re-run keeps a password changed here.
            const { password: _keep, ...rest } = data;
            await prisma.foodRestaurantEmployee.update({ where: { id: mappedId }, data: rest, select: { id: true } });
            await recordId(EMPLOYEE, row.id, mappedId);
        } else {
            const saved = await prisma.foodRestaurantEmployee.create({ data, select: { id: true } });
            await recordId(EMPLOYEE, row.id, saved.id);
        }
        report.done(EMPLOYEE, exists ? 'updated' : 'created');
    }
}

export async function importEmployees(mysql, report, ctx = {}) {
    const restaurants = await loadIdMap('restaurant');
    await importRoles(mysql, report, ctx, restaurants);
    await importEmployeeRows(mysql, report, ctx, restaurants);
}
