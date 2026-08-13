import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { sendResponse, sendError } from '../../../../utils/response.js';

export async function createSupportTicketController(req, res, next) {
    try {
        const userId = req.user?.userId;
        const body = req.body || {};
        const type = String(body.type || '').trim();
        const issueType = String(body.issueType || '').trim();
        const description = String(body.description || '').trim();

        if (!['order', 'restaurant', 'other'].includes(type)) {
            return sendError(res, 400, 'Invalid ticket type');
        }
        if (!issueType) return sendError(res, 400, 'issueType required');
        if (!isId(userId)) return sendError(res, 401, 'Unauthorized or invalid user');

        const data = { userId: String(userId), type, issueType, description };

        if (type === 'order') {
            if (!isId(body.orderId)) return sendError(res, 400, 'orderId required');
            data.orderId = String(body.orderId);

            // Link the restaurant automatically so support does not have to
            // look it up from the order later.
            const order = await prisma.foodOrder.findUnique({
                where: { id: data.orderId },
                select: { restaurantId: true },
            });
            if (order?.restaurantId) data.restaurantId = order.restaurantId;
        }

        if (type === 'restaurant') {
            if (!isId(body.restaurantId)) return sendError(res, 400, 'restaurantId required');
            data.restaurantId = String(body.restaurantId);
        }

        const ticket = await prisma.foodSupportTicket.create({ data });
        return sendResponse(res, 201, 'Ticket created', { ticket });
    } catch (e) {
        next(e);
    }
}

export async function listMySupportTicketsController(req, res, next) {
    try {
        const userId = req.user?.userId;
        if (!isId(userId)) return sendError(res, 401, 'Unauthorized or invalid user');

        const limit = Math.min(Math.max(parseInt(req.query?.limit, 10) || 20, 1), 50);
        const page = Math.max(parseInt(req.query?.page, 10) || 1, 1);
        const where = { userId: String(userId) };

        const [tickets, total] = await Promise.all([
            prisma.foodSupportTicket.findMany({
                where,
                orderBy: { createdAt: 'desc' },
                skip: (page - 1) * limit,
                take: limit,
            }),
            prisma.foodSupportTicket.count({ where }),
        ]);

        return sendResponse(res, 200, 'Tickets fetched', { tickets, total, page, limit });
    } catch (e) {
        next(e);
    }
}
