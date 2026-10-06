import { prisma } from '../../../../config/prisma.js';
import { logger } from '../../../../utils/logger.js';
import { isId } from '../../../../utils/helpers.js';
import { ValidationError, NotFoundError } from '../../../../core/auth/errors.js';
import { recordTransaction } from '../../../../core/payments/transaction.service.js';
import { saveImageFile } from '../../../../services/storage.service.js';
import { getBusinessSettings } from '../../shared/businessSettings.js';
import { buildOrderIdentityFilter, notifyOwnerSafely } from './order.helpers.js';
import * as foodTransactionService from './foodTransaction.service.js';
import { processRefundAdmin } from './order.service.js';
import { reverseOrderLoyaltyPoints } from '../../user/services/loyaltyPoint.service.js';
import { emailRefundDecision } from '../../../../core/notifications/emailEvents.js';

/**
 * Customer refund requests (the old panel's Refund Requests).
 *
 * A customer asks for a refund on a delivered, paid order; an admin approves
 * (full or part) or rejects it. Approval moves the money through the same path
 * as the admin "Refund" button on an order (processRefundAdmin), so Razorpay
 * refunds, wallet credits, the order's refund columns and the finance record
 * behave exactly as they always have. Two methods that path never handled are
 * paid to the customer's wallet here instead:
 *
 *   - cash on delivery (the cash was collected, there is no card to refund to)
 *   - offline payments the admin verified, and Razorpay QR payments
 *
 * Statuses: pending -> approved (claimed while the money moves) -> refunded,
 * or pending -> rejected (with the admin's note). A failed refund puts the
 * request back to pending with the reason, so the admin can try again.
 */

export const REFUND_REQUEST_STATUSES = ['pending', 'approved', 'refunded', 'rejected'];
const OPEN_STATUSES = ['pending', 'approved'];
const MAX_IMAGES = 3;
const MAX_NOTE = 1000;

const money = (value) => Math.round((Number(value) || 0) * 100) / 100;
const displayId = (order) => order?.order_id || order?.orderId || order?.id;

/** Where an approved refund goes: back to Razorpay, or into the wallet. */
export function refundDestination(paymentMethod) {
    return String(paymentMethod || '').toLowerCase() === 'razorpay' ? 'razorpay' : 'wallet';
}

/** What is still refundable on an order. */
export function refundableAmount(order) {
    if (String(order?.paymentStatus || '') === 'refunded') return 0;
    const already = String(order?.refundStatus || '') === 'processed' ? money(order?.refundAmount) : 0;
    return Math.max(0, money(money(order?.total) - already));
}

/**
 * Whether a customer may ask for a refund on this order now. Pure: the order
 * row, the business_refund settings, the order's requests, and the time.
 * Returns { eligible, message, maxAmount, windowEndsAt }.
 */
export function refundEligibility(order, settings, requests = [], now = new Date()) {
    const no = (message, extra = {}) => ({ eligible: false, message, maxAmount: 0, windowEndsAt: null, ...extra });
    if (!settings?.refundRequestEnabled) return no('Refund requests are not available right now');
    if (!order) return no('Order not found');
    if (order.orderStatus !== 'delivered') return no('You can ask for a refund once the order is delivered');

    if (requests.some((r) => OPEN_STATUSES.includes(r.status))) {
        return no('A refund request for this order is already being reviewed');
    }
    if (requests.some((r) => r.status === 'refunded') || order.paymentStatus === 'refunded') {
        return no('This order has already been refunded');
    }
    if (order.paymentStatus !== 'paid') return no('This order has no payment to refund');

    const hours = Number(settings.requestWindowHours) || 0;
    const deliveredAt = new Date(order.deliveredAt || order.updatedAt || order.createdAt);
    const windowEndsAt = hours > 0 ? new Date(deliveredAt.getTime() + hours * 3600 * 1000) : null;
    if (windowEndsAt && now > windowEndsAt) {
        return no(`Refunds can be requested within ${hours} hour${hours === 1 ? '' : 's'} of delivery`, { windowEndsAt });
    }

    const maxAmount = refundableAmount(order);
    if (maxAmount <= 0) return no('This order has already been refunded');
    return { eligible: true, message: '', maxAmount, windowEndsAt };
}

// ─── serializers ─────────────────────────────────────────────────────────────

