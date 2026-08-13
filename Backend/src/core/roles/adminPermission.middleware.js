import { sendError } from '../../utils/response.js';
import { prisma } from '../../config/prisma.js';
import { isId } from '../../utils/helpers.js';

const isSuperAdmin = (admin) =>
    !admin?.adminType || admin?.adminType === 'super_admin' || admin?.isSuperAdmin === true;

const hasAction = (permissions, section, action) => {
    const actions = Array.isArray(permissions?.[section]) ? permissions[section] : [];
    return actions.includes(action);
};

const hydrateAdmin = async (req) => {
    if (req.adminAccess) return req.adminAccess;
    if (!isId(req.user?.userId)) return null;

    const admin = await prisma.foodAdmin.findUnique({
        where: { id: String(req.user.userId) },
        select: { adminType: true, permissions: true, isActive: true, isDeleted: true },
    });
    // Cached on the request so a route guarded by several permission checks
    // still costs one query.
    req.adminAccess = admin;
    return admin;
};

export const requireAdminPermission = (section, action = 'view') => async (req, res, next) => {
    try {
        if (!req.user?.userId || req.user?.role !== 'ADMIN') {
            return sendError(res, 401, 'Not authenticated');
        }

        const admin = await hydrateAdmin(req);
        if (!admin || admin.isDeleted || admin.isActive === false) {
            return sendError(res, 403, 'Admin account is inactive');
        }

        if (isSuperAdmin(admin)) {
            return next();
        }

        if (!hasAction(admin.permissions, section, action)) {
            return sendError(res, 403, 'Forbidden: insufficient permissions');
        }

        return next();
    } catch (_error) {
        return sendError(res, 500, 'Permission check failed');
    }
};

export const requireAnyAdminPermission = (rules = []) => async (req, res, next) => {
    try {
        if (!req.user?.userId || req.user?.role !== 'ADMIN') {
            return sendError(res, 401, 'Not authenticated');
        }

        const admin = await hydrateAdmin(req);
        if (!admin || admin.isDeleted || admin.isActive === false) {
            return sendError(res, 403, 'Admin account is inactive');
        }

        if (isSuperAdmin(admin)) {
            return next();
        }

        const allowed = Array.isArray(rules) && rules.some((rule) => {
            const section = rule?.section;
            const action = rule?.action || 'view';
            if (!section) return false;
            return hasAction(admin.permissions, section, action);
        });

        if (!allowed) {
            return sendError(res, 403, 'Forbidden: insufficient permissions');
        }

        return next();
    } catch (_error) {
        return sendError(res, 500, 'Permission check failed');
    }
};
