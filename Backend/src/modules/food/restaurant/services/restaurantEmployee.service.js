import ms from 'ms';
import { prisma } from '../../../../config/prisma.js';
import { config } from '../../../../config/env.js';
import { isId } from '../../../../utils/helpers.js';
import { AuthError, ForbiddenError, NotFoundError, ValidationError } from '../../../../core/auth/errors.js';
import { comparePassword, hashPassword } from '../../../../core/auth/adminPassword.util.js';
import { signAccessToken, signRefreshToken } from '../../../../core/auth/token.util.js';
import {
    RESTAURANT_PERMISSIONS,
    hasRestaurantPermission,
    isEmployee,
    redactPayoutDetails,
    sanitizeRestaurantPermissions,
} from '../../../../core/auth/restaurantPermissions.js';

/**
 * Restaurant staff: roles (a name and permission keys) and employees who sign
 * in to the restaurant panel with email or phone + password, like the old
 * store panel's Employee Role and Employees.
 *
 * Every read names its columns, because the default would include `password`.
 * Every write is scoped to the caller's restaurant (`restaurantId` comes from
 * the token, never the body), and staff who manage staff can hand out only
 * the permissions they hold themselves.
 */
const EMPLOYEE_SELECT = {
    id: true, restaurantId: true, roleId: true, firstName: true, lastName: true, email: true, phone: true,
    image: true, isActive: true, lastLoginAt: true, createdAt: true, updatedAt: true,
    role: { select: { id: true, name: true, permissions: true } },
};
const ROLE_SELECT = { id: true, name: true, permissions: true, createdAt: true, updatedAt: true };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 6;

export const toEmail = (value) => String(value || '').trim().toLowerCase();
export const phoneDigits = (value) => String(value || '').replace(/\D/g, '');
export const last10 = (value) => phoneDigits(value).slice(-10);

const clean = (value, max = 100) => String(value ?? '').trim().slice(0, max);

const toEmployee = (row) => {
    if (!row) return row;
    const { role, ...rest } = row;
    return {
        ...rest,
        name: `${row.firstName} ${row.lastName}`.trim(),
        role: role ? { id: role.id, name: role.name, permissions: sanitizeRestaurantPermissions(role.permissions) } : null,
    };
};

/** Staff may only hand out keys they hold; owners hold every key. */
const assertGrantable = (actor, permissions) => {
    if (!isEmployee(actor)) return;
    const missing = permissions.filter((key) => !hasRestaurantPermission(actor, key));
    if (missing.length) {
        throw new ForbiddenError(`You cannot give permissions your own role does not have: ${missing.join(', ')}`);
    }
};

const restaurantOf = (actor) => {
    const id = actor?.userId;
    if (!isId(id)) throw new AuthError('Restaurant not found');
    return String(id);
};

// ─── Roles ──────────────────────────────────────────────────────────────────

export const listPermissionCatalog = () => RESTAURANT_PERMISSIONS;

export async function listRoles(actor) {
    const restaurantId = restaurantOf(actor);
    const rows = await prisma.foodRestaurantRole.findMany({
        where: { restaurantId },
        select: { ...ROLE_SELECT, _count: { select: { employees: true } } },
        orderBy: { createdAt: 'desc' },
    });
    return rows.map(({ _count, ...role }) => ({
        ...role,
        permissions: sanitizeRestaurantPermissions(role.permissions),
        employeeCount: _count?.employees || 0,
    }));
}

const roleInput = (body = {}, { partial = false } = {}) => {
    const data = {};
    if (!partial || body.name !== undefined) {
        const name = clean(body.name, 60);
        if (!name) throw new ValidationError('Role name is required');
        data.name = name;
    }
    if (!partial || body.permissions !== undefined) {
        const permissions = sanitizeRestaurantPermissions(body.permissions);
        if (!permissions.length) throw new ValidationError('Choose at least one permission for the role');
        data.permissions = permissions;
    }
    return data;
};

const duplicateName = (error) => {
    if (error?.code === 'P2002') throw new ValidationError('A role with this name already exists');
    throw error;
};

export async function createRole(actor, body) {
    const restaurantId = restaurantOf(actor);
    const data = roleInput(body);
    assertGrantable(actor, data.permissions);
    return prisma.foodRestaurantRole
        .create({ data: { ...data, restaurantId }, select: ROLE_SELECT })
        .catch(duplicateName);
}

