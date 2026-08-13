import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { getFirebaseDB } from '../../../../config/firebase.js';
import { getIO, rooms } from '../../../../config/socket.js';
import { NotFoundError, ValidationError } from '../../../../core/auth/errors.js';
import { logger } from '../../../../utils/logger.js';
import * as dispatchService from '../../orders/services/order-dispatch.service.js';
import { buildOrderIdentityFilter, notifyOwnersSafely } from '../../orders/services/order.helpers.js';

const ACTIVE_REQUEST_STATUSES = ['open', 'in_progress'];
const PRE_PICKUP_ORDER_STATUSES = ['confirmed', 'preparing', 'ready_for_pickup', 'reached_pickup'];
const POST_PICKUP_PHASES = ['en_route_to_delivery', 'at_drop', 'delivered', 'completed'];

/** Works on a raw Prisma order row (flat columns). */
const isBeforePickup = (row) =>
    PRE_PICKUP_ORDER_STATUSES.includes(String(row?.orderStatus || '')) &&
    !row?.pickedUpAt &&
    !POST_PICKUP_PHASES.includes(String(row?.deliveryPhase || ''));

/** The relations the old populateRequest() pulled in. */
const requestInclude = {
    order: {
        select: {
            id: true, order_id: true, orderId: true, orderStatus: true,
            dispatchStatus: true, dispatchDeliveryPartnerId: true,
            deliveryPhase: true, pickedUpAt: true, total: true,
            createdAt: true, updatedAt: true,
        },
    },
    deliveryPartner: {
        select: { id: true, name: true, phone: true, email: true, vehicleType: true, vehicleNumber: true },
    },
    restaurant: {
        select: {
            id: true, restaurantName: true, ownerPhone: true, addressLine1: true,
            area: true, city: true, latitude: true, longitude: true,
        },
    },
    resolvedBy: { select: { id: true, name: true, email: true } },
};

/**
 * Mongoose populate replaced the id field with the document, and callers read
 * both shapes. Prisma puts relations in their own keys, so expose them under the
 * names the API already returns.
 */
const serializeRequest = (request) => {
    if (!request) return null;
    return {
        ...request,
        order: request.order || undefined,
        deliveryPartner: request.deliveryPartner || undefined,
        restaurant: request.restaurant || undefined,
    };
};

async function deassignOrderForRedispatch({
    orderIdentity,
    deliveryPartnerId,
    adminId,
    requestId = null,
    reason,
    historyNote,
}) {
    const identity = buildOrderIdentityFilter(orderIdentity);
    if (!identity) throw new ValidationError('Order id required');

    const existingOrder = await prisma.foodOrder.findFirst({ where: identity });
    if (!existingOrder) throw new NotFoundError('Order not found');
    if (!isBeforePickup(existingOrder)) {
        throw new ValidationError('Order can no longer be reassigned after pickup');
    }

    const assignedPartnerId = existingOrder.dispatchDeliveryPartnerId;
    if (
        existingOrder.dispatchStatus !== 'accepted' ||
        !assignedPartnerId ||
        (deliveryPartnerId && String(assignedPartnerId) !== String(deliveryPartnerId))
    ) {
        throw new ValidationError('Order assignment changed or pickup was completed before reassignment');
    }

    const nextOrderStatus =
        existingOrder.orderStatus === 'reached_pickup' ? 'ready_for_pickup' : existingOrder.orderStatus;
    const now = new Date();

    // The full guard stays in the WHERE clause, so a pickup landing in this instant
    // wins instead of being rolled back by the reassignment.
    const { count } = await prisma.foodOrder.updateMany({
        where: {
            id: existingOrder.id,
            orderStatus: existingOrder.orderStatus,
            dispatchStatus: 'accepted',
            dispatchDeliveryPartnerId: assignedPartnerId,
            pickedUpAt: null,
            deliveryPhase: { notIn: POST_PICKUP_PHASES },
        },
        data: {
            orderStatus: nextOrderStatus,
            dispatchStatus: 'unassigned',
            dispatchDeliveryPartnerId: null,
            dispatchAssignedAt: null,
            dispatchAcceptedAt: null,
            dispatchingAt: null,
            deliveryPhase: 'en_route_to_pickup',
            deliveryStatus: '',
            reachedPickupAt: null,
            reachedDropAt: null,
            pickedUpAt: null,
            deliveredAt: null,
        },
    });

    if (count === 0) {
        throw new ValidationError('Order assignment changed or pickup was completed before reassignment');
    }

    // The 'deassigned' offer row permanently excludes this rider from re-offers.
    await prisma.orderDispatchOffer.create({
        data: { orderId: existingOrder.id, partnerId: assignedPartnerId, at: now, action: 'deassigned' },
    });

    await prisma.orderStatusHistory.create({
        data: {
            orderId: existingOrder.id,
            byRole: 'ADMIN',
            byId: adminId ? String(adminId) : null,
            from: 'accepted',
            to: 'unassigned',
            note: historyNote,
            at: now,
        },
    });

    await prisma.foodTransaction.updateMany({
        where: { orderId: existingOrder.id },
        data: { deliveryPartnerId: null },
    });

    const order = await prisma.foodOrder.findUnique({ where: { id: existingOrder.id } });

    const db = getFirebaseDB();
    if (db) {
        await db.ref(`active_orders/${order.id}`).remove().catch((error) => {
            logger.warn(`Failed to clear tracking for reassigned order ${order.id}: ${error.message}`);
        });
    }

    const payload = {
        orderId: order.id,
        orderMongoId: order.id,
        ...(requestId ? { requestId: String(requestId) } : {}),
        reason,
    };

    const io = getIO();
    if (io) {
        io.to(rooms.delivery(assignedPartnerId)).emit('order_deassigned', payload);
        io.to(rooms.restaurant(order.restaurantId)).emit('order_status_update', {
            ...payload,
            dispatchStatus: 'unassigned',
        });
        io.to(rooms.user(order.userId)).emit('order_status_update', {
            ...payload,
            dispatchStatus: 'unassigned',
        });
    }

    await notifyOwnersSafely(
        [
            { ownerType: 'DELIVERY_PARTNER', ownerId: assignedPartnerId },
            { ownerType: 'RESTAURANT', ownerId: order.restaurantId },
            { ownerType: 'USER', ownerId: order.userId },
        ],
        {
            title: 'Delivery partner reassignment',
            body: 'The order is being assigned to another delivery partner.',
            data: {
                type: 'order_deassigned',
                orderId: order.id,
                ...(requestId ? { requestId: String(requestId) } : {}),
            },
        },
    );

    return { order, deliveryPartnerId: assignedPartnerId };
}

