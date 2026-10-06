import { prisma } from '../../config/prisma.js';
import { queueEmail } from './transactionalEmail.js';

/**
 * One function per business event that sends an email. Each is a one-line
 * call at the event's service point, made after the write has committed; each
 * returns at once and never throws (see transactionalEmail.js).
 *
 * Event keys decide what counts as "the same email":
 *  - something that happens once per row (a sign-up, a withdrawal decision, a
 *    refund decision, a wallet credit, an order) is keyed by that row's id;
 *  - a state that can flip back and forth (approved/rejected, suspended/active)
 *    is keyed by the row's updatedAt *before* the change, so two admins making
 *    the same change from the same state send one email, and a later genuine
 *    change sends another.
 */

const at = (date) => (date ? new Date(date).getTime() : 0);
const rupees = (value) => {
    const n = Number(value) || 0;
    return Number.isInteger(n) ? String(n) : n.toFixed(2);
};

const ACCOUNT_TYPES = { restaurant: 'restaurant', rider: 'delivery partner', customer: 'customer' };

// ─── Sign-ups (to admin) ─────────────────────────────────────────────────────

export const emailNewRestaurantRegistration = (restaurantId) =>
    queueEmail(async () => {
        const r = await prisma.foodRestaurant.findUnique({
            where: { id: String(restaurantId) },
            select: { id: true, restaurantName: true, ownerName: true, ownerPhone: true, ownerEmail: true },
        });
        if (!r) return null;
        return {
            template: 'admin_new_restaurant',
            eventKey: `admin_new_restaurant:${r.id}`,
            to: 'admins',
            values: { restaurantName: r.restaurantName, ownerName: r.ownerName, phone: r.ownerPhone || '', email: r.ownerEmail || '' },
        };
    });

export const emailNewDeliveryPartnerRegistration = (partnerId) =>
    queueEmail(async () => {
        const p = await prisma.foodDeliveryPartner.findUnique({
            where: { id: String(partnerId) },
            select: { id: true, name: true, phone: true, email: true },
        });
        if (!p) return null;
        return {
            template: 'admin_new_delivery_partner',
            eventKey: `admin_new_delivery_partner:${p.id}`,
            to: 'admins',
            values: { riderName: p.name, phone: p.phone || '', email: p.email || '' },
        };
    });

// ─── Registration decisions ──────────────────────────────────────────────────

/** `before` is the restaurant row as it was before the decision. */
export const emailRestaurantDecision = (before, approved, reason = '') =>
    queueEmail(async () => {
        if (!before?.id) return null;
        const r = await prisma.foodRestaurant.findUnique({
            where: { id: before.id },
            select: { id: true, restaurantName: true, ownerName: true, ownerEmail: true },
        });
        if (!r) return null;
        const template = approved ? 'restaurant_approved' : 'restaurant_rejected';
        return {
            template,
            eventKey: `${template}:${r.id}:${at(before.updatedAt)}`,
            to: r.ownerEmail,
            values: { userName: r.ownerName, restaurantName: r.restaurantName, reason: reason || 'Not given' },
        };
    });

export const emailDeliveryPartnerDecision = (before, approved, reason = '') =>
    queueEmail(async () => {
        if (!before?.id) return null;
        const p = await prisma.foodDeliveryPartner.findUnique({
            where: { id: before.id },
            select: { id: true, name: true, email: true },
        });
        if (!p) return null;
        const template = approved ? 'delivery_partner_approved' : 'delivery_partner_rejected';
        return {
            template,
            eventKey: `${template}:${p.id}:${at(before.updatedAt)}`,
            to: p.email,
            values: { userName: p.name, reason: reason || 'Not given' },
        };
    });

// ─── Suspension ──────────────────────────────────────────────────────────────

const ACCOUNT_LOOKUP = {
    restaurant: async (id) => {
        const r = await prisma.foodRestaurant.findUnique({ where: { id }, select: { ownerName: true, restaurantName: true, ownerEmail: true } });
        return r && { name: r.ownerName || r.restaurantName, email: r.ownerEmail };
    },
    rider: async (id) => {
        const p = await prisma.foodDeliveryPartner.findUnique({ where: { id }, select: { name: true, email: true } });
        return p && { name: p.name, email: p.email };
    },
    customer: async (id) => {
        const u = await prisma.foodUser.findUnique({ where: { id }, select: { name: true, email: true } });
        return u && { name: u.name || 'there', email: u.email };
    },
};

