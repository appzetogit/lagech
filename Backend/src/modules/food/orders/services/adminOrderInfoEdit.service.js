import pkg from '@prisma/client';
import { prisma } from '../../../../config/prisma.js';
import { logger } from '../../../../utils/logger.js';
import { NotFoundError, ValidationError } from '../../../../core/auth/errors.js';
import { getIO, rooms } from '../../../../config/socket.js';
import { orderInclude } from '../order.mapper.js';
import { buildOrderIdentityFilter, notifyOwnersSafely, pushStatusHistory } from './order.helpers.js';
import {
    calculateRiderEarning,
    getDeliveryDistanceKm,
    loadActiveFeeSettings,
    loadRestaurantForOrdering,
    resolveUserDeliveryFee,
    serviceableRadiusKm,
} from './order-pricing.service.js';
import { findZonesForPoint } from '../../shared/zone.service.js';
import { assertSchedulable, releaseAtFor } from './orderModes.js';
import {
    ADMIN_MARKED_PAID_METHOD_ID,
    addressEditRefusal,
    cleanCutlery,
    cleanDeliveryAddress,
    cleanOrderNotes,
    cleanPaidFlag,
    cleanScheduledAt,
    cutleryEditRefusal,
    describeAddressChange,
    formatAdminTime,
    noteEditRefusal,
    paymentStatusRefusal,
    scheduleEditRefusal,
} from './orderInfoEditRules.js';

// DbNull writes SQL NULL to a Json column; a bare null would store JSON `null`.
const { Prisma } = pkg;

/**
 * The admin Order Details page's other edits, as on the old 6amMart panel
 * (the rules are in orderInfoEditRules.js):
 *
 *   PATCH /orders/:id/delivery-address   receiver, phone, address, map pin
 *   PATCH /orders/:id/note               cooking note, delivery instructions
 *   PATCH /orders/:id/cutlery            send cutlery or not
 *   PATCH /orders/:id/schedule           a scheduled order's time
 *   PATCH /orders/:id/payment-status     "Mark as paid / unpaid" (cash orders)
 *
 * Each writes a status-history note (the admin, what changed), emits the
 * order_status_update socket event with `orderUpdated: true` to every app on
 * the order, and is guarded on the order's status so a status change that
 * landed meanwhile is not overwritten.
 */