export const serializeRefundRequest = (row) => ({
    id: row.id,
    orderId: row.orderId,
    orderDisplayId: row.order?.order_id || row.order?.orderId || row.orderId,
    status: row.status,
    reasonId: row.reasonId || '',
    reason: row.reason,
    note: row.note,
    images: row.images || [],
    requestedAmount: money(row.requestedAmount),
    refundedAmount: row.refundedAmount == null ? null : money(row.refundedAmount),
    refundMethod: row.refundMethod || '',
    adminNote: row.adminNote || '',
    createdAt: row.createdAt,
    decidedAt: row.decidedAt,
    updatedAt: row.updatedAt,
});

const ADMIN_ORDER_SELECT = {
    id: true, order_id: true, orderId: true, total: true, subtotal: true, tax: true, deliveryFee: true,
    platformFee: true, packagingFee: true, discount: true,
    paymentMethod: true, paymentStatus: true, refundStatus: true, refundAmount: true, refundProcessedAt: true,
    orderStatus: true, deliveredAt: true, createdAt: true, customerName: true, customerPhone: true,
    restaurant: { select: { id: true, restaurantName: true, city: true, area: true } },
};

const serializeForAdmin = (row) => ({
    ...serializeRefundRequest(row),
    failureReason: row.failureReason || '',
    decidedById: row.decidedById,
    customer: row.user
        ? { id: row.user.id, name: row.user.name || '', phone: row.user.phone || '', email: row.user.email || '' }
        : null,
    restaurant: row.order?.restaurant
        ? { id: row.order.restaurant.id, name: row.order.restaurant.restaurantName || '', city: row.order.restaurant.city || '' }
        : null,
    order: row.order
        ? {
            id: row.order.id,
            displayId: displayId(row.order),
            total: money(row.order.total),
            paymentMethod: row.order.paymentMethod,
            paymentStatus: row.order.paymentStatus,
            refundStatus: row.order.refundStatus,
            refundAmount: money(row.order.refundAmount),
            orderStatus: row.order.orderStatus,
            deliveredAt: row.order.deliveredAt,
            createdAt: row.order.createdAt,
            refundable: refundableAmount(row.order),
            refundTo: refundDestination(row.order.paymentMethod),
        }
        : null,
});

// ─── customer ────────────────────────────────────────────────────────────────

async function loadOwnOrder(userId, orderRef) {
    if (!isId(userId)) throw new ValidationError('User not found');
    const identity = buildOrderIdentityFilter(orderRef);
    if (!identity) throw new NotFoundError('Order not found');
    const order = await prisma.foodOrder.findFirst({ where: { AND: [identity, { userId: String(userId) }] } });
    if (!order) throw new NotFoundError('Order not found');
    return order;
}

async function resolveReason(body) {
    const settings = await getBusinessSettings('business_refund');
    const reasonId = String(body?.reasonId || '').trim();
    if (reasonId) {
        const match = settings.reasons.find((r) => r.id === reasonId && r.isActive);
        if (!match) throw new ValidationError('Choose a reason from the list');
        return { settings, reasonId, reason: match.text };
    }
    const reason = String(body?.reason || '').trim().slice(0, 200);
    if (!reason) throw new ValidationError('Choose a reason for the refund');
    return { settings, reasonId: '', reason };
}

/**
 * The image type from the file's first bytes. Phones often send photos as
 * application/octet-stream, so the declared type is not trusted either way.
 */
export function sniffImageType(buffer) {
    if (!buffer || buffer.length < 12) return null;
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
    if (buffer.readUInt32BE(0) === 0x89504e47) return 'image/png';
    if (buffer.toString('ascii', 0, 4) === 'GIF8') return 'image/gif';
    if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
    return null;
}

/** Image files from a multipart request (field `images`), stored like every upload. */
export async function storeImages(files, folder) {
    const list = Array.isArray(files) ? files : [];
    if (list.length > MAX_IMAGES) throw new ValidationError(`At most ${MAX_IMAGES} photos`);
    const typed = list.map((file) => ({ file, mimetype: sniffImageType(file?.buffer) }));
    if (typed.some((t) => !t.mimetype)) throw new ValidationError('Photos must be JPEG, PNG, WebP or GIF images');
    const urls = [];
    for (const { file, mimetype } of typed) {
        const saved = await saveImageFile({ buffer: file.buffer, mimetype, originalname: file.originalname || 'photo' }, folder);
        urls.push(saved.url);
    }
    return urls.filter(Boolean);
}