export async function deassignAndResendOrderAdmin(orderId, adminId) {
    const result = await deassignOrderForRedispatch({
        orderIdentity: orderId,
        adminId,
        reason: 'Order reassigned by admin',
        historyNote: 'Delivery partner deassigned and dispatch restarted by admin',
    });

    const dispatchResult = await dispatchService.tryAutoAssign(result.order.id);

    await prisma.deliveryOrderEmergencyRequest.updateMany({
        where: {
            orderId: result.order.id,
            status: { in: [...ACTIVE_REQUEST_STATUSES, 'processing'] },
        },
        data: {
            status: 'resolved',
            deassignedAt: new Date(),
            resolvedAt: new Date(),
            resolvedById: adminId ? String(adminId) : null,
            failureReason: '',
            // Clearing activeKey releases the unique slot so a future emergency on
            // this order can be raised.
            activeKey: null,
        },
    });

    return {
        orderId: result.order.id,
        deliveryPartnerId: String(result.deliveryPartnerId),
        dispatchStarted: Boolean(dispatchResult),
    };
}

export async function createOrderEmergencyRequest(deliveryPartnerId, payload = {}) {
    const reason = String(payload.reason || '').trim();
    if (reason.length < 10) {
        throw new ValidationError('Emergency reason must be at least 10 characters');
    }

    const partnerId = String(deliveryPartnerId);
    const order = await prisma.foodOrder.findFirst({
        where: {
            dispatchDeliveryPartnerId: partnerId,
            dispatchStatus: 'accepted',
            orderStatus: { in: PRE_PICKUP_ORDER_STATUSES },
        },
    });

    if (!order || !isBeforePickup(order)) {
        throw new ValidationError(
            'Emergency reassignment is available only for an accepted order before pickup',
        );
    }

    try {
        // activeKey is unique, so it is the lock: a second concurrent request for the
        // same order fails here rather than creating a duplicate.
        const created = await prisma.deliveryOrderEmergencyRequest.create({
            data: {
                orderId: order.id,
                deliveryPartnerId: partnerId,
                restaurantId: order.restaurantId,
                reason,
                activeKey: order.id,
                status: 'open',
            },
            include: requestInclude,
        });
        return serializeRequest(created);
    } catch (error) {
        if (error?.code === 'P2002') {
            throw new ValidationError('An active reassignment request already exists for this order');
        }
        throw error;
    }
}

export async function listOrderEmergencyRequestsByPartner(deliveryPartnerId) {
    const list = await prisma.deliveryOrderEmergencyRequest.findMany({
        where: { deliveryPartnerId: String(deliveryPartnerId) },
        include: requestInclude,
        orderBy: { createdAt: 'desc' },
    });
    return list.map(serializeRequest);
}

export async function getOrderEmergencyRequestByPartner(requestId, deliveryPartnerId) {
    if (!isId(requestId)) return null;
    const request = await prisma.deliveryOrderEmergencyRequest.findFirst({
        where: { id: String(requestId), deliveryPartnerId: String(deliveryPartnerId) },
        include: requestInclude,
    });
    return serializeRequest(request);
}

