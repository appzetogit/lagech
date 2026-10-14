/**
 * Admin staff: `admin_roles` -> food_admin_roles, `admins` -> food_admins
 * (sub-admins).
 *
 * A role here is a set of sidebar pages plus the section permissions the API
 * checks (constants/permissions.js). The old role was a list of 6amMart module
 * names; each is turned into the pages that module covered and the sections
 * behind them, with full access, as the old panel gave. Modules with nothing
 * equivalent here, and the one that is super-admin only here (employee
 * management), are listed in the summary rather than guessed at.
 *
 * Admins keep their old bcrypt password hash, so they sign in with the
 * password they had. PHP wrote it with the "$2y$" prefix, which is the same
 * algorithm as "$2b$"; compareAdminPassword reads both.
 *
 * Nothing here ever changes an admin or role that already exists in this
 * system: an old admin whose email is already an admin here (the super admin,
 * typically) is only linked in legacy.id_map, so chat history can name them.
 * The old "Master admin" role is this system's super admin and is not a
 * sub-admin role; an old admin on it who is not here already is not created
 * (super-admin rights are given by hand, not by an import).
 */
import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '../../../src/config/prisma.js';
import { config } from '../../../src/config/env.js';
import { buildPublicUrl } from '../../../src/services/storage.service.js';
import { ADMIN_ACTIONS, sanitizeAdminMenuPaths, sanitizeAdminPermissions } from '../../../src/constants/permissions.js';
import { loadIdMap, recordId } from '../idMap.mjs';

const ROLE = 'admin_role';
const ADMIN = 'admin';
const IMAGE_DIR = 'legacy/admin';
const MASTER_ROLE_ID = '1';

const P = (suffix = '') => `/admin/food${suffix}`;

/**
 * Old module -> [section, pages]. Pages are this panel's sidebar paths
 * (Frontend adminSidebarMenu); the section is what resolvePermissionSectionByPath
 * gives each of them, which is also what the API checks.
 */
export const MODULE_ACCESS = {
    pos: [['point_of_sale', [P('/point-of-sale')]]],
    order: [['order_management', [
        ...['all', 'scheduled', 'pending', 'processing', 'food-on-the-way', 'delivered', 'canceled',
            'restaurant-cancelled', 'payment-failed', 'refunded', 'offline-payments', 'user-carts'].map((s) => P(`/orders/${s}`)),
        P('/order-refunds/new'), P('/dispatch'), P('/order-cancel-reasons'), P('/order-detect-delivery'),
    ]]],
    campaign: [['promotions_management', [P('/campaigns/basic'), P('/campaigns/food')]]],
    advertisement: [['promotions_management', [P('/advertisements/new'), P('/advertisements/requests'), P('/advertisements')]]],
    cashback: [['promotions_management', [P('/cashback')]]],
    coupon: [['promotions_management', [P('/coupons')]]],
    banner: [['banner_management', [P('/banners'), P('/promotional-banner'), P('/hero-banner-management')]]],
    category: [['food_management', [P('/categories'), P('/categories/sub'), P('/categories/bulk-import'), P('/categories/bulk-export')]]],
    addon: [['food_management', [P('/addons'), P('/addons/categories'), P('/addons/bulk-import'), P('/addons/bulk-export')]]],
    item: [['food_management', [
        P('/foods/add-new'), P('/foods'), P('/food-approval'), P('/foods/gallery'), P('/foods/reviews'),
        P('/foods/bulk-import'), P('/foods/bulk-export'),
    ]]],
    // Old item attributes, units, brands and conditions are parts of a dish here.
    attribute: [['food_management', []]],
    unit: [['food_management', []]],
    brand: [['food_management', []]],
    common_condition: [['food_management', []]],
    store: [['restaurant_management', [
        P('/restaurants/joining-request'), P('/restaurants/add'), P('/restaurants/recommended'),
        P('/restaurants/bulk-import'), P('/restaurants/bulk-export'), P('/restaurants'), P('/restaurants/unregistered'),
        P('/restaurants/reviews'), P('/restaurants/complaints'), P('/restaurants/commission'),
        P('/restaurants/settings'), P('/restaurants/billing'),
    ]]],
    subscription: [['restaurant_management', [P('/restaurants/subscription-settings'), P('/restaurants/subscription-history')]]],
    zone: [['restaurant_management', [P('/zone-setup')]]],
    deliveryman: [['delivery_management', [
        P('/delivery-partners/vehicle-categories'), P('/delivery-partners/add'), P('/delivery-partners/join-request'),
        P('/delivery-partners'), P('/delivery-partners/reviews'), P('/delivery-partners/live-tracking'),
        P('/delivery-partners/duty-log'), P('/delivery-partners/earnings'), P('/delivery-partners/bonus'),
        P('/delivery-partners/earning-addon'), P('/delivery-partners/earning-addon-history'),
        P('/delivery-boy-commission'), P('/delivery-emergency-help'), P('/delivery-support-tickets'),
        P('/delivery-order-reassignment-requests'),
    ]]],
    collect_cash: [['delivery_management', [P('/delivery-boy-wallet'), P('/delivery-cash-limit'), P('/cash-limit-settlement')]]],
    customer_management: [['customer_management', [
        P('/user-overview'), P('/customers'), P('/wallet/add-fund'), P('/wallet/report'), P('/wallet/bonus'),
        P('/loyalty-point/report'), P('/subscribed-mail-list'), P('/chattings'), P('/support-tickets'),
        P('/order-issue-reports'),
    ]]],
    contact_message: [['support_management', [P('/contact-messages')]]],
    withdraw_list: [
        ['transaction_management', [P('/restaurant-withdraws')]],
        ['delivery_management', [P('/delivery-withdrawal')]],
    ],
    disbursement: [['transaction_management', [P('/restaurant-disbursements'), P('/deliveryman-disbursements')]]],
    provide_dm_earning: [['transaction_management', [P('/deliveryman-payments')]]],
    account: [['transaction_management', [P('/balance-sheet'), P('/restaurant-payments')]]],
    report: [['report_management', [
        P('/transaction-report'), P('/order-report/regular'), P('/restaurant-report'), P('/admin-earning-report'),
        P('/deliveryman-earning-report'), P('/expense-report'), P('/item-report'), P('/tax-report'),
        P('/restaurant-earning-report'), P('/disbursement-report/restaurants'), P('/restaurant-vat-report'),
        P('/customer-report/feedback-experience'),
    ]]],
};