/** The order's refund state for the app: can it ask, how much, and its requests. */
export async function getOrderRefundStatus(userId, orderRef) {
    const order = await loadOwnOrder(userId, orderRef);
    const [settings, requests] = await Promise.all([
        getBusinessSettings('business_refund'),
        prisma.foodRefundRequest.findMany({ where: { orderId: order.id }, orderBy: { createdAt: 'desc' }, include: { order: { select: { order_id: true, orderId: true } } } }),
    ]);
    const eligibility = refundEligibility(order, settings, requests);
    return {
        ...eligibility,
        refundTo: refundDestination(order.paymentMethod),
        request: requests[0] ? serializeRefundRequest(requests[0]) : null,
        requests: requests.map(serializeRefundRequest),
    };
}

export async function createRefundRequest(userId, orderRef, body = {}, files = []) {
    const order = await loadOwnOrder(userId, orderRef);
    const { settings, reasonId, reason } = await resolveReason(body);
    const note = String(body?.note || '').trim();
    if (note.length > MAX_NOTE) throw new ValidationError(`Keep the note under ${MAX_NOTE} characters`);

    const requests = await prisma.foodRefundRequest.findMany({ where: { orderId: order.id }, select: { status: true } });
    const eligibility = refundEligibility(order, settings, requests);
    if (!eligibility.eligible) throw new ValidationError(eligibility.message);

    const images = await storeImages(files, 'food/refund-requests');

    let row;
    try {
        row = await prisma.foodRefundRequest.create({
            data: {
                orderId: order.id,
                userId: order.userId,
                restaurantId: order.restaurantId,
                reasonId,
                reason,
                note,
                images,
                requestedAmount: eligibility.maxAmount,
            },
            include: { order: { select: { order_id: true, orderId: true } } },
        });
    } catch (error) {
        // The partial unique index: another request for this order got in first.
        if (error?.code === 'P2002') throw new ValidationError('A refund request for this order is already being reviewed');
        throw error;
    }
    return serializeRefundRequest(row);
}

export async function listMyRefundRequests(userId, { page = 1, limit = 20, status } = {}) {
    if (!isId(userId)) throw new ValidationError('User not found');
    const take = Math.min(50, Math.max(1, parseInt(limit, 10) || 20));
    const current = Math.max(1, parseInt(page, 10) || 1);
    const where = { userId: String(userId), ...(REFUND_REQUEST_STATUSES.includes(status) ? { status } : {}) };
    const [rows, total] = await Promise.all([
        prisma.foodRefundRequest.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            skip: (current - 1) * take,
            take,
            include: { order: { select: { order_id: true, orderId: true } } },
        }),
        prisma.foodRefundRequest.count({ where }),
    ]);
    return {
        requests: rows.map(serializeRefundRequest),
        pagination: { page: current, limit: take, total, pages: Math.ceil(total / take) },
    };
}

// ─── admin ───────────────────────────────────────────────────────────────────

