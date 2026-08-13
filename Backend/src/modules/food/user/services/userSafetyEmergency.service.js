import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { ValidationError } from '../../../../core/auth/errors.js';

const requireUser = async (userId) => {
    const id = String(userId || '');
    if (!isId(id)) throw new ValidationError('User not found');

    const user = await prisma.foodUser.findUnique({
        where: { id },
        select: { id: true, name: true, email: true, phone: true },
    });
    if (!user) throw new ValidationError('User not found');
    return user;
};

export const createSafetyEmergencyReport = async (userId, message) => {
    const user = await requireUser(userId);

    const report = await prisma.foodSafetyEmergencyReport.create({
        data: {
            userId: user.id,
            // The contact details are snapshotted, not joined: support needs to
            // reach whoever raised this even if the profile changes afterwards.
            userName: user.name || '',
            userEmail: user.email || '',
            userPhone: user.phone || '',
            message: String(message || '').trim(),
            status: 'unread',
            priority: 'medium',
        },
    });

    return { report };
};

export const listMySafetyEmergencyReports = async (userId, query = {}) => {
    const id = String(userId || '');
    if (!isId(id)) throw new ValidationError('User not found');

    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 20, 1), 100);
    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    const where = { userId: id };

    const [list, total] = await Promise.all([
        prisma.foodSafetyEmergencyReport.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            skip: (page - 1) * limit,
            take: limit,
        }),
        prisma.foodSafetyEmergencyReport.count({ where }),
    ]);

    return {
        safetyEmergencies: list || [],
        pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 },
    };
};