/** Why an old module brings no access, for the summary. */
export const MODULE_NOT_GRANTED = {
    employee: 'employee management is super-admin only here',
    // Push notifications sit under System Settings here; that section also
    // opens every settings page, which the old role never had.
    notification: 'Push Notification is under System Settings here, which would open every settings page; tick it by hand if wanted',
    module: 'no modules here (food only)',
    parcel: 'no parcel delivery here',
};

/**
 * One old role's module list -> this system's role fields. The old panel
 * showed its dashboard to every employee, so every role gets the dashboard.
 *
 * @returns {{ data: { menuPaths: string[], permissions: object, accessLevel: 'full' }, notGranted: string[], unknown: string[] }}
 */
export function mapRoleModules(rawModules) {
    let modules = [];
    try {
        const parsed = typeof rawModules === 'string' ? JSON.parse(rawModules) : rawModules;
        modules = Array.isArray(parsed) ? parsed.map((m) => String(m).trim()).filter(Boolean) : [];
    } catch {
        modules = [];
    }
    const pages = [P()];
    const sections = new Set(['dashboard']);
    const notGranted = [];
    const unknown = [];
    for (const module of [...new Set(modules)]) {
        const access = MODULE_ACCESS[module];
        if (access) {
            for (const [section, paths] of access) {
                sections.add(section);
                pages.push(...paths);
            }
        } else if (MODULE_NOT_GRANTED[module]) {
            notGranted.push(`${module} (${MODULE_NOT_GRANTED[module]})`);
        } else {
            unknown.push(module);
        }
    }
    const permissions = sanitizeAdminPermissions(
        Object.fromEntries([...sections].map((section) => [section, [...ADMIN_ACTIONS]])),
    );
    return {
        data: { menuPaths: sanitizeAdminMenuPaths(pages), permissions, accessLevel: 'full' },
        notGranted,
        unknown,
    };
}

const last10 = (phone) => String(phone || '').replace(/\D/g, '').slice(-10);
const emailOf = (value) => {
    const email = String(value || '').trim().toLowerCase();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
};
/** A bcrypt hash as PHP (2y) or Node (2a/2b) writes it; anything else is not a usable password. */
export const isBcryptHash = (value) => /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(String(value || ''));

/**
 * One old admin -> a sub-admin here, on the given role (its access copied, as
 * accessFrom in adminSubAdmin.service.js does). Pure; exported for the test.
 *
 * @returns {{ skip: string } | { data: object }}
 */
export function mapLegacyAdmin(row, role, image = '') {
    const email = emailOf(row.email);
    if (!email) return { skip: 'no usable email (it is the login)' };
    if (!isBcryptHash(row.password)) return { skip: 'password is not a bcrypt hash; cannot be carried' };
    if (!role) return { skip: `role ${row.role_id} was not imported` };
    const first = String(row.f_name || '').trim();
    const last = String(row.l_name || '').trim();
    return {
        data: {
            email,
            password: String(row.password),
            name: (first === last ? first : `${first} ${last}`).trim(),
            phone: last10(row.phone),
            profileImage: image || '',
            role: 'ADMIN',
            adminType: 'sub_admin',
            roleId: role.id,
            permissions: sanitizeAdminPermissions(role.permissions || {}),
            menuPaths: sanitizeAdminMenuPaths(role.menuPaths),
            isActive: true,
            isDeleted: false,
            ...(row.created_at ? { createdAt: row.created_at } : {}),
        },
    };
}

const imageUrl = (file, missing) => {
    const name = String(file || '').trim();
    if (!name || name === 'def.png') return '';
    if (fs.existsSync(path.join(config.uploadStorageRoot || 'uploads', IMAGE_DIR, name))) return buildPublicUrl(`${IMAGE_DIR}/${name}`);
    missing.push(name);
    return '';
};