/** kind: 'restaurant' | 'rider' | 'customer'; `before` as it was before the change. */
export const emailAccountSuspension = (kind, before, suspended) =>
    queueEmail(async () => {
        if (!before?.id || !ACCOUNT_LOOKUP[kind]) return null;
        const account = await ACCOUNT_LOOKUP[kind](before.id);
        if (!account) return null;
        const template = suspended ? 'account_suspended' : 'account_unsuspended';
        return {
            template,
            eventKey: `${template}:${kind}:${before.id}:${at(before.updatedAt)}`,
            to: account.email,
            values: { userName: account.name, accountType: ACCOUNT_TYPES[kind] },
        };
    });

// ─── Withdrawals ─────────────────────────────────────────────────────────────

/**
 * kind: 'restaurant' | 'rider'. One email per withdrawal decision.
 * `processedAt` narrows a batch to the lines this call decided.
 */
export const emailWithdrawalDecision = (kind, withdrawalIds, { processedAt } = {}) =>
    queueEmail(async () => {
        const ids = (Array.isArray(withdrawalIds) ? withdrawalIds : [withdrawalIds]).filter(Boolean).map(String);
        if (!ids.length) return null;
        const where = { id: { in: ids }, status: { in: ['approved', 'rejected'] }, ...(processedAt ? { processedAt } : {}) };
        const rows = kind === 'rider'
            ? (await prisma.foodDeliveryWithdrawal.findMany({
                where,
                include: { deliveryPartner: { select: { name: true, email: true } } },
            })).map((w) => ({ w, name: w.deliveryPartner?.name, email: w.deliveryPartner?.email }))
            : (await prisma.foodRestaurantWithdrawal.findMany({
                where,
                include: { restaurant: { select: { ownerName: true, restaurantName: true, ownerEmail: true } } },
            })).map((w) => ({ w, name: w.restaurant?.ownerName || w.restaurant?.restaurantName, email: w.restaurant?.ownerEmail }));
        return rows.map(({ w, name, email }) => {
            const template = w.status === 'approved' ? 'withdraw_approved' : 'withdraw_rejected';
            return {
                template,
                eventKey: `withdraw_decided:${kind}:${w.id}`,
                to: email,
                values: {
                    userName: name || '',
                    amount: rupees(w.amount),
                    transactionId: w.transactionId || '-',
                    reason: w.rejectionReason || w.adminNote || 'Not given',
                },
            };
        });
    });

// ─── Customer ────────────────────────────────────────────────────────────────

export const emailRefundDecision = (refundRequestId) =>
    queueEmail(async () => {
        const r = await prisma.foodRefundRequest.findUnique({
            where: { id: String(refundRequestId) },
            include: { order: { select: { id: true, order_id: true } }, user: { select: { name: true, email: true } } },
        });
        if (!r || !['refunded', 'rejected'].includes(r.status)) return null;
        const approved = r.status === 'refunded';
        return {
            template: approved ? 'refund_approved' : 'refund_rejected',
            eventKey: `refund_decided:${r.id}`,
            to: r.user?.email,
            values: {
                userName: r.user?.name || 'there',
                orderId: r.order?.order_id || r.order?.id || '',
                amount: rupees(r.refundedAmount),
                reason: r.adminNote || 'Not given',
            },
        };
    });

export const emailWalletCredited = (userId, transactionId, amount, balance) =>
    queueEmail(async () => {
        const u = await prisma.foodUser.findUnique({ where: { id: String(userId) }, select: { name: true, email: true } });
        if (!u || !transactionId) return null;
        return {
            template: 'wallet_credited',
            eventKey: `wallet_credited:${transactionId}`,
            to: u.email,
            values: { userName: u.name || 'there', amount: rupees(amount), balance: rupees(balance) },
        };
    });

/**
 * Order placed, to the customer if they have an email. Accepts the row id or
 * the display id; an online order still waiting for its payment is skipped
 * (payment verification calls this again once it is paid).
 */
export const emailOrderPlaced = (orderRef) =>
    queueEmail(async () => {
        const ref = String(orderRef || '');
        if (!ref) return null;
        const order = await prisma.foodOrder.findFirst({
            where: { OR: [{ id: ref }, { order_id: ref }] },
            select: {
                id: true, order_id: true, total: true, orderStatus: true,
                user: { select: { name: true, email: true } },
                restaurant: { select: { restaurantName: true } },
            },
        });
        if (!order || order.orderStatus === 'pending_payment') return null;
        return {
            template: 'order_placed',
            eventKey: `order_placed:${order.id}`,
            to: order.user?.email,
            values: {
                userName: order.user?.name || 'there',
                orderId: order.order_id || order.id,
                restaurantName: order.restaurant?.restaurantName || '',
                amount: rupees(order.total),
            },
        };
    });