const findOwnRole = async (restaurantId, id) => {
    if (!isId(id)) throw new ValidationError('Invalid role id');
    const role = await prisma.foodRestaurantRole.findFirst({ where: { id: String(id), restaurantId }, select: ROLE_SELECT });
    if (!role) throw new NotFoundError('Role not found');
    return role;
};

export async function updateRole(actor, id, body) {
    const restaurantId = restaurantOf(actor);
    const role = await findOwnRole(restaurantId, id);
    const data = roleInput(body, { partial: true });
    // Neither the new keys nor the ones being taken away may be beyond the
    // editor's own: staff cannot widen or narrow access they do not have.
    assertGrantable(actor, [...new Set([...(data.permissions || []), ...sanitizeRestaurantPermissions(role.permissions)])]);
    return prisma.foodRestaurantRole
        .update({ where: { id: role.id }, data, select: ROLE_SELECT })
        .catch(duplicateName);
}

export async function deleteRole(actor, id) {
    const restaurantId = restaurantOf(actor);
    const role = await findOwnRole(restaurantId, id);
    assertGrantable(actor, sanitizeRestaurantPermissions(role.permissions));
    const inUse = await prisma.foodRestaurantEmployee.count({ where: { roleId: role.id } });
    if (inUse) throw new ValidationError(`${inUse} employee(s) are on this role; move them to another role first`);
    await prisma.foodRestaurantRole.delete({ where: { id: role.id } });
    return { id: role.id };
}

// ─── Employees ──────────────────────────────────────────────────────────────

export async function listEmployees(actor, query = {}) {
    const restaurantId = restaurantOf(actor);
    const where = { restaurantId };
    const search = clean(query.search, 100);
    if (search) {
        const contains = { contains: search, mode: 'insensitive' };
        where.OR = [{ firstName: contains }, { lastName: contains }, { email: contains }, { phone: contains }];
    }
    if (isId(query.roleId)) where.roleId = String(query.roleId);
    const rows = await prisma.foodRestaurantEmployee.findMany({ where, select: EMPLOYEE_SELECT, orderBy: { createdAt: 'desc' } });
    return rows.map(toEmployee);
}

const findOwnEmployee = async (restaurantId, id) => {
    if (!isId(id)) throw new ValidationError('Invalid employee id');
    const row = await prisma.foodRestaurantEmployee.findFirst({ where: { id: String(id), restaurantId }, select: EMPLOYEE_SELECT });
    if (!row) throw new NotFoundError('Employee not found');
    return row;
};

export async function getEmployee(actor, id) {
    return toEmployee(await findOwnEmployee(restaurantOf(actor), id));
}

const employeeInput = async (restaurantId, actor, body = {}, { partial = false } = {}) => {
    const data = {};
    const has = (key) => !partial || body[key] !== undefined;

    if (has('firstName')) {
        data.firstName = clean(body.firstName ?? body.f_name, 100);
        if (!data.firstName) throw new ValidationError('First name is required');
    }
    if (has('lastName')) data.lastName = clean(body.lastName ?? body.l_name, 100);
    if (has('email')) {
        data.email = toEmail(body.email);
        if (!EMAIL_RE.test(data.email)) throw new ValidationError('Enter a valid email address');
    }
    if (has('phone')) {
        const digits = phoneDigits(body.phone);
        if (digits.length < 10 || digits.length > 15) throw new ValidationError('Enter a valid phone number');
        data.phone = clean(body.phone, 20);
        data.phoneLast10 = digits.slice(-10);
    }
    if (body.image !== undefined) data.image = clean(body.image, 1000);
    if (body.isActive !== undefined) data.isActive = body.isActive === true || body.isActive === 'true';
    if (has('roleId')) {
        if (!isId(body.roleId)) throw new ValidationError('Choose a role');
        const role = await findOwnRole(restaurantId, body.roleId);
        assertGrantable(actor, sanitizeRestaurantPermissions(role.permissions));
        data.roleId = role.id;
    }
    // A password is required when creating; on edit, blank keeps the current one.
    const password = String(body.password ?? '');
    if (!partial || password) {
        if (password.length < MIN_PASSWORD) throw new ValidationError(`Password must be at least ${MIN_PASSWORD} characters`);
        data.password = await hashPassword(password);
    }
    return data;
};