/** 'YYYY-MM-DD' as the start of that day in India. */
const istDayStart = (value) => {
    const s = String(value || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    const d = new Date(`${s}T00:00:00+05:30`);
    return Number.isNaN(d.getTime()) ? null : d;
};

async function buildAdminWhere(query = {}) {
    const where = {};
    if (REFUND_REQUEST_STATUSES.includes(query.status)) where.status = query.status;
    if (isId(query.restaurantId)) where.restaurantId = String(query.restaurantId);
    const from = istDayStart(query.from);
    const to = istDayStart(query.to);
    if (from || to) {
        where.createdAt = {
            ...(from ? { gte: from } : {}),
            ...(to ? { lt: new Date(to.getTime() + 86400000) } : {}),
        };
    }
    const search = String(query.search || '').trim().slice(0, 80);
    if (search) {
        const contains = { contains: search, mode: 'insensitive' };
        where.OR = [
            { order: { order_id: contains } },
            { order: { orderId: contains } },
            { user: { name: contains } },
            { user: { phone: contains } },
            { reason: contains },
            ...(isId(search) ? [{ id: search }, { orderId: search }] : []),
        ];
    }
    return where;
}

const ADMIN_INCLUDE = {
    order: { select: ADMIN_ORDER_SELECT },
    user: { select: { id: true, name: true, phone: true, email: true } },
};

export async function listRefundRequestsAdmin(query = {}) {
    const take = Math.min(1000, Math.max(1, parseInt(query.limit, 10) || 20));
    const current = Math.max(1, parseInt(query.page, 10) || 1);
    const where = await buildAdminWhere(query);
    const { status: _status, ...withoutStatus } = where;
    const [rows, total, grouped] = await Promise.all([
        prisma.foodRefundRequest.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            skip: (current - 1) * take,
            take,
            include: ADMIN_INCLUDE,
        }),
        prisma.foodRefundRequest.count({ where }),
        prisma.foodRefundRequest.groupBy({ by: ['status'], where: withoutStatus, _count: { _all: true } }),
    ]);
    const counts = Object.fromEntries(REFUND_REQUEST_STATUSES.map((s) => [s, 0]));
    for (const g of grouped) counts[g.status] = g._count._all;
    counts.all = REFUND_REQUEST_STATUSES.reduce((sum, s) => sum + counts[s], 0);
    return {
        requests: rows.map(serializeForAdmin),
        counts,
        pagination: { page: current, limit: take, total, pages: Math.ceil(total / take) },
    };
}

export async function getRefundRequestAdmin(id) {
    if (!isId(id)) throw new NotFoundError('Refund request not found');
    const row = await prisma.foodRefundRequest.findUnique({ where: { id: String(id) }, include: ADMIN_INCLUDE });
    if (!row) throw new NotFoundError('Refund request not found');
    const [items, history] = await Promise.all([
        prisma.orderItem.findMany({ where: { orderId: row.orderId } }),
        prisma.foodRefundRequest.findMany({
            where: { orderId: row.orderId, NOT: { id: row.id } },
            orderBy: { createdAt: 'desc' },
        }),
    ]);
    const o = row.order;
    return {
        ...serializeForAdmin(row),
        order: {
            ...serializeForAdmin(row).order,
            pricing: {
                subtotal: money(o.subtotal), tax: money(o.tax), deliveryFee: money(o.deliveryFee),
                platformFee: money(o.platformFee), packagingFee: money(o.packagingFee), discount: money(o.discount),
                total: money(o.total),
            },
            items: items.map((item) => ({
                name: item.name, quantity: item.quantity, price: money(item.price), variantName: item.variantName || '',
            })),
        },
        otherRequests: history.map(serializeRefundRequest),
    };
}

/** Pay a refund into the customer's wallet: COD, verified offline and QR orders. */
async function refundToWallet(order, request, amount, adminId) {
    await recordTransaction({
        entityType: 'user',
        entityId: order.userId,
        type: 'credit',
        amount,
        description: `Refund for order #${displayId(order)}`,
        category: 'order_refund',
        orderId: order.id,
        // One credit per request, however often the approval is retried.
        idempotencyKey: `refund_request:${request.id}`,
        metadata: { source: 'order_refund', refundRequestId: request.id, paymentMethod: order.paymentMethod },
    });
    await prisma.foodOrder.update({
        where: { id: order.id },
        data: { paymentStatus: 'refunded', refundStatus: 'processed', refundAmount: amount, refundProcessedAt: new Date() },
    });
    try {
        await foodTransactionService.updateTransactionStatus(order.id, order.orderStatus, {
            status: 'refunded',
            note: `Refund of ₹${amount} to the customer's wallet (refund request)`,
            recordedByRole: 'ADMIN',
            recordedById: adminId,
        });
    } catch (err) {
        logger.warn(`Refund request transaction sync failed: ${err?.message || err}`);
    }
    await reverseOrderLoyaltyPoints(order.id);
}