const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;
const rupees = (n) => `₹${round2(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const km = (n) => `${round2(n)} km`;

async function loadOrderRow(orderId) {
    const identity = buildOrderIdentityFilter(orderId);
    if (!identity) throw new ValidationError('Order id required');
    const row = await prisma.foodOrder.findFirst({ where: identity, include: orderInclude });
    if (!row) throw new NotFoundError('Order not found');
    return row;
}

const CHANGED_MEANWHILE = 'This order was just updated by someone else. Please refresh and try again.';

/**
 * One guarded write plus its history note, in one database transaction.
 * Guarded on the status the change was decided from (and `where`), not on
 * updatedAt: the rider's location pings rewrite the row every few seconds
 * while it is on the way, and would refuse every edit made meanwhile.
 */
async function saveGuarded(row, { where = {}, data, note, adminId }, extra) {
    await prisma.$transaction(async (tx) => {
        const { count } = await tx.foodOrder.updateMany({ where: { id: row.id, orderStatus: row.orderStatus, ...where }, data });
        if (!count) throw new ValidationError(CHANGED_MEANWHILE);
        await pushStatusHistory(row.id, {
            byRole: 'ADMIN',
            byId: adminId ? String(adminId) : null,
            from: row.orderStatus,
            to: row.orderStatus,
            note,
        }, tx);
        if (extra) await extra(tx);
    });
    logger.info(`Order ${row.id}: ${note} (admin ${adminId || '-'})`);
}

/**
 * The order_status_update socket event to the customer, the admins, the
 * restaurant and the rider (if any), and pushes to whoever `push` names.
 */
async function notifyOrderChanged(row, { title, message, push = {} }) {
    const displayId = row.order_id || row.id;
    const data = { type: 'order_updated', orderId: row.id, orderMongoId: row.id, orderStatus: String(row.orderStatus || '') };
    const riderId = row.dispatchDeliveryPartnerId;

    if (push.user) {
        await notifyOwnersSafely([{ ownerType: 'USER', ownerId: row.userId }], {
            title: push.user.title || title,
            body: push.user.body || message,
            data: { ...data, link: `/food/user/orders/${row.id}` },
        });
    }
    if (push.restaurant) {
        await notifyOwnersSafely([{ ownerType: 'RESTAURANT', ownerId: row.restaurantId }], {
            title: push.restaurant.title || title,
            body: push.restaurant.body || message,
            data,
        });
    }
    if (push.rider && riderId) {
        await notifyOwnersSafely([{ ownerType: 'DELIVERY_PARTNER', ownerId: riderId }], {
            title: push.rider.title || title,
            body: push.rider.body || message,
            data,
        });
    }

    try {
        const io = getIO();
        if (!io) return;
        const payload = {
            orderMongoId: row.id,
            orderId: row.id,
            displayOrderId: displayId,
            orderStatus: row.orderStatus,
            title,
            message,
            orderUpdated: true,
        };
        io.to([rooms.user(row.userId), rooms.admin()]).emit('order_status_update', payload);
        io.to(rooms.restaurant(row.restaurantId)).emit('order_status_update', payload);
        if (riderId) io.to(rooms.delivery(riderId)).emit('order_status_update', payload);
    } catch (err) {
        logger.warn(`Order ${row.id} change socket emit failed: ${err?.message || err}`);
    }
}

// ─── Delivery info ──────────────────────────────────────────────────────────

async function activeZoneCount() {
    const [{ count }] = await prisma.$queryRaw`
        SELECT COUNT(*)::int AS count FROM "food_zones"
        WHERE "isActive" = true AND "boundary" IS NOT NULL`;
    return count;
}

/**
 * Refuses a pin outside the delivery zone the order belongs to (its zone, or
 * the restaurant's), or outside every zone when zones are set up. A platform
 * without zones has no coverage map to check against.
 */
async function assertPinServed({ lat, lng }, zoneId, restaurantName) {
    const zones = await findZonesForPoint(lat, lng);
    if (zones.length === 0) {
        if ((await activeZoneCount()) > 0) {
            throw new ValidationError('This location is outside every delivery zone. Please move the pin.');
        }
        return null;
    }
    if (!zoneId) return zones[0];
    const own = zones.find((z) => String(z.id) === String(zoneId));
    if (own) return own;
    const zone = await prisma.foodZone.findUnique({ where: { id: String(zoneId) }, select: { name: true, zoneName: true } });
    throw new ValidationError(
        `This location is in ${zones[0].zoneName || zones[0].name}, but ${restaurantName || 'the restaurant'} delivers in ${zone?.zoneName || zone?.name || 'its own zone'} only. Please move the pin.`,
    );
}

/**
 * Changes the delivery info. The order's delivery fee and the rider's pay
 * stay as charged (6amMart behaviour); `feeWarning` says when the new
 * distance falls in another delivery-fee band.
 *
 * @returns {{ preview, address, distanceKm, previousDistanceKm, zone, feeWarning, deliveryFee, changes }}
 */
export async function updateOrderDeliveryAddressAdmin(orderId, body, adminId = null, { preview = false } = {}) {
    const address = cleanDeliveryAddress(body);
    const row = await loadOrderRow(orderId);
    const refusal = addressEditRefusal(row);
    if (refusal) throw new ValidationError(refusal);

    const restaurant = await prisma.foodRestaurant.findUnique({
        where: { id: row.restaurantId },
        select: { id: true, restaurantName: true, zoneId: true, latitude: true, longitude: true },
    });
    const zoneId = row.zoneId || restaurant?.zoneId || null;
    const zone = await assertPinServed(address, zoneId, restaurant?.restaurantName);

    const feeSettings = await loadActiveFeeSettings(zoneId);
    const rawKm = restaurant ? await getDeliveryDistanceKm(restaurant, { lat: address.lat, lng: address.lng }) : null;
    const distanceKm = Number.isFinite(Number(rawKm)) && rawKm != null ? round2(rawKm) : null;
    const radiusKm = serviceableRadiusKm(feeSettings);
    if (distanceKm != null && radiusKm != null && distanceKm > radiusKm) {
        throw new ValidationError(
            `This location is ${distanceKm} km from ${restaurant?.restaurantName || 'the restaurant'}, which delivers within ${radiusKm} km only. Please move the pin.`,
        );
    }

    const previousDistanceKm = row.distanceKm == null ? null : round2(row.distanceKm);
    const chargedFee = round2(row.deliveryFee);
    let feeWarning = null;
    if (distanceKm != null && String(row.orderType || 'delivery') !== 'takeaway') {
        const bandFee = (d) => round2(resolveUserDeliveryFee(feeSettings, { distanceKm: d }).deliveryFee);
        const newBandFee = bandFee(distanceKm);
        const oldBandFee = previousDistanceKm != null ? bandFee(previousDistanceKm) : chargedFee;
        if (newBandFee !== oldBandFee) {
            const pay = (d) => round2(calculateRiderEarning(feeSettings, d));
            const riderNote = previousDistanceKm != null && pay(distanceKm) !== pay(previousDistanceKm)
                ? ` The rider's pay also stays ${rupees(row.riderEarning)} (the new band pays ${rupees(pay(distanceKm))}).`
                : '';
            feeWarning = `At ${km(distanceKm)} this address is in the ${rupees(newBandFee)} delivery-fee band`
                + `${previousDistanceKm != null ? ` (it was ${km(previousDistanceKm)}, the ${rupees(oldBandFee)} band)` : ''}.`
                + ` The delivery fee stays ${rupees(chargedFee)} as charged.${riderNote}`;
        }
    }

    const before = {
        fullName: row.addrFullName || row.addrName,
        phone: row.addrPhone,
        street: row.addrStreet,
        additionalDetails: row.addrAdditionalDetails,
        city: row.addrCity,
        state: row.addrState,
        zipCode: row.addrZipCode,
        lat: row.addrLat,
        lng: row.addrLng,
    };
    const changes = describeAddressChange(before, address);
    const result = {
        preview: Boolean(preview),
        address: {
            ...(address.label ? { label: address.label } : {}),
            name: address.name, fullName: address.fullName, phone: address.phone, street: address.street,
            additionalDetails: address.additionalDetails, city: address.city, state: address.state, zipCode: address.zipCode,
            location: { type: 'Point', coordinates: [address.lng, address.lat] },
        },
        distanceKm,
        previousDistanceKm,
        zone: zone ? { id: zone.id, name: zone.zoneName || zone.name } : null,
        deliveryFee: chargedFee,
        feeWarning,
        changes,
    };
    if (preview) return result;
    if (!changes.length && (!address.label || address.label === row.addrLabel)) {
        throw new ValidationError('Nothing changed');
    }

    const note = `Delivery info changed by admin: ${changes.join('; ') || 'label'}.`
        + `${distanceKm != null ? ` Distance now ${km(distanceKm)}.` : ''} Delivery fee kept at ${rupees(chargedFee)}.`;
    await saveGuarded(row, {
        data: {
            ...(address.label ? { addrLabel: address.label } : {}),
            addrName: address.name,
            addrFullName: address.fullName,
            addrPhone: address.phone,
            addrStreet: address.street,
            addrAdditionalDetails: address.additionalDetails,
            addrCity: address.city,
            addrState: address.state,
            addrZipCode: address.zipCode,
            addrLat: address.lat,
            addrLng: address.lng,
        },
        note,
        adminId,
    });

    const displayId = row.order_id || row.id;
    const line = [address.street, address.additionalDetails, address.city].filter(Boolean).join(', ');
    await notifyOrderChanged(row, {
        title: 'Delivery address changed',
        message: `The delivery address of order #${displayId} was changed: ${line}.`,
        push: {
            rider: { body: `Order #${displayId} now goes to ${address.fullName}, ${line}. Contact ${address.phone}.` },
        },
    });
    return result;
}