const duplicateEmail = (error) => {
    if (error?.code === 'P2002') throw new ValidationError('An employee with this email already exists');
    throw error;
};

/** One phone signs in to one account: refuse a number another employee has. */
const assertPhoneFree = async (phoneLast10, exceptId = null) => {
    if (!phoneLast10) return;
    const clash = await prisma.foodRestaurantEmployee.findFirst({
        where: { phoneLast10, ...(exceptId ? { NOT: { id: exceptId } } : {}) },
        select: { id: true },
    });
    if (clash) throw new ValidationError('An employee with this phone number already exists');
};

export async function createEmployee(actor, body) {
    const restaurantId = restaurantOf(actor);
    const data = await employeeInput(restaurantId, actor, body);
    await assertPhoneFree(data.phoneLast10);
    const row = await prisma.foodRestaurantEmployee
        .create({ data: { ...data, restaurantId }, select: EMPLOYEE_SELECT })
        .catch(duplicateEmail);
    return toEmployee(row);
}

/** The employee being changed must be within the editor's own access too. */
const assertCanManage = (actor, employee) => {
    if (!isEmployee(actor)) return;
    if (employee.id === actor.employeeId) throw new ForbiddenError('Ask the restaurant owner to change your own account');
    assertGrantable(actor, sanitizeRestaurantPermissions(employee.role?.permissions));
};

export async function updateEmployee(actor, id, body) {
    const restaurantId = restaurantOf(actor);
    const existing = await findOwnEmployee(restaurantId, id);
    assertCanManage(actor, existing);
    const data = await employeeInput(restaurantId, actor, body, { partial: true });
    if (data.phoneLast10 !== undefined) await assertPhoneFree(data.phoneLast10, existing.id);
    // A new password or a deactivation signs the employee out everywhere.
    if (data.password || data.isActive === false) data.tokenVersion = { increment: 1 };
    const row = await prisma.foodRestaurantEmployee
        .update({ where: { id: existing.id }, data, select: EMPLOYEE_SELECT })
        .catch(duplicateEmail);
    return toEmployee(row);
}

export async function setEmployeeStatus(actor, id, isActive) {
    return updateEmployee(actor, id, { isActive: isActive === true || isActive === 'true' });
}

export async function deleteEmployee(actor, id) {
    const restaurantId = restaurantOf(actor);
    const existing = await findOwnEmployee(restaurantId, id);
    assertCanManage(actor, existing);
    await prisma.foodRestaurantEmployee.delete({ where: { id: existing.id } });
    await prisma.foodRefreshToken.deleteMany({ where: { userId: existing.id } }).catch(() => {});
    return { id: existing.id };
}

/** For the admin's restaurant details page. */
export const countRestaurantEmployees = async (restaurantId) => {
    if (!isId(restaurantId)) return { employees: 0, active: 0, roles: 0 };
    const [employees, active, roles] = await Promise.all([
        prisma.foodRestaurantEmployee.count({ where: { restaurantId: String(restaurantId) } }),
        prisma.foodRestaurantEmployee.count({ where: { restaurantId: String(restaurantId), isActive: true } }),
        prisma.foodRestaurantRole.count({ where: { restaurantId: String(restaurantId) } }),
    ]);
    return { employees, active, roles };
};

// ─── Sign-in ────────────────────────────────────────────────────────────────

/** The access-token payload for an employee session. */
export const employeeTokenPayload = (employee, tokenVersion) => ({
    userId: employee.restaurantId,
    role: 'RESTAURANT',
    employeeId: employee.id,
    permissions: sanitizeRestaurantPermissions(employee.role?.permissions),
    tokenVersion,
});

const findSignInCandidates = async ({ email, phone, identifier }) => {
    const id = String(identifier ?? '').trim();
    const byEmail = toEmail(email) || (id.includes('@') ? toEmail(id) : '');
    if (byEmail) {
        const row = await prisma.foodRestaurantEmployee.findUnique({
            where: { email: byEmail },
            include: { role: { select: { permissions: true, name: true } } },
        });
        return row ? [row] : [];
    }
    const digits = last10(phone || id);
    if (digits.length !== 10) return [];
    return prisma.foodRestaurantEmployee.findMany({
        where: { phoneLast10: digits },
        include: { role: { select: { permissions: true, name: true } } },
        take: 5,
    });
};

