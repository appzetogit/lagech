import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { ValidationError } from '../../../../core/auth/errors.js';
import { hashAdminPassword } from '../../../../core/auth/adminPassword.util.js';
import {
    ADMIN_FULL_PERMISSIONS,
    isValidPermissionPayload,
    sanitizeAdminMenuPaths,
    sanitizeAdminPermissions,
} from '../../../../constants/permissions.js';

/**
 * Sub-admin accounts, extracted from the 6,258-line admin.service.js.
 *
 * Two things about this file are load-bearing:
 *
 * The password is hashed here. Mongoose did it in a pre('save') hook that went
 * with the model, so a straight port would have written the plaintext the admin
 * typed into the password column. hashAdminPassword is the one implementation.
 *
 * Every read names its columns instead of asking for all of them, because the
 * default would include `password`. Mongoose had `.select('-password')` for the
 * same reason; Prisma has no negative select, so the safe list is explicit.
 */
const SUB_ADMIN_SELECT = {
    id: true, email: true, name: true, phone: true, profileImage: true,
    role: true, adminType: true, permissions: true, menuPaths: true, roleId: true,
    isActive: true, isDeleted: true, servicesAccess: true,
    createdById: true, updatedById: true, createdAt: true, updatedAt: true,
};

const toEmail = (value) => String(value || '').trim().toLowerCase();

/** Sub-admins only, and only live ones unless the caller says otherwise. */
const subAdminWhere = (extra = {}) => ({ adminType: 'sub_admin', isDeleted: false, ...extra });

export async function createSubAdmin(payload = {}, actorId) {
    const email = toEmail(payload.email);
    const password = String(payload.password || '').trim();
    const name = String(payload.name || '').trim();

    if (!email || !password) throw new ValidationError('Email and password are required');

    try {
        return await prisma.foodAdmin.create({
            data: {
                email,
                // Never the raw value: the hook that used to do this is gone.
                password: await hashAdminPassword(password),
                name,
                phone: String(payload.phone || '').trim(),
                role: 'ADMIN',
                adminType: 'sub_admin',
                // A role's access when one was chosen, otherwise what the
                // creator ticked; nothing at all if they ticked nothing.
                ...(await accessFrom(payload)),
                isActive: true,
                isDeleted: false,
                createdById: isId(actorId) ? String(actorId) : null,
                updatedById: isId(actorId) ? String(actorId) : null,
            },
            select: SUB_ADMIN_SELECT,
        });
    } catch (error) {
        // email is unique in the database, so the insert decides the race
        // rather than a lookup before it.
        if (error?.code === 'P2002') {
            throw new ValidationError('Admin with this email already exists');
        }
        throw error;
    }
}

export async function getSubAdmins(query = {}) {
    const where = { adminType: 'sub_admin' };
    if (query.includeDeleted !== 'true') where.isDeleted = false;
    if (query.status === 'active') where.isActive = true;
    if (query.status === 'inactive') where.isActive = false;

    const search = String(query.search || '').trim();
    if (search) {
        const contains = { contains: search, mode: 'insensitive' };
        where.OR = [{ name: contains }, { email: contains }, { phone: contains }];
    }

    const items = await prisma.foodAdmin.findMany({
        where,
        select: SUB_ADMIN_SELECT,
        orderBy: { createdAt: 'desc' },
    });
    return { items };
}

export async function getSubAdminById(id) {
    if (!isId(id)) throw new ValidationError('Invalid sub-admin id');

    const item = await prisma.foodAdmin.findFirst({
        where: { id: String(id), adminType: 'sub_admin' },
        select: SUB_ADMIN_SELECT,
    });
    if (!item) throw new ValidationError('Sub-admin not found');
    return item;
}

/**
 * Apply an update, but only to a live sub-admin.
 *
 * updateMany carries the adminType/isDeleted guard into the write itself, so a
 * super-admin's row can never be reached through these endpoints — a plain
 * update by id could.
 */
const updateSubAdmin = async (id, data) => {
    if (!isId(id)) throw new ValidationError('Invalid sub-admin id');

    const { count } = await prisma.foodAdmin.updateMany({
        where: subAdminWhere({ id: String(id) }),
        data,
    });
    if (!count) throw new ValidationError('Sub-admin not found');

    return prisma.foodAdmin.findUnique({ where: { id: String(id) }, select: SUB_ADMIN_SELECT });
};

export async function updateSubAdminProfile(id, payload = {}, actorId) {
    const data = { updatedById: isId(actorId) ? String(actorId) : null };
    if (payload.name !== undefined) data.name = String(payload.name || '').trim();
    if (payload.phone !== undefined) data.phone = String(payload.phone || '').trim();
    if (payload.email !== undefined) data.email = toEmail(payload.email);

    try {
        return await updateSubAdmin(id, data);
    } catch (error) {
        if (error?.code === 'P2002') {
            throw new ValidationError('Admin with this email already exists');
        }
        throw error;
    }
}

export async function updateSubAdminPermissions(id, rawPermissions = {}, actorId, menuPaths = undefined, roleId = undefined) {
    if (roleId) {
        // Following a role: its access replaces whatever was ticked.
        return updateSubAdmin(id, { ...(await accessFrom({ roleId })), updatedById: isId(actorId) ? String(actorId) : null });
    }
    if (!isValidPermissionPayload(rawPermissions)) {
        throw new ValidationError('Invalid permissions payload');
    }

    return updateSubAdmin(id, {
        // Sanitised, not stored as sent: this decides what the account can reach.
        permissions: sanitizeAdminPermissions(rawPermissions),
        ...(menuPaths !== undefined ? { menuPaths: sanitizeAdminMenuPaths(menuPaths) } : {}),
        // Access set by hand no longer follows a role.
        roleId: null,
        updatedById: isId(actorId) ? String(actorId) : null,
    });
}