async function importRoles(mysql, report, ctx) {
    const idMap = await loadIdMap(ROLE);
    const SQL = 'SELECT id, name, modules, status FROM admin_roles ORDER BY id';
    const [rows] = await mysql.query(SQL);
    const baseline = ctx.sync ? await ctx.baselineRows(SQL) : null;

    for (const row of rows) {
        if (String(row.id) === MASTER_ROLE_ID) {
            // Not a skip: there is nothing to bring, the super admin already has every right.
            report.warn(ROLE, row.id, row.name, 'the master admin role is the super admin here, not a sub-admin role; not imported');
            continue;
        }
        const mappedId = idMap.get(String(row.id));
        // Roles imported before are this system's to edit now, re-run or sync alike.
        if (mappedId) {
            if (!(await prisma.foodAdminRole.count({ where: { id: mappedId } }))) {
                report.skip(ROLE, row.id, row.name, 'imported before but deleted here since; not recreated');
            } else if (ctx.sync) {
                ctx.leaveAlone(report, ROLE, row, baseline, ['name', 'modules', 'status']);
            } else {
                report.done(ROLE, 'unchanged');
            }
            continue;
        }
        const name = String(row.name || '').trim().replace(/\s+/g, ' ').slice(0, 60);
        if (!name) {
            report.skip(ROLE, row.id, '(no name)', 'role has no name');
            continue;
        }
        const { data, notGranted, unknown } = mapRoleModules(row.modules);
        if (notGranted.length) report.warn(ROLE, row.id, name, `not granted: ${notGranted.join('; ')}`);
        if (unknown.length) report.warn(ROLE, row.id, name, `old modules with nothing equivalent here: ${unknown.join(', ')}`);
        if (Number(row.status) !== 1) report.warn(ROLE, row.id, name, 'was switched off in the old panel; roles here have no on/off, imported as is');

        // A role of the same name made here is the same role: linked, not changed.
        const here = await prisma.foodAdminRole.findUnique({ where: { name }, select: { id: true } });
        if (here) {
            report.warn(ROLE, row.id, name, 'a role with this name already exists here; linked to it, its access kept');
            await recordId(ROLE, row.id, here.id);
            report.done(ROLE, 'unchanged');
            continue;
        }
        const created = await prisma.foodAdminRole.create({ data: { name, ...data }, select: { id: true } });
        await recordId(ROLE, row.id, created.id);
        report.done(ROLE, 'created');
    }
}

async function importAdmins(mysql, report, ctx) {
    const roleMap = await loadIdMap(ROLE);
    const idMap = await loadIdMap(ADMIN);
    // Never SELECT * here: remember_token and login_remember_token stay in the old database.
    const SQL = 'SELECT id, f_name, l_name, phone, email, image, password, role_id, zone_id, created_at FROM admins ORDER BY id';
    const [rows] = await mysql.query(SQL);
    const missing = [];

    for (const row of rows) {
        const label = String(row.email || '').trim();
        const mappedId = idMap.get(String(row.id));
        if (mappedId) {
            // Imported (or linked) before: this system's admin now, never rewritten.
            if (await prisma.foodAdmin.count({ where: { id: mappedId } })) report.done(ADMIN, 'unchanged');
            else report.skip(ADMIN, row.id, label, 'imported before but removed here since; not recreated');
            continue;
        }
        const email = emailOf(row.email);
        const here = email
            ? await prisma.foodAdmin.findUnique({ where: { email }, select: { id: true, adminType: true } })
            : null;
        if (here) {
            await recordId(ADMIN, row.id, here.id);
            report.warn(ADMIN, row.id, label, `already an admin here (${here.adminType}); linked, nothing changed`);
            report.done(ADMIN, 'unchanged');
            continue;
        }
        if (String(row.role_id) === MASTER_ROLE_ID) {
            report.skip(ADMIN, row.id, label, 'old master admin with no admin here by that email; super-admin rights are not given by import');
            continue;
        }
        const roleId = roleMap.get(String(row.role_id));
        const role = roleId
            ? await prisma.foodAdminRole.findUnique({ where: { id: roleId }, select: { id: true, permissions: true, menuPaths: true } })
            : null;
        const mapped = mapLegacyAdmin(row, role, imageUrl(row.image, missing));
        if (mapped.skip) {
            report.skip(ADMIN, row.id, label, mapped.skip);
            continue;
        }
        if (row.zone_id) report.warn(ADMIN, row.id, label, `was limited to zone ${row.zone_id} in the old panel; admins here are not zone-limited`);
        const created = await prisma.foodAdmin.create({ data: mapped.data, select: { id: true } });
        await recordId(ADMIN, row.id, created.id);
        report.done(ADMIN, 'created');
    }
    if (missing.length) report.warn(ADMIN, '-', '(all)', `${missing.length} admin picture(s) not found under ${IMAGE_DIR}`);
}

export async function importAdminStaff(mysql, report, ctx = {}) {
    await importRoles(mysql, report, ctx);
    await importAdmins(mysql, report, ctx);
}