const assertRestaurantOpenToStaff = async (restaurantId) => {
    const restaurant = await prisma.foodRestaurant.findUnique({
        where: { id: restaurantId },
        select: { id: true, status: true, approvedAt: true },
    });
    if (!restaurant) throw new AuthError('Invalid credentials');
    if (restaurant.status === 'rejected') throw new AuthError('This restaurant is not active. Please contact the owner.');
    if (restaurant.status !== 'approved' && !restaurant.approvedAt) {
        throw new AuthError('Your restaurant registration is pending approval.');
    }
    return restaurant;
};

/**
 * POST /food/auth/restaurant-employee/login. Email or phone + password.
 * Returns the same shape as the owner's OTP login, plus `employee`.
 */
export async function loginRestaurantEmployee(body = {}) {
    const password = String(body.password ?? '');
    if (!password) throw new ValidationError('Password is required');
    if (!body.email && !body.phone && !body.identifier) throw new ValidationError('Email or phone is required');

    const candidates = await findSignInCandidates(body);
    let employee = null;
    for (const row of candidates) {
        if (await comparePassword(password, row.password)) {
            employee = row;
            break;
        }
    }
    if (!employee) throw new AuthError('Invalid credentials');
    if (!employee.isActive) throw new AuthError('Your employee account is deactivated. Please contact the restaurant owner.');
    await assertRestaurantOpenToStaff(employee.restaurantId);

    const updated = await prisma.foodRestaurantEmployee.update({
        where: { id: employee.id },
        data: { tokenVersion: { increment: 1 }, lastLoginAt: new Date() },
        select: { tokenVersion: true },
    });
    const payload = employeeTokenPayload(employee, Number(updated.tokenVersion) || 0);
    const accessToken = signAccessToken(payload);
    const refreshToken = signRefreshToken(payload);
    await prisma.foodRefreshToken.create({
        data: {
            userId: employee.id,
            token: refreshToken,
            expiresAt: new Date(Date.now() + ms(config.jwtRefreshExpiresIn || '7d')),
        },
    });

    const restaurant = await prisma.foodRestaurant.findUnique({
        where: { id: employee.restaurantId },
        select: {
            id: true, restaurantName: true, ownerName: true, ownerPhone: true, ownerEmail: true, profileImage: true,
            status: true, approvedAt: true, zoneId: true, isAcceptingOrders: true,
        },
    });
    const employeeView = {
        id: employee.id,
        firstName: employee.firstName,
        lastName: employee.lastName,
        name: `${employee.firstName} ${employee.lastName}`.trim(),
        email: employee.email,
        phone: employee.phone,
        image: employee.image,
        roleName: employee.role?.name || '',
        permissions: payload.permissions,
    };
    return {
        accessToken,
        refreshToken,
        user: { ...redactPayoutDetails(restaurant), name: restaurant?.restaurantName || '', employee: employeeView },
        employee: employeeView,
        needsRegistration: false,
    };
}

/** The employee as /auth/me shows them, or null. */
export async function getEmployeeProfile(employeeId) {
    if (!isId(employeeId)) return null;
    const row = await prisma.foodRestaurantEmployee.findUnique({ where: { id: String(employeeId) }, select: EMPLOYEE_SELECT });
    if (!row) return null;
    const view = toEmployee(row);
    return { ...view, roleName: view.role?.name || '', permissions: view.role?.permissions || [] };
}

/**
 * Refresh for an employee session: the employee must still be active and on
 * the same session; the new access token carries their role as it is now.
 */
export async function refreshEmployeeAccessToken(payload) {
    if (!isId(payload?.employeeId)) throw new AuthError('Invalid refresh token');
    const employee = await prisma.foodRestaurantEmployee.findUnique({
        where: { id: String(payload.employeeId) },
        include: { role: { select: { permissions: true } } },
    });
    if (!employee || employee.restaurantId !== String(payload.userId)) throw new AuthError('Invalid refresh token');
    if (!employee.isActive) throw new AuthError('Your employee account is deactivated');
    const stored = Number(employee.tokenVersion) || 0;
    if (payload.tokenVersion !== undefined && Number(payload.tokenVersion) !== stored) {
        throw new AuthError('You have been signed out because this account was used on another device');
    }
    return signAccessToken(employeeTokenPayload(employee, stored));
}