// ─── Note, delivery instructions, cutlery ───────────────────────────────────

export async function updateOrderNotesAdmin(orderId, body, adminId = null) {
    const notes = cleanOrderNotes(body);
    const row = await loadOrderRow(orderId);
    const refusal = noteEditRefusal(row);
    if (refusal) throw new ValidationError(refusal);

    const data = {};
    const parts = [];
    if (notes.note !== undefined && notes.note !== (row.note || '')) {
        data.note = notes.note;
        parts.push(notes.note ? `order note "${notes.note}"` : 'order note removed');
    }
    if (notes.deliveryInstructions !== undefined && notes.deliveryInstructions !== (row.deliveryInstructions || '')) {
        data.deliveryInstructions = notes.deliveryInstructions;
        parts.push(notes.deliveryInstructions ? `delivery instructions "${notes.deliveryInstructions}"` : 'delivery instructions removed');
    }
    if (!parts.length) throw new ValidationError('Nothing changed');

    await saveGuarded(row, { data, note: `Changed by admin: ${parts.join('; ')}.`, adminId });

    const displayId = row.order_id || row.id;
    await notifyOrderChanged(row, {
        title: 'Order note changed',
        message: `Order #${displayId}: ${parts.join('; ')}.`,
        push: {
            ...(data.note !== undefined ? { restaurant: { body: `Order #${displayId}: ${data.note ? `note "${data.note}"` : 'the note was removed'}.` } } : {}),
            ...(data.deliveryInstructions !== undefined
                ? { rider: { body: `Order #${displayId}: ${data.deliveryInstructions ? `delivery instructions "${data.deliveryInstructions}"` : 'the delivery instructions were removed'}.` } }
                : {}),
        },
    });
    return { orderId: row.id, note: data.note ?? row.note ?? '', deliveryInstructions: data.deliveryInstructions ?? row.deliveryInstructions ?? '' };
}