export async function listOrderEmergencyRequestsAdmin(query = {}) {
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.max(1, Math.min(200, Number(query.limit) || 50));
    const where = {};
    if (query.status) where.status = String(query.status);

    if (query.search && String(query.search).trim()) {
        const term = String(query.search).trim();
        // Matched through the relation instead of pre-resolving partner ids.
        where.OR = [
            { reason: { contains: term, mode: 'insensitive' } },
            { deliveryPartner: { name: { contains: term, mode: 'insensitive' } } },
            { deliveryPartner: { phone: { contains: term, mode: 'insensitive' } } },
        ];
    }

    const [list, total] = await Promise.all([
        prisma.deliveryOrderEmergencyRequest.findMany({
            where,
            include: requestInclude,
            orderBy: { createdAt: 'desc' },
            skip: (page - 1) * limit,
            take: limit,
        }),
        prisma.deliveryOrderEmergencyRequest.count({ where }),
    ]);

    return {
        requests: list.map(serializeRequest),
        pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) },
    };
}

export async function getOrderEmergencyRequestAdmin(requestId) {
    if (!isId(requestId)) return null;
    const request = await prisma.deliveryOrderEmergencyRequest.findUnique({
        where: { id: String(requestId) },
        include: requestInclude,
    });
    return serializeRequest(request);
}

export async function updateOrderEmergencyRequestAdmin(requestId, body = {}) {
    if (!isId(requestId)) throw new ValidationError('Invalid emergency request id');

    const request = await prisma.deliveryOrderEmergencyRequest.findUnique({
        where: { id: String(requestId) },
    });
    if (!request) throw new NotFoundError('Emergency request not found');
    if (request.status === 'processing') {
        throw new ValidationError('Emergency request is currently being processed');
    }

    const data = {};
    if (body.adminResponse !== undefined) {
        data.adminResponse = String(body.adminResponse || '').trim();
    }
    if (body.status !== undefined) {
        const status = String(body.status);
        if (!['open', 'in_progress', 'resolved', 'closed'].includes(status)) {
            throw new ValidationError('Invalid emergency request status');
        }
        data.status = status;
        if (['resolved', 'closed'].includes(status)) {
            data.activeKey = null;
            data.resolvedAt = request.resolvedAt || new Date();
        }
    }

    const updated = await prisma.deliveryOrderEmergencyRequest.update({
        where: { id: request.id },
        data,
        include: requestInclude,
    });
    return serializeRequest(updated);
}

export async function deassignAndResendEmergencyOrder(requestId, adminId) {
    if (!isId(requestId)) throw new ValidationError('Invalid emergency request id');
    const id = String(requestId);

    const alreadyResolved = await prisma.deliveryOrderEmergencyRequest.findFirst({
        where: { id, status: 'resolved' },
        include: requestInclude,
    });
    if (alreadyResolved) {
        return { request: serializeRequest(alreadyResolved), alreadyResolved: true };
    }

    // Claim the request atomically; only one admin can drive the reassignment.
    const { count } = await prisma.deliveryOrderEmergencyRequest.updateMany({
        where: { id, status: { in: ACTIVE_REQUEST_STATUSES } },
        data: { status: 'processing', failureReason: '' },
    });
    if (count === 0) {
        throw new ValidationError('Emergency request is no longer available for reassignment');
    }

    const request = await prisma.deliveryOrderEmergencyRequest.findUnique({ where: { id } });

    try {
        const existingOrder = await prisma.foodOrder.findUnique({ where: { id: request.orderId } });
        if (!existingOrder) throw new NotFoundError('Order not found');

        if (!(request.deassignedAt && existingOrder.dispatchStatus === 'unassigned')) {
            await deassignOrderForRedispatch({
                orderIdentity: request.orderId,
                deliveryPartnerId: request.deliveryPartnerId,
                adminId,
                requestId: request.id,
                reason: 'Emergency reassignment approved by admin',
                historyNote: `Emergency reassignment request ${request.id}`,
            });
            await prisma.deliveryOrderEmergencyRequest.update({
                where: { id },
                data: { deassignedAt: new Date() },
            });
        }

        const dispatchResult = await dispatchService.tryAutoAssign(request.orderId);
        if (!dispatchResult) {
            throw new ValidationError('Delivery dispatch is already busy; retry the request');
        }

        const resolved = await prisma.deliveryOrderEmergencyRequest.update({
            where: { id },
            data: {
                status: 'resolved',
                resolvedAt: new Date(),
                resolvedById: adminId ? String(adminId) : null,
                activeKey: null,
                failureReason: '',
            },
            include: requestInclude,
        });

        return { request: serializeRequest(resolved), orderId: request.orderId, alreadyResolved: false };
    } catch (error) {
        await prisma.deliveryOrderEmergencyRequest
            .update({
                where: { id },
                data: {
                    status: 'in_progress',
                    failureReason: String(error?.message || 'Reassignment failed'),
                },
            })
            .catch((saveError) => {
                logger.error(`Failed to persist emergency request failure: ${saveError.message}`);
            });
        throw error;
    }
}
