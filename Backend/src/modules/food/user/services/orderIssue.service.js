import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { ValidationError, NotFoundError } from '../../../../core/auth/errors.js';
import { getBusinessSettings } from '../../shared/businessSettings.js';
import { buildOrderIdentityFilter } from '../../orders/services/order.helpers.js';
import { storeImages } from '../../orders/services/refundRequest.service.js';

/**
 * "Report an issue" on an order (the old panel's order-issue messages).
 *
 * A report is a customer support ticket of type 'order' -- the admin answers it
 * on Support Tickets (or the Order Issue Reports view of it), and the customer
 * is pushed when the admin responds, as for every ticket. The report adds the
 * Business Settings reason picked and up to three photos.
 *
 * One open report per order: until the admin resolves it, a second one would
 * only split the conversation.
 */

const MAX_NOTE = 1000;
const toStatusApi = (value) => (String(value) === 'in_progress' ? 'in-progress' : String(value));

export const serializeOrderIssue = (row) => ({
    id: row.id,
    orderId: row.orderId,
    orderDisplayId: row.order?.order_id || row.order?.orderId || row.orderId,
    reasonId: row.reasonId || '',
    reason: row.issueType,
    note: row.description,
    images: row.images || [],
    status: toStatusApi(row.status),
    adminResponse: row.adminResponse || '',
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
});

const ORDER_REF = { order: { select: { order_id: true, orderId: true } } };

async function loadOwnOrder(userId, orderRef) {
    if (!isId(userId)) throw new ValidationError('User not found');
    const identity = buildOrderIdentityFilter(orderRef);
    if (!identity) throw new NotFoundError('Order not found');
    const order = await prisma.foodOrder.findFirst({
        where: { AND: [identity, { userId: String(userId) }] },
        select: { id: true, userId: true, restaurantId: true, orderStatus: true },
    });
    if (!order) throw new NotFoundError('Order not found');
    return order;
}

export async function createOrderIssue(userId, orderRef, body = {}, files = []) {
    const order = await loadOwnOrder(userId, orderRef);
    // An order still waiting for its payment has not been placed yet.
    if (order.orderStatus === 'pending_payment') throw new ValidationError('This order has not been placed yet');

    const { reasons } = await getBusinessSettings('business_order_issue_reasons');
    const reasonId = String(body.reasonId || '').trim();
    let reason;
    if (reasonId) {
        const match = reasons.find((r) => r.id === reasonId && r.isActive);
        if (!match) throw new ValidationError('Choose a reason from the list');
        reason = match.text;
    } else if (!reasons.some((r) => r.isActive)) {
        // No list set up yet: the customer says it in their own words.
        reason = String(body.reason || '').trim().slice(0, 200);
        if (!reason) throw new ValidationError('Say what went wrong');
    } else {
        throw new ValidationError('Choose a reason from the list');
    }
    const note = String(body.note || '').trim();
    if (note.length > MAX_NOTE) throw new ValidationError(`Keep the note under ${MAX_NOTE} characters`);

    const open = await prisma.foodSupportTicket.findFirst({
        where: { orderId: order.id, userId: order.userId, type: 'order', status: { not: 'resolved' } },
        select: { id: true },
    });
    if (open) throw new ValidationError('You have already reported an issue on this order; we will get back to you');

    const images = await storeImages(files, 'food/order-issues');
    const row = await prisma.foodSupportTicket.create({
        data: {
            userId: order.userId,
            type: 'order',
            orderId: order.id,
            restaurantId: order.restaurantId,
            issueType: reason,
            description: note,
            reasonId,
            images,
        },
        include: ORDER_REF,
    });
    return serializeOrderIssue(row);
}

/** The customer's order issue reports, newest first; one order's when `orderRef` is given. */
export async function listMyOrderIssues(userId, { orderRef, page = 1, limit = 20 } = {}) {
    if (!isId(userId)) throw new ValidationError('User not found');
    const where = { userId: String(userId), type: 'order' };
    if (orderRef) where.orderId = (await loadOwnOrder(userId, orderRef)).id;
    const take = Math.min(50, Math.max(1, parseInt(limit, 10) || 20));
    const current = Math.max(1, parseInt(page, 10) || 1);
    const [rows, total] = await Promise.all([
        prisma.foodSupportTicket.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            skip: (current - 1) * take,
            take,
            include: ORDER_REF,
        }),
        prisma.foodSupportTicket.count({ where }),
    ]);
    return {
        issues: rows.map(serializeOrderIssue),
        pagination: { page: current, limit: take, total, pages: Math.ceil(total / take) },
    };
}
