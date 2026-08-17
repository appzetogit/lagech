import { prisma } from '../../../../config/prisma.js';
import { ValidationError } from '../../../../core/auth/errors.js';

/**
 * Support tickets a restaurant raises with the platform.
 *
 * Admin reads these through adminSupportTicket.service.js; this is only the
 * restaurant's own side of them.
 */

const CATEGORIES = ['orders', 'payments', 'menu', 'restaurant', 'technical', 'other'];
const PRIORITIES = ['low', 'medium', 'high'];

// The API speaks 'in-progress'; Prisma's enum name for it is in_progress.
const STATUS_BY_WIRE = { open: 'open', 'in-progress': 'in_progress', resolved: 'resolved' };

export async function createRestaurantSupportTicket(restaurantId, body = {}) {
    const category = String(body.category || '').trim().toLowerCase();
    const priority = String(body.priority || 'medium').trim().toLowerCase();
    const issueType = String(body.issueType || '').trim();

    if (!CATEGORIES.includes(category)) throw new ValidationError('Invalid category');
    if (!issueType) throw new ValidationError('issueType required');
    if (!PRIORITIES.includes(priority)) throw new ValidationError('Invalid priority');

    return prisma.foodRestaurantSupportTicket.create({
        data: {
            restaurantId,
            category,
            issueType,
            priority,
            subject: String(body.subject || '').trim(),
            description: String(body.description || '').trim(),
            orderRef: String(body.orderRef || body.orderId || '').trim(),
        },
    });
}

export async function listRestaurantSupportTickets(restaurantId, query = {}) {
    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 20, 1), 100);
    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    const skip = (page - 1) * limit;

    const where = { restaurantId };

    const status = STATUS_BY_WIRE[String(query.status || '').trim().toLowerCase()];
    if (status) where.status = status;

    const search = String(query.search || '').trim();
    if (search) {
        const contains = { contains: search, mode: 'insensitive' };
        where.OR = [
            { subject: contains },
            { issueType: contains },
            { description: contains },
            { orderRef: contains },
        ];
    }

    const [tickets, total] = await Promise.all([
        prisma.foodRestaurantSupportTicket.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            skip,
            take: limit,
        }),
        prisma.foodRestaurantSupportTicket.count({ where }),
    ]);

    return { tickets, total, page, limit };
}
