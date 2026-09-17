import { prisma } from '../../../../config/prisma.js';
import { ValidationError } from '../../../../core/auth/errors.js';

/**
 * The cash a rider is holding for the company, and what the cash limit lets
 * them do about it. The one place that answers either question.
 *
 * Cash in hand is worked out, never stored: cash orders the rider delivered,
 * less the deposits that have cleared (their own online payments and whatever
 * an admin recorded collecting). The wallet row's `cashInHand` column was read
 * by the accept check and by dispatch, but nothing ever increased it when a
 * cash order was delivered -- so the limit never refused anybody.
 *
 * The rules follow the previous system, which ran the business:
 *
 *   - A cash order is refused when what the rider holds PLUS that order would
 *     reach the limit. Checking only what they already held let one large order
 *     carry a rider far past it.
 *   - At 90% of the limit the rider is warned.
 *   - A rider at or over the limit is suspended: offered nothing, able to accept
 *     nothing, unable to go online. It lifts by itself as soon as a deposit or
 *     an admin collection brings them back under -- nobody has to remember to
 *     unsuspend them.
 *
 * A limit of 0 means no limit, and none of this applies.
 */

/** The share of the limit at which the rider is warned. */
export const CASH_WARNING_SHARE = 0.9;

const money = (value) => Math.round((Number(value) || 0) * 100) / 100;

/** The active cash limit in rupees; 0 when none is set. */
export async function getCashLimit() {
    const settings = await prisma.foodDeliveryCashLimit.findFirst({
        where: { isActive: true },
        orderBy: { createdAt: 'desc' },
        select: { deliveryCashLimit: true },
    });
    const limit = Number(settings?.deliveryCashLimit);
    return Number.isFinite(limit) && limit > 0 ? limit : 0;
}

/**
 * Cash in hand for several riders at once.
 *
 * @param {string[]} partnerIds
 * @returns {Promise<Map<string, number>>} every id requested, 0 when none
 */
export async function getCashInHandMap(partnerIds = []) {
    const ids = [...new Set(partnerIds.map(String))];
    const result = new Map(ids.map((id) => [id, 0]));
    if (!ids.length) return result;

    const [collected, deposited] = await Promise.all([
        prisma.foodOrder.groupBy({
            by: ['dispatchDeliveryPartnerId'],
            where: { dispatchDeliveryPartnerId: { in: ids }, orderStatus: 'delivered', paymentMethod: 'cash' },
            _sum: { total: true },
        }),
        prisma.foodDeliveryCashDeposit.groupBy({
            by: ['deliveryPartnerId'],
            where: { deliveryPartnerId: { in: ids }, status: 'Completed' },
            _sum: { amount: true },
        }),
    ]);

    for (const row of collected) {
        result.set(String(row.dispatchDeliveryPartnerId), Number(row._sum.total) || 0);
    }
    for (const row of deposited) {
        const id = String(row.deliveryPartnerId);
        result.set(id, (result.get(id) || 0) - (Number(row._sum.amount) || 0));
    }
    // A rider who handed in more than they collected (an advance deposit) holds
    // nothing, not a negative amount.
    for (const [id, cash] of result) result.set(id, money(Math.max(0, cash)));
    return result;
}

/** Where one amount of cash stands against a limit. */
export function describeCashPosition(cashInHand, limit) {
    const cash = money(cashInHand);
    if (!(limit > 0)) {
        return {
            cashInHand: cash,
            cashLimit: 0,
            availableCashLimit: 0,
            cashWarningAt: 0,
            cashLimitWarning: false,
            cashSuspended: false,
        };
    }
    const warningAt = money(limit * CASH_WARNING_SHARE);
    return {
        cashInHand: cash,
        cashLimit: limit,
        availableCashLimit: money(Math.max(0, limit - cash)),
        cashWarningAt: warningAt,
        cashLimitWarning: cash >= warningAt,
        cashSuspended: cash >= limit,
    };
}

/** One rider's cash position: what they hold, the limit, warning and suspension. */
export async function getRiderCashStatus(partnerId) {
    const [limit, cashMap] = await Promise.all([getCashLimit(), getCashInHandMap([partnerId])]);
    return describeCashPosition(cashMap.get(String(partnerId)) || 0, limit);
}