export async function updateSubAdminStatus(id, isActive, actorId) {
    return updateSubAdmin(id, {
        isActive: Boolean(isActive),
        updatedById: isId(actorId) ? String(actorId) : null,
    });
}

/** Soft delete: the row stays for the audit trail, deactivated. */
export async function deleteSubAdmin(id, actorId) {
    return updateSubAdmin(id, {
        isDeleted: true,
        isActive: false,
        updatedById: isId(actorId) ? String(actorId) : null,
    });
}

export function getAdminPermissionCatalog() {
    return {
        actions: ['view', 'create', 'edit', 'delete', 'export'],
        sections: Object.keys(ADMIN_FULL_PERMISSIONS).map((section) => ({
            key: section,
            actions: ADMIN_FULL_PERMISSIONS[section],
        })),
    };
}

// ─── Roles ───────────────────────────────────────────────────────────────────
//
// A role is a named set of sidebar pages with an access level. A sub-admin on a
// role has a copy of its access, and saving the role rewrites every one of
// those copies, so "change the Order desk role" changes everyone on it. Access
// set by hand detaches an admin from their role rather than drifting under it.

const ROLE_SELECT = {
    id: true, name: true, menuPaths: true, permissions: true, accessLevel: true,
    createdAt: true, updatedAt: true,
    _count: { select: { admins: { where: { isDeleted: false } } } },
};

const serializeRole = ({ _count, ...role }) => ({ ...role, adminCount: _count?.admins ?? 0 });

/** The access fields a create or update writes: from a role, or as sent. */
async function accessFrom(payload = {}) {
    if (payload.roleId) {
        if (!isId(payload.roleId)) throw new ValidationError('Invalid role');
        const role = await prisma.foodAdminRole.findUnique({ where: { id: String(payload.roleId) } });
        if (!role) throw new ValidationError('Role not found');
        return {
            roleId: role.id,
            permissions: sanitizeAdminPermissions(role.permissions || {}),
            menuPaths: sanitizeAdminMenuPaths(role.menuPaths),
        };
    }
    return {
        roleId: null,
        // Nothing granted stays {}: access is given explicitly, never by default.
        permissions: payload.permissions && Object.keys(payload.permissions).length
            && isValidPermissionPayload(payload.permissions)
            ? sanitizeAdminPermissions(payload.permissions)
            : {},
        menuPaths: sanitizeAdminMenuPaths(payload.menuPaths),
    };
}

const roleData = (body = {}) => {
    const data = {};
    if (body.name !== undefined) {
        const name = String(body.name || '').trim().replace(/\s+/g, ' ');
        if (!name) throw new ValidationError('Role name is required');
        if (name.length > 60) throw new ValidationError('Role name must be 60 characters or fewer');
        data.name = name;
    }
    if (body.accessLevel !== undefined) data.accessLevel = body.accessLevel === 'view' ? 'view' : 'full';
    if (body.menuPaths !== undefined) data.menuPaths = sanitizeAdminMenuPaths(body.menuPaths);
    if (body.permissions !== undefined) {
        if (!isValidPermissionPayload(body.permissions || {})) throw new ValidationError('Invalid permissions payload');
        data.permissions = sanitizeAdminPermissions(body.permissions || {});
    }
    return data;
};

const duplicateName = (error) => {
    if (error?.code === 'P2002') throw new ValidationError('A role with this name already exists');
    throw error;
};

export async function listAdminRoles() {
    const roles = await prisma.foodAdminRole.findMany({ orderBy: { name: 'asc' }, select: ROLE_SELECT });
    return roles.map(serializeRole);
}

export async function createAdminRole(body = {}) {
    const data = roleData(body);
    if (!data.name) throw new ValidationError('Role name is required');
    const role = await prisma.foodAdminRole.create({ data, select: ROLE_SELECT }).catch(duplicateName);
    return serializeRole(role);
}

/** Save a role and pass its access on to every sub-admin who follows it. */
export async function updateAdminRole(id, body = {}) {
    if (!isId(id)) throw new ValidationError('Invalid role');
    const data = roleData(body);
    const role = await prisma.$transaction(async (tx) => {
        const saved = await tx.foodAdminRole.update({ where: { id: String(id) }, data, select: ROLE_SELECT }).catch((error) => {
            if (error?.code === 'P2025') throw new ValidationError('Role not found');
            return duplicateName(error);
        });
        await tx.foodAdmin.updateMany({
            where: { roleId: saved.id, adminType: 'sub_admin' },
            data: {
                permissions: sanitizeAdminPermissions(saved.permissions || {}),
                menuPaths: sanitizeAdminMenuPaths(saved.menuPaths),
            },
        });
        return saved;
    });
    return serializeRole(role);
}

/** Delete a role. Its admins keep the access they had, set by hand from now on. */
export async function deleteAdminRole(id) {
    if (!isId(id)) throw new ValidationError('Invalid role');
    const { count } = await prisma.foodAdminRole.deleteMany({ where: { id: String(id) } });
    if (!count) throw new ValidationError('Role not found');
    return { deleted: true };
}