export async function setOrderCutleryAdmin(orderId, value, adminId = null) {
    const sendCutlery = cleanCutlery(value);
    const row = await loadOrderRow(orderId);
    const refusal = cutleryEditRefusal(row);
    if (refusal) throw new ValidationError(refusal);
    if (row.sendCutlery === sendCutlery) throw new ValidationError('Nothing changed');

    await saveGuarded(row, {
        where: { pickedUpAt: null },
        data: { sendCutlery },
        note: `Cutlery changed by admin: ${sendCutlery ? 'send cutlery' : 'no cutlery'}.`,
        adminId,
    });
    const displayId = row.order_id || row.id;
    const message = `Order #${displayId}: ${sendCutlery ? 'please send cutlery' : 'no cutlery needed'}.`;
    await notifyOrderChanged(row, { title: 'Cutlery changed', message, push: { restaurant: { body: message } } });
    return { orderId: row.id, sendCutlery };
}

// ─── Scheduled time ─────────────────────────────────────────────────────────

/**
 * Moves a scheduled order that has not started to another time, checked as
 * at checkout (assertSchedulable: lead time, today or tomorrow, restaurant
 * open then). The release time and, for an order not accepted yet, the
 * acceptance window move with it.
 */
export async function rescheduleOrderAdmin(orderId, value, adminId = null, { now = new Date() } = {}) {
    const at = cleanScheduledAt(value);
    const row = await loadOrderRow(orderId);
    const refusal = scheduleEditRefusal(row, now);
    if (refusal) throw new ValidationError(refusal);

    const restaurant = await loadRestaurantForOrdering(row.restaurantId);
    assertSchedulable(at, { restaurant, now });
    const releaseAt = releaseAtFor(at, now);
    if (!releaseAt) throw new ValidationError('Pick a later time.');
    if (row.scheduledAt && new Date(row.scheduledAt).getTime() === at.getTime()) throw new ValidationError('Nothing changed');

    const windowSeconds = Number(row.acceptanceWindowSeconds) > 0 ? Number(row.acceptanceWindowSeconds) : 240;
    const acceptanceDeadlineAt = row.orderStatus === 'created'
        ? new Date(releaseAt.getTime() + windowSeconds * 1000)
        : row.acceptanceDeadlineAt;

    const from = formatAdminTime(row.scheduledAt);
    const to = formatAdminTime(at);
    await saveGuarded(row, {
        where: {
            dispatchDeliveryPartnerId: null,
            releaseAt: { gt: now },
        },
        data: { scheduledAt: at, releaseAt, acceptanceDeadlineAt },
        note: `Scheduled time changed by admin: ${from || '—'} → ${to}.`,
        adminId,
    });

    const displayId = row.order_id || row.id;
    await notifyOrderChanged(row, {
        title: 'Delivery time changed',
        message: `Order #${displayId} is now scheduled for ${to}.`,
        push: {
            user: { body: `Your order #${displayId} is now scheduled for ${to}.` },
            // Told only when it already knows the order (accepted early).
            ...(row.orderStatus === 'confirmed' ? { restaurant: { body: `Order #${displayId} is now scheduled for ${to}.` } } : {}),
        },
    });
    return { orderId: row.id, scheduledAt: at, releaseAt };
}

