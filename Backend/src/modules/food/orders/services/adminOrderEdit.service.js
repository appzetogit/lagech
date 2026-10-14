import { prisma } from '../../../../config/prisma.js';
import { logger } from '../../../../utils/logger.js';
import { NotFoundError, ValidationError } from '../../../../core/auth/errors.js';
import { getIO, rooms } from '../../../../config/socket.js';
import { fromOrder, orderInclude, toOrder } from '../order.mapper.js';
import { buildOrderIdentityFilter, notifyOwnersSafely, pushStatusHistory } from './order.helpers.js';
import {
    calculateOrderPricing,
    loadRestaurantForOrdering,
    orderItemRows,
    orderPricingColumns,
} from './order-pricing.service.js';
import {
    computeTransactionSplit,
    getRestaurantCommissionSnapshot,
    resyncTransactionSplit,
} from './foodTransaction.service.js';
import { buildAddonGroups, getPublicApprovedRestaurantAddons } from '../../restaurant/services/publicAddons.service.js';
import { cleanEditLines, cleanReferenceCode, EDITABLE_ORDER_STATUSES, orderEditRefusal } from './orderEditRules.js';

/**
 * The admin Order Details page's two edits, as on the old 6amMart panel:
 *
 *   Reference Code  a payment reference the admin types for the order
 *   Edit            change the order's items before it is handed over
 *
 * An item edit re-prices the order with the same code that priced it at
 * placement (calculateOrderPricing: menu prices, variants, add-ons, campaign
 * dishes, packaging, GST, coupon, new-customer discount, free delivery over)
 * with three things pinned to what the order already has: the trip distance,
 * the delivery fee it was charged and the rider's tip. The rider's pay is not
 * touched -- it depends on the trip, not the items. Everything derived from the
 * amounts is then recomputed the way placement computes it: the restaurant's
 * commission (getRestaurantCommissionSnapshot), the transaction split and
 * platform profit (computeTransactionSplit), and the amount due at the door.
 */

