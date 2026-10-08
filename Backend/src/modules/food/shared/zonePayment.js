import { prisma } from '../../../config/prisma.js';
import { isId } from '../../../utils/helpers.js';
import { ValidationError } from '../../../core/auth/errors.js';

/**
 * Per-zone payment switches and the default zone -- the old Zone setup's
 * "Cash On Delivery", "Digital Payment" and "Make default".
 *
 * Wallet and offline payment are not zone-governed (offline has its own
 * switch in Offline Payment Setup), so only these methods are checked.
 */
export const CASH_METHODS = new Set(['cash']);
export const DIGITAL_METHODS = new Set(['razorpay', 'card', 'razorpay_qr']);

const ZONE_PAYMENT_SELECT = {
    id: true, name: true, isActive: true, cashOnDelivery: true, digitalPayment: true, isDefault: true,
};

/** The active default zone, or null when none is flagged. */
export async function getDefaultZone() {
    return prisma.foodZone.findFirst({
        where: { isDefault: true, isActive: true },
        select: ZONE_PAYMENT_SELECT,
    });
}

/**
 * The zone an order belongs to: the one the app sent, else the restaurant's,
 * else the default zone. Null only when none of those exists.
 */
export async function resolveOrderZoneId(requestedZoneId, restaurant) {
    if (requestedZoneId) return String(requestedZoneId);
    if (restaurant?.zoneId) return String(restaurant.zoneId);
    const fallback = await getDefaultZone();
    return fallback?.id || null;
}

/**
 * What a zone accepts. A missing or unknown zone accepts everything, as every
 * order did before these switches existed.
 */
export async function getZonePaymentOptions(zoneId) {
    const zone = isId(zoneId)
        ? await prisma.foodZone.findUnique({ where: { id: String(zoneId) }, select: ZONE_PAYMENT_SELECT })
        : null;
    return {
        zoneId: zone?.id || null,
        cashOnDelivery: zone ? zone.cashOnDelivery !== false : true,
        digitalPayment: zone ? zone.digitalPayment !== false : true,
    };
}

/** Pure check, so the message is testable without a database. */
export function zonePaymentError(options, paymentMethod, zoneName = '') {
    const method = String(paymentMethod || '').trim();
    const where = zoneName ? ` in ${zoneName}` : ' in this area';
    if (CASH_METHODS.has(method) && options?.cashOnDelivery === false) {
        return `Cash on Delivery is not available${where}. Please choose another payment method.`;
    }
    if (DIGITAL_METHODS.has(method) && options?.digitalPayment === false) {
        return `Online payment is not available${where}. Please choose another payment method.`;
    }
    return null;
}

/** Throws a 400 when the order's zone has switched this payment method off. */
export async function assertZoneAllowsPayment(zoneId, paymentMethod) {
    if (!isId(zoneId)) return;
    const zone = await prisma.foodZone.findUnique({
        where: { id: String(zoneId) },
        select: ZONE_PAYMENT_SELECT,
    });
    if (!zone) return;
    const message = zonePaymentError(zone, paymentMethod, zone.name);
    if (message) throw new ValidationError(message);
}