// ─── Payment status ─────────────────────────────────────────────────────────

/**
 * "Mark as paid / unpaid" for a cash on delivery order (6amMart's payment
 * status switch), restricted to what cannot count the money twice:
 *
 *   paid    the customer paid the business directly before the rider has the
 *           food. The order is stored as a verified offline payment
 *           ("paid to the business"), so the rider is not asked to collect
 *           it, it is not counted in their cash in hand, and the ledger row
 *           is captured -- as a verified offline payment's is.
 *   unpaid  undoes that, while the rider does not have the food yet: back to
 *           cash on delivery, the rider collects at the door.
 *
 * The admin's reference code (if any) is recorded with the payment.
 */
export async function setOrderPaymentStatusAdmin(orderId, body, adminId = null) {
    const paid = cleanPaidFlag(body);
    const reason = String(body?.note ?? '').trim().slice(0, 300);
    const row = await loadOrderRow(orderId);
    const refusal = paymentStatusRefusal(row, paid);
    if (refusal) throw new ValidationError(refusal);

    const amount = round2(row.paymentAmountDue ?? row.total);
    const now = new Date();
    const record = paid
        ? {
            status: 'verified',
            methodId: ADMIN_MARKED_PAID_METHOD_ID,
            methodName: 'Paid to the business, was cash on delivery',
            paymentInfo: '',
            fields: row.referenceCode ? [{ key: 'reference_code', label: 'Reference code', value: row.referenceCode }] : [],
            customerNote: '',
            submittedAt: now.toISOString(),
            decidedAt: now.toISOString(),
            decidedBy: adminId ? String(adminId) : null,
            adminNote: reason,
            convertedFrom: 'cash',
        }
        : null;

    const note = paid
        ? `Payment marked as paid by admin (${rupees(amount)}, cash on delivery → paid to the business${row.referenceCode ? `, ref ${row.referenceCode}` : ''})${reason ? `: ${reason}` : ''}. The rider does not collect it.`
        : `Payment marked as unpaid by admin (${rupees(amount)} back to cash on delivery)${reason ? `: ${reason}` : ''}. The rider collects it at the door.`;

    await saveGuarded(row, {
        where: paid
            ? { paymentMethod: 'cash', paymentStatus: 'cod_pending', pickedUpAt: null }
            : { paymentMethod: 'offline', paymentStatus: 'paid', pickedUpAt: null },
        data: paid
            ? { paymentMethod: 'offline', paymentStatus: 'paid', offlinePayment: record }
            : { paymentMethod: 'cash', paymentStatus: 'cod_pending', offlinePayment: Prisma.DbNull },
        note,
        adminId,
    }, async (tx) => {
        const ledger = await tx.foodTransaction.findUnique({ where: { orderId: row.id }, select: { id: true, totalCustomerPaid: true } });
        if (!ledger) return;
        await tx.foodTransaction.update({
            where: { id: ledger.id },
            data: {
                paymentMethod: paid ? 'offline' : 'cash',
                status: paid ? 'captured' : 'pending',
                paymentStatusLabel: paid ? 'paid' : 'cod_pending',
                gatewayProvider: paid ? 'offline' : 'razorpay',
                history: {
                    create: [{
                        kind: paid ? 'admin_marked_paid' : 'admin_marked_unpaid',
                        amount: ledger.totalCustomerPaid,
                        at: now,
                        note,
                        recordedByRole: 'ADMIN',
                        recordedById: adminId ? String(adminId) : null,
                    }],
                },
            },
        });
    });

    const displayId = row.order_id || row.id;
    await notifyOrderChanged(row, {
        title: paid ? 'Order paid' : 'Payment due at the door',
        message: paid
            ? `Order #${displayId} is paid. Do not collect cash for it.`
            : `Order #${displayId} is cash on delivery again: collect ${rupees(amount)} at the door.`,
        push: { rider: {} },
    });
    return { orderId: row.id, paid, paymentMethod: paid ? 'offline' : 'cash', paymentStatus: paid ? 'paid' : 'cod_pending' };
}