const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;
const rupees = (n) => `₹${round2(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

async function loadOrderRow(orderId) {
    const identity = buildOrderIdentityFilter(orderId);
    if (!identity) throw new ValidationError('Order id required');
    const row = await prisma.foodOrder.findFirst({ where: identity, include: orderInclude });
    if (!row) throw new NotFoundError('Order not found');
    return row;
}

/** Whether the admin may edit the order's items, for the details page. */
export function orderEditState(order) {
    const reason = orderEditRefusal(order);
    return { editable: !reason, reason };
}

// ─── Reference code ─────────────────────────────────────────────────────────

/** Sets (or, with an empty value, clears) the order's reference code. */
export async function setOrderReferenceCode(orderId, value, adminId = null) {
    const referenceCode = cleanReferenceCode(value);
    const identity = buildOrderIdentityFilter(orderId);
    if (!identity) throw new ValidationError('Order id required');
    const row = await prisma.foodOrder.findFirst({ where: identity, select: { id: true, referenceCode: true } });
    if (!row) throw new NotFoundError('Order not found');
    await prisma.foodOrder.update({ where: { id: row.id }, data: { referenceCode } });
    logger.info(`Order ${row.id} reference code ${referenceCode ? 'set' : 'cleared'} by admin ${adminId || '-'}`);
    return { orderId: row.id, referenceCode };
}

// ─── The restaurant's menu, for "Add item" ──────────────────────────────────

/**
 * What the admin can add to the order: the restaurant's approved dishes with
 * their sizes and the add-on groups that apply to each (as the customer's item
 * sheet offers them). Unavailable dishes are listed but flagged; pricing
 * refuses them, as it does for the customer.
 */
export async function getOrderEditMenu(orderId) {
    const identity = buildOrderIdentityFilter(orderId);
    if (!identity) throw new ValidationError('Order id required');
    const row = await prisma.foodOrder.findFirst({ where: identity, select: { id: true, restaurantId: true } });
    if (!row) throw new NotFoundError('Order not found');

    const [foods, addonData] = await Promise.all([
        prisma.foodItem.findMany({
            where: { restaurantId: row.restaurantId, approvalStatus: 'approved' },
            include: { variants: { orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] } },
            orderBy: [{ categoryName: 'asc' }, { name: 'asc' }],
        }),
        getPublicApprovedRestaurantAddons(row.restaurantId).catch(() => null),
    ]);
    const addons = addonData?.addons || [];

    return {
        restaurantId: row.restaurantId,
        items: foods.map((food) => ({
            id: food.id,
            name: food.name,
            categoryName: food.categoryName || '',
            price: round2(food.price),
            image: food.image || '',
            isVeg: food.foodType === 'Veg',
            isAvailable: food.isAvailable !== false,
            variants: (food.variants || []).map((v) => ({ id: v.id, name: v.name, price: round2(v.price) })),
            addonGroups: buildAddonGroups(addons.filter((a) => a.appliesToWholeMenu || a.foodIds.includes(food.id))),
        })),
    };
}

// ─── Editing the items ──────────────────────────────────────────────────────

const amountsOf = (p) => ({
    subtotal: round2(p.subtotal),
    discount: round2(p.discount),
    couponCode: p.couponCode || null,
    packagingFee: round2(p.packagingFee),
    tax: round2(p.tax),
    deliveryFee: round2(p.deliveryFee),
    deliveryFeeGst: round2(p.deliveryFeeGst),
    platformFee: round2(p.platformFee),
    riderTip: round2(p.riderTip),
    total: round2(p.total),
});

const linesOf = (items) => items.map((it) => ({
    itemId: String(it.itemId),
    name: it.name,
    variantId: it.variantId || '',
    variantName: it.variantName || '',
    quantity: Number(it.quantity) || 1,
    unitPrice: round2(it.price),
    lineTotal: round2((Number(it.price) || 0) * (Number(it.quantity) || 1)),
    addons: it.addons || [],
    notes: it.notes || '',
    ...(it.itemCampaignId ? { campaignId: it.itemCampaignId } : {}),
}));

/**
 * Re-prices the order for `rawItems` and, unless `preview`, saves it.
 *
 * @param {Array<{ itemId|foodId, variantId?, quantity, addons?, notes?, campaignId? }>} rawItems
 * @returns {{ preview, before, after, items, couponNote, restaurantCommission, platformProfit }}
 */
export async function editOrderItemsAdmin(orderId, rawItems, adminId = null, { preview = false } = {}) {
    const lines = cleanEditLines(rawItems);
    const row = await loadOrderRow(orderId);
    const order = toOrder(row);
    const refusal = orderEditRefusal(order);
    if (refusal) throw new ValidationError(refusal);

    const restaurant = await loadRestaurantForOrdering(row.restaurantId);

    // Only a coupon that actually applied is re-checked; a code that was
    // entered and refused at checkout stays as it was.
    const hadCoupon = Boolean(row.couponId && row.couponCode);
    // The delivery fee stays as charged. An order whose fee was waived (free
    // delivery coupon, free delivery over) is priced from its bands at the
    // recorded distance, so the waiver can be re-decided on the new items.
    const waived = Number(row.couponDeliveryWaiver) > 0 || Number(row.freeDeliveryWaiver) > 0;
    const fixedDeliveryFee = Number(row.deliveryFee) > 0 || !waived ? Number(row.deliveryFee) || 0 : undefined;

    const pricingResult = await calculateOrderPricing(
        row.userId,
        {
            restaurantId: row.restaurantId,
            zoneId: row.zoneId || undefined,
            items: lines,
            deliveryAddress: order.deliveryAddress,
            couponCode: hadCoupon ? row.couponCode : undefined,
            deliveryMode: row.deliveryMode,
            orderType: row.orderType || 'delivery',
            extraPackaging: Number(row.packagingFee) > 0,
            // The tip is added back below, exactly as it was.
        },
        {
            at: new Date(),
            restaurant,
            skipAvailabilityCheck: true,
            distanceKm: row.distanceKm == null ? null : Number(row.distanceKm),
            fixedDeliveryFee,
            editingOrder: { id: row.id, couponId: row.couponId },
        },
    );

    const items = pricingResult.items || [];
    if (items.length === 0) throw new ValidationError('At least one item must remain on the order');
    const pricing = orderPricingColumns(pricingResult.pricing || {}, row.deliveryMode);

    // The tip goes to the rider whatever the items are: kept as given.
    const tip = round2(row.riderTip);
    pricing.riderTip = tip;
    pricing.total = round2(pricing.total + tip);
    // The trip did not change.
    delete pricing.distanceKm;
    delete pricing.roadDistanceKm;

    let couponNote = '';
    if (!hadCoupon) {
        delete pricing.couponCode;
        delete pricing.couponId;
    } else if (!pricingResult.pricing?.appliedCoupon) {
        couponNote = `Coupon ${row.couponCode} removed: ${pricingResult.pricing?.couponError || 'it no longer applies'}.`;
        pricing.couponCode = null;
        pricing.couponId = null;
    }

    if (!(pricing.total > 0)) throw new ValidationError('Order total must be greater than zero');

    const commission = await getRestaurantCommissionSnapshot({
        subtotal: pricing.subtotal,
        restaurantId: row.restaurantId,
        items,
    }).catch((err) => {
        logger.error(`Commission calculation failed for edited order ${row.id}: ${err.message}`);
        return { commissionAmount: 0 };
    });
    pricing.restaurantCommission = round2(commission.commissionAmount);

    // The order as it will be stored, for the split (it reads the flat columns).
    const draft = {
        ...row,
        ...pricing,
        couponCode: hadCoupon ? pricing.couponCode : row.couponCode,
        items,
        riderTip: tip,
        riderEarning: Number(row.riderEarning) || 0,
        paymentAmountDue: pricing.total,
    };
    const split = await computeTransactionSplit(draft);
    const platformProfit = round2(split.platformNetProfit);

    const before = amountsOf({ ...order.pricing, riderTip: row.riderTip });
    const after = amountsOf({ ...pricing, couponCode: draft.couponCode });
    const result = {
        preview: Boolean(preview),
        before,
        after,
        difference: round2(after.total - before.total),
        items: linesOf(items),
        priceChanges: pricingResult.priceChanges || [],
        couponNote,
        restaurantCommission: pricing.restaurantCommission,
        restaurantEarning: round2(split.restaurantShare),
        platformProfit,
    };
    if (preview) return result;

    const note = `Items edited by admin: total ${rupees(before.total)} → ${rupees(after.total)}.${couponNote ? ` ${couponNote}` : ''}`;
    await prisma.$transaction(async (tx) => {
        // Guarded on what the edit was decided from, so a status change (or a
        // second edit) that landed meanwhile is not overwritten.
        const { count } = await tx.foodOrder.updateMany({
            where: {
                id: row.id,
                updatedAt: row.updatedAt,
                orderStatus: { in: EDITABLE_ORDER_STATUSES },
                paymentStatus: row.paymentStatus,
            },
            data: {
                ...fromOrder({ pricing }),
                platformProfit,
                paymentAmountDue: pricing.total,
            },
        });
        if (!count) throw new ValidationError('This order was just updated by someone else. Please refresh and try again.');

        await tx.orderItem.deleteMany({ where: { orderId: row.id } });
        await tx.orderItem.createMany({ data: orderItemRows(items).map((it) => ({ ...it, orderId: row.id })) });
        await pushStatusHistory(row.id, {
            byRole: 'ADMIN',
            byId: adminId ? String(adminId) : null,
            from: row.orderStatus,
            to: row.orderStatus,
            note,
        }, tx);
        await resyncTransactionSplit(row.id, split, { amountDue: pricing.total, note, byRole: 'ADMIN', byId: adminId }, tx);
    });

    // The coupon this order no longer uses goes back to the pool.
    if (couponNote && row.couponId) {
        await prisma.foodOffer.updateMany({ where: { id: row.couponId, usedCount: { gt: 0 } }, data: { usedCount: { decrement: 1 } } })
            .catch((err) => logger.warn(`Coupon usage give-back failed for order ${row.id}: ${err?.message || err}`));
        await prisma.foodOfferUsage.updateMany({ where: { offerId: row.couponId, userId: row.userId, count: { gt: 0 } }, data: { count: { decrement: 1 } } })
            .catch(() => {});
    }

    await notifyOrderEdited(row, after.total);
    return result;
}

/** Push to the customer and the restaurant; the order_status_update socket event to every app. */
async function notifyOrderEdited(row, newTotal) {
    const displayId = row.order_id || row.id;
    const data = { type: 'order_updated', orderId: row.id, orderMongoId: row.id, orderStatus: String(row.orderStatus || '') };
    const title = 'Your order was updated';
    const body = `Order #${displayId} was updated. New total ${rupees(newTotal)}.`;

    await notifyOwnersSafely([{ ownerType: 'USER', ownerId: row.userId }], {
        title,
        body,
        data: { ...data, link: `/food/user/orders/${row.id}` },
    });
    await notifyOwnersSafely([{ ownerType: 'RESTAURANT', ownerId: row.restaurantId }], {
        title: 'Order items changed',
        body: `Order #${displayId} was edited by the admin. New total ${rupees(newTotal)}. Please check the items.`,
        data,
    });

    try {
        const io = getIO();
        if (!io) return;
        const payload = {
            orderMongoId: row.id,
            orderId: row.id,
            orderStatus: row.orderStatus,
            title,
            message: body,
            orderUpdated: true,
            total: round2(newTotal),
        };
        io.to([rooms.user(row.userId), rooms.admin()]).emit('order_status_update', payload);
        io.to(rooms.restaurant(row.restaurantId)).emit('order_status_update', payload);
        if (row.dispatchDeliveryPartnerId) {
            io.to(rooms.delivery(row.dispatchDeliveryPartnerId)).emit('order_status_update', payload);
        }
    } catch (err) {
        logger.warn(`Order edit socket emit failed: ${err?.message || err}`);
    }
}
