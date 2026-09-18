import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { ValidationError } from '../../../../core/auth/errors.js';

/**
 * The reasons offered when an order is cancelled. Kept per who is cancelling --
 * the admin, a restaurant, a customer or a rider -- because what makes sense
 * to each differs ("Shop is closed" is a restaurant's reason, not a customer's).
 */

export const CANCEL_REASON_USER_TYPES = ['admin', 'restaurant', 'customer', 'rider'];

const cleanReason = (value) => {
    const reason = String(value ?? '').trim().replace(/\s+/g, ' ');
    if (!reason) throw new ValidationError('Reason is required');
    if (reason.length > 200) throw new ValidationError('Reason must be 200 characters or fewer');
    return reason;
};

const cleanUserType = (value) => {
    const userType = String(value ?? 'admin').trim().toLowerCase();
    if (!CANCEL_REASON_USER_TYPES.includes(userType)) {
        throw new ValidationError(`Who cancels must be one of: ${CANCEL_REASON_USER_TYPES.join(', ')}`);
    }
    return userType;
};

const ORDER = [{ sortOrder: 'asc' }, { createdAt: 'asc' }];

/** Every reason, for the admin list. */
export async function listCancelReasons(query = {}) {
    const where = {};
    if (query.userType && query.userType !== 'all') where.userType = cleanUserType(query.userType);
    return prisma.foodCancelReason.findMany({ where, orderBy: [{ userType: 'asc' }, ...ORDER] });
}

/** Active reasons for one kind of user, as the panels and apps show them. */
export async function listActiveCancelReasons(userType = 'customer') {
    return prisma.foodCancelReason.findMany({
        where: { userType: cleanUserType(userType), isActive: true },
        orderBy: ORDER,
        select: { id: true, reason: true },
    });
}

export async function createCancelReason(body = {}) {
    const userType = cleanUserType(body.userType);
    const last = await prisma.foodCancelReason.findFirst({ where: { userType }, orderBy: { sortOrder: 'desc' } });
    return prisma.foodCancelReason.create({
        data: {
            reason: cleanReason(body.reason),
            userType,
            isActive: body.isActive !== false,
            sortOrder: (last?.sortOrder ?? -1) + 1,
        },
    });
}

export async function updateCancelReason(id, body = {}) {
    if (!isId(id)) throw new ValidationError('Invalid cancel reason');
    const data = {};
    if (body.reason !== undefined) data.reason = cleanReason(body.reason);
    if (body.userType !== undefined) data.userType = cleanUserType(body.userType);
    if (body.isActive !== undefined) data.isActive = body.isActive === true || body.isActive === 'true';
    if (body.sortOrder !== undefined) {
        const sortOrder = Number(body.sortOrder);
        if (!Number.isInteger(sortOrder)) throw new ValidationError('Sort order must be a whole number');
        data.sortOrder = sortOrder;
    }
    const { count } = await prisma.foodCancelReason.updateMany({ where: { id: String(id) }, data });
    if (!count) throw new ValidationError('Cancel reason not found');
    return prisma.foodCancelReason.findUnique({ where: { id: String(id) } });
}

export async function deleteCancelReason(id) {
    if (!isId(id)) throw new ValidationError('Invalid cancel reason');
    const { count } = await prisma.foodCancelReason.deleteMany({ where: { id: String(id) } });
    if (!count) throw new ValidationError('Cancel reason not found');
    return { deleted: true };
}
