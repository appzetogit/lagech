import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { getTransactionByOrder } from './foodTransaction.service.js';
import { ForbiddenError, ValidationError } from '../../../../core/auth/errors.js';

/**
 * List ledger entries for an order (newest first). The user must own the order.
 * Reads from the consolidated FoodTransaction history.
 */
export async function listFoodOrderPaymentsForUser(orderIdParam, userId) {
    const raw = String(orderIdParam || '').trim();
    if (!raw) throw new ValidationError('Order id required');

    const order = await prisma.foodOrder.findFirst({
        where: isId(raw) ? { id: raw } : { orderId: raw },
        select: { id: true, userId: true, orderId: true },
    });
    if (!order) throw new ValidationError('Order not found');
    if (order.userId !== String(userId)) throw new ForbiddenError('Not your order');

    const transaction = await getTransactionByOrder(order.id);
    const rows = transaction?.history || [];

    return {
        orderId: order.orderId,
        orderMongoId: order.id,
        payments: rows.map((r) => ({
            ...r,
            method: transaction.paymentMethod,
            status: transaction.status,
            amount: transaction.amounts?.totalCustomerPaid || 0,
            currency: transaction.currency || 'INR',
        })),
    };
}