export async function approveRefundRequest(id, adminId, body = {}) {
    if (!isId(id)) throw new NotFoundError('Refund request not found');
    const request = await prisma.foodRefundRequest.findUnique({ where: { id: String(id) } });
    if (!request) throw new NotFoundError('Refund request not found');
    if (request.status !== 'pending') throw new ValidationError(`This request is already ${request.status}`);

    const order = await prisma.foodOrder.findUnique({ where: { id: request.orderId } });
    if (!order) throw new NotFoundError('Order not found');
    const remaining = refundableAmount(order);
    if (remaining <= 0) throw new ValidationError('This order has already been refunded');
    if (order.paymentStatus !== 'paid') throw new ValidationError('This order has no payment to refund');

    const raw = body.amount;
    const amount = raw === undefined || raw === null || raw === ''
        ? Math.min(money(request.requestedAmount), remaining)
        : money(raw);
    if (!Number.isFinite(amount) || amount <= 0) throw new ValidationError('Enter a refund amount above zero');
    if (amount > remaining) throw new ValidationError(`At most ₹${remaining} can be refunded on this order`);
    const note = String(body.note ?? body.adminNote ?? '').trim().slice(0, MAX_NOTE);

    // Claim it: a second admin (or a double click) finds it no longer pending.
    const claimed = await prisma.foodRefundRequest.updateMany({
        where: { id: request.id, status: 'pending' },
        data: { status: 'approved', decidedById: isId(adminId) ? String(adminId) : null },
    });
    if (claimed.count === 0) throw new ValidationError('This request is already being handled');

    const method = refundDestination(order.paymentMethod);
    try {
        const viaOrderRefund = ['razorpay', 'wallet'].includes(String(order.paymentMethod));
        if (viaOrderRefund) {
            await processRefundAdmin(order.id, amount, adminId, { notify: false });
        } else {
            await refundToWallet(order, request, amount, adminId);
        }
    } catch (error) {
        const reason = String(error?.message || error).slice(0, 500);
        await prisma.foodRefundRequest.update({
            where: { id: request.id },
            data: { status: 'pending', failureReason: reason, decidedById: null },
        });
        logger.warn(`Refund request ${request.id} approval failed: ${reason}`);
        throw new ValidationError(`The refund could not be made: ${reason}`);
    }

    const updated = await prisma.foodRefundRequest.update({
        where: { id: request.id },
        data: {
            status: 'refunded',
            refundedAmount: amount,
            refundMethod: method,
            adminNote: note,
            failureReason: '',
            decidedAt: new Date(),
        },
        include: ADMIN_INCLUDE,
    });

    const where = method === 'razorpay'
        ? 'to your original payment method. It may take 5-7 working days to show.'
        : 'to your Lagech wallet.';
    await notifyOwnerSafely({ ownerType: 'USER', ownerId: order.userId }, {
        title: 'Refund approved',
        body: `Your refund of ₹${amount} for order #${displayId(order)} has been sent ${where}`,
        data: {
            type: 'refund_processed',
            orderId: String(displayId(order)),
            orderRowId: order.id,
            refundRequestId: request.id,
        },
    });

    emailRefundDecision(updated.id);
    return serializeForAdmin(updated);
}

export async function rejectRefundRequest(id, adminId, body = {}) {
    if (!isId(id)) throw new NotFoundError('Refund request not found');
    const note = String(body.note ?? body.adminNote ?? '').trim().slice(0, MAX_NOTE);
    if (!note) throw new ValidationError('Say why the refund is rejected; the customer is told');
    const { count } = await prisma.foodRefundRequest.updateMany({
        where: { id: String(id), status: 'pending' },
        data: {
            status: 'rejected',
            adminNote: note,
            decidedById: isId(adminId) ? String(adminId) : null,
            decidedAt: new Date(),
        },
    });
    if (count === 0) {
        const exists = await prisma.foodRefundRequest.findUnique({ where: { id: String(id) }, select: { status: true } });
        if (!exists) throw new NotFoundError('Refund request not found');
        throw new ValidationError(`This request is already ${exists.status}`);
    }
    const updated = await prisma.foodRefundRequest.findUnique({ where: { id: String(id) }, include: ADMIN_INCLUDE });
    await notifyOwnerSafely({ ownerType: 'USER', ownerId: updated.userId }, {
        title: 'Refund request declined',
        body: `Your refund request for order #${displayId(updated.order)} was declined: ${note}`,
        data: {
            type: 'refund_request_rejected',
            orderId: String(displayId(updated.order)),
            orderRowId: updated.orderId,
            refundRequestId: updated.id,
        },
    });
    emailRefundDecision(updated.id);
    return serializeForAdmin(updated);
}