/** Orders the rider collects money for at the door. */
export function orderCollectsCash(order) {
    const method = String(order?.payment?.method || order?.paymentMethod || '').toLowerCase();
    return method === 'cash' || method === 'razorpay_qr';
}

const orderAmount = (order) => Number(order?.pricing?.total ?? order?.total) || 0;

/**
 * Why a rider in this position may not take this order, or null if they may.
 * Pure, so dispatch and the accept check cannot drift apart.
 */
export function cashRefusalReason(position, order) {
    if (!position.cashLimit) return null;
    const limit = position.cashLimit;
    if (position.cashSuspended) {
        return (
            `You are holding Rs.${position.cashInHand} in cash, at or over your Rs.${limit} limit, ` +
            'so you are suspended from taking orders. Deposit your cash to continue.'
        );
    }
    if (orderCollectsCash(order) && position.cashInHand + orderAmount(order) >= limit) {
        return (
            `This Rs.${money(orderAmount(order))} cash order would take you to your Rs.${limit} cash limit ` +
            `(you hold Rs.${position.cashInHand}). Deposit your cash to take cash orders.`
        );
    }
    return null;
}

/** Refuses an order the rider's cash position does not allow. */
export async function assertRiderCanTakeOrder(partnerId, order) {
    const reason = cashRefusalReason(await getRiderCashStatus(partnerId), order);
    if (reason) throw new ValidationError(reason);
}

/**
 * Riders dispatch must not offer this order to.
 *
 * @returns {Promise<Set<string>>}
 */
export async function getCashBlockedPartnerIds(partnerIds, order) {
    if (!partnerIds.length) return new Set();
    const limit = await getCashLimit();
    if (!limit) return new Set();
    const cashMap = await getCashInHandMap(partnerIds);
    const blocked = new Set();
    for (const [id, cash] of cashMap) {
        if (cashRefusalReason(describeCashPosition(cash, limit), order)) blocked.add(id);
    }
    return blocked;
}

/** Refuses going online while suspended for cash. */
export async function assertRiderMayGoOnline(partnerId) {
    const position = await getRiderCashStatus(partnerId);
    if (position.cashSuspended) {
        throw new ValidationError(
            `You are holding Rs.${position.cashInHand} in cash, at or over your Rs.${position.cashLimit} limit. ` +
                'Deposit your cash to go online.',
        );
    }
}

export const CASH_COLLECTION_METHODS = ['cash', 'upi', 'bank_transfer', 'razorpay'];

/**
 * An admin recording cash a rider handed over -- in person, by UPI, or by bank
 * transfer. Recorded as a completed deposit, which is what lowers cash in hand,
 * so it lifts a suspension the moment it brings the rider under the limit.
 */
export async function recordCashCollection({ deliveryPartnerId, amount, method, note } = {}, adminId = null) {
    const partnerId = String(deliveryPartnerId || '');
    const partner = partnerId
        ? await prisma.foodDeliveryPartner.findUnique({ where: { id: partnerId }, select: { id: true } })
        : null;
    if (!partner) throw new ValidationError('Delivery partner not found');

    const value = money(amount);
    if (!(value >= 1)) throw new ValidationError('Amount must be at least Rs.1');
    const paymentMethod = String(method || 'cash');
    if (!CASH_COLLECTION_METHODS.includes(paymentMethod)) {
        throw new ValidationError(`Method must be one of: ${CASH_COLLECTION_METHODS.join(', ')}`);
    }

    // Serialised per rider, so two admins recording the same handover at once
    // cannot both pass the check below and clear more than the rider held.
    return prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`rider-cash:${partnerId}`}))`;
        const cashMap = await getCashInHandMap([partnerId]);
        const inHand = cashMap.get(partnerId) || 0;
        if (value > inHand) {
            throw new ValidationError(`Amount cannot be more than the Rs.${inHand} this rider is holding`);
        }
        return tx.foodDeliveryCashDeposit.create({
            data: {
                deliveryPartnerId: partnerId,
                amount: value,
                paymentMethod,
                status: 'Completed',
                adminId: adminId ? String(adminId) : null,
                adminNote: String(note || '').trim() || null,
            },
        });
    });
}
