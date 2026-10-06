import { z } from 'zod';
import { isId } from '../../../../utils/helpers.js';
import { ValidationError } from '../../../../core/auth/errors.js';
import { istDayEnd, istDayStart } from '../../shared/customerRewards.util.js';
import { COUPON_TYPES } from '../../orders/services/couponRules.js';

/**
 * Admin coupon form.
 *
 * Takes the old panel's (6amMart) form -- title, coupon type, restaurant or
 * zone, customers, code, limit for the same user, start and expire date,
 * discount type amount/percent, discount, max discount, min purchase -- and
 * the field names the earlier Lagech form sent (restaurantScope,
 * customerScope 'first-time', discountType 'flat-price'), so either shape
 * produces the same row.
 *
 * Dates are calendar days in India: a coupon starting 10 Oct is usable from
 * 00:00 IST that day, and one expiring 12 Oct until 23:59 IST on the 12th.
 */

const optionalNumber = (value) =>
    value === undefined || value === null || value === '' ? undefined : Number(value);

const DISCOUNT_TYPES = {
    percentage: 'percentage',
    percent: 'percentage',
    amount: 'flat_price',
    flat: 'flat_price',
    'flat-price': 'flat_price',
    flat_price: 'flat_price',
};
const CUSTOMER_SCOPES = { all: 'all', specific: 'specific', 'first-time': 'first_time', first_time: 'first_time' };

const schema = z.object({
    title: z.string().max(191, 'Title can be at most 191 characters'),
    couponCode: z
        .string()
        .min(1, 'Coupon code is required')
        .max(64, 'Coupon code can be at most 64 characters'),
    couponType: z.enum(COUPON_TYPES, { errorMap: () => ({ message: 'Choose a coupon type' }) }),
    discountType: z.enum(['percentage', 'flat_price'], { errorMap: () => ({ message: 'Discount type must be amount or percent' }) }),
    discountValue: z.number({ invalid_type_error: 'Discount must be a number' }).min(0),
    customerScope: z.enum(['all', 'first_time', 'specific']),
    minOrderValue: z.number({ invalid_type_error: 'Min purchase must be a number' }).min(0, 'Min purchase cannot be negative').optional(),
    maxDiscount: z.number({ invalid_type_error: 'Max discount must be a number' }).min(0, 'Max discount cannot be negative').optional(),
    usageLimit: z.number().int().min(0).optional(),
    perUserLimit: z.number({ invalid_type_error: 'Limit for same user must be a number' }).int('Limit for same user must be a whole number').min(0).optional(),
    adminBearPercentage: z.number().min(0).max(100).optional(),
    restaurantBearPercentage: z.number().min(0).max(100).optional(),
});

const parseDay = (value, edge) => {
    if (value === undefined || value === null || value === '') return undefined;
    const s = String(value);
    const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? (edge === 'start' ? istDayStart(s) : istDayEnd(s)) : new Date(s);
    if (!d || Number.isNaN(d.getTime())) {
        throw new ValidationError(edge === 'start' ? 'Invalid start date' : 'Invalid expire date');
    }
    return d;
};

const idList = (...sources) => [
    ...new Set(
        sources
            .flatMap((s) => (Array.isArray(s) ? s : s ? [s] : []))
            .map((id) => String(id || '').trim())
            .filter(Boolean),
    ),
];

/** The type the earlier form implied, for a body that does not name one. */
const impliedType = (body) => {
    if (body?.restaurantScope === 'selected') return 'store_wise';
    if (body?.isFirstOrderOnly === true || CUSTOMER_SCOPES[body?.customerScope] === 'first_time') return 'first_order';
    return 'default';
};

/**
 * @param {object} body
 * @param {{ mode?: 'create'|'update' }} [options] an update may keep an
 *        expire date that has already passed (editing an old coupon's title
 *        should not force a new date), and leaves the funding split alone
 *        unless it is sent.
 */
export const validateCouponDto = (body = {}, { mode = 'create' } = {}) => {
    const couponType = body?.couponType ? String(body.couponType) : impliedType(body);
    const freeDelivery = couponType === 'free_delivery';

    // 6amMart sends the restaurant restriction as "all" or a list of customer
    // ids; the earlier form sent customerScope.
    const rawCustomers = Array.isArray(body?.customerIds) ? body.customerIds.map(String) : [];
    let customerScope = CUSTOMER_SCOPES[body?.customerScope] || 'all';
    if (!body?.customerScope && rawCustomers.length && !rawCustomers.includes('all')) customerScope = 'specific';

    const normalized = {
        title: String(body?.title ?? '').trim(),
        couponCode: typeof body?.couponCode === 'string' ? body.couponCode.trim().toUpperCase() : body?.couponCode,
        couponType,
        discountType: freeDelivery ? 'flat_price' : DISCOUNT_TYPES[String(body?.discountType || 'percentage')] || String(body?.discountType),
        discountValue: freeDelivery ? 0 : Number(body?.discountValue),
        customerScope,
        minOrderValue: optionalNumber(body?.minOrderValue),
        maxDiscount: optionalNumber(body?.maxDiscount),
        usageLimit: optionalNumber(body?.usageLimit),
        perUserLimit: optionalNumber(body?.perUserLimit),
        adminBearPercentage: optionalNumber(body?.adminBearPercentage),
        restaurantBearPercentage: optionalNumber(body?.restaurantBearPercentage),
    };

    const result = schema.safeParse(normalized);
    if (!result.success) {
        throw new ValidationError(result.error.errors[0].message);
    }
    const data = result.data;

    if (!freeDelivery) {
        if (!(data.discountValue > 0)) throw new ValidationError('Discount must be greater than 0');
        if (data.discountType === 'percentage' && data.discountValue > 100) {
            throw new ValidationError('A percent discount cannot be more than 100');
        }
    }

    const restaurantIds = couponType === 'store_wise' ? idList(body?.restaurantIds, body?.restaurantId) : [];
    if (couponType === 'store_wise' && (restaurantIds.length === 0 || restaurantIds.some((id) => !isId(id)))) {
        throw new ValidationError('Select a restaurant for a store wise coupon');
    }
    const zoneIds = couponType === 'zone_wise' ? idList(body?.zoneIds, body?.zoneId) : [];
    if (couponType === 'zone_wise' && (zoneIds.length === 0 || zoneIds.some((id) => !isId(id)))) {
        throw new ValidationError('Select a zone for a zone wise coupon');
    }

    const customerIds = [...new Set(rawCustomers.filter(isId))];
    if (data.customerScope === 'specific' && customerIds.length === 0) {
        // Saving it anyway would create a coupon nobody can redeem.
        throw new ValidationError('Choose at least one customer, or select all customers');
    }

    const startDate = parseDay(body?.startDate, 'start');
    const endDate = parseDay(body?.endDate ?? body?.expireDate, 'end');
    if (startDate && endDate && endDate.getTime() <= startDate.getTime()) {
        throw new ValidationError('Expire date must be on or after the start date');
    }
    if (mode === 'create' && endDate && endDate.getTime() <= Date.now()) {
        throw new ValidationError('Expire date must be today or later');
    }

    // Max discount only caps a percent discount; an amount needs no cap.
    const maxDiscount = data.discountType === 'percentage' && !freeDelivery && data.maxDiscount > 0
        ? data.maxDiscount
        : null;

    let adminBearPercentage = data.adminBearPercentage;
    let restaurantBearPercentage = data.restaurantBearPercentage;
    if (mode === 'create' || adminBearPercentage !== undefined || restaurantBearPercentage !== undefined) {
        adminBearPercentage = adminBearPercentage ?? 100 - (restaurantBearPercentage ?? 0);
        restaurantBearPercentage = restaurantBearPercentage ?? 100 - adminBearPercentage;
        if (Math.round((adminBearPercentage + restaurantBearPercentage) * 100) / 100 !== 100) {
            throw new ValidationError('Admin bear and restaurant bear must total 100%');
        }
        if (freeDelivery) {
            // The waived fee is the platform's own income; a restaurant has
            // nothing to contribute to it.
            adminBearPercentage = 100;
            restaurantBearPercentage = 0;
        }
    }

    return {
        title: data.title,
        couponCode: data.couponCode,
        couponType,
        discountType: data.discountType,
        discountValue: data.discountValue,
        maxDiscount,
        minOrderValue: data.minOrderValue ?? 0,
        customerScope: data.customerScope,
        // Only kept for the scope that reads it, so switching a coupon back
        // to everyone does not leave a stale allow-list behind it.
        customerIds: data.customerScope === 'specific' ? customerIds : [],
        restaurantScope: couponType === 'store_wise' ? 'selected' : 'all',
        restaurantId: restaurantIds[0],
        restaurantIds,
        zoneIds,
        isFirstOrderOnly: couponType === 'first_order' || data.customerScope === 'first_time',
        startDate,
        endDate,
        usageLimit: data.usageLimit && data.usageLimit > 0 ? data.usageLimit : null,
        perUserLimit: data.perUserLimit && data.perUserLimit > 0 ? data.perUserLimit : null,
        adminBearPercentage,
        restaurantBearPercentage,
    };
};

/** The create endpoint's validator; kept under its old name for callers. */
export const validateCreateOfferDto = (body) => validateCouponDto(body, { mode: 'create' });
export const validateUpdateOfferDto = (body) => validateCouponDto(body, { mode: 'update' });

const statusSchema = z.object({
    status: z.enum(['active', 'inactive'], { errorMap: () => ({ message: 'Status must be active or inactive' }) }),
});

export const validateOfferStatusDto = (body) => {
    const raw = body?.status ?? (typeof body?.isActive === 'boolean' ? (body.isActive ? 'active' : 'inactive') : undefined);
    const result = statusSchema.safeParse({ status: raw });
    if (!result.success) throw new ValidationError(result.error.errors[0].message);
    return result.data;
};

const cartVisibilitySchema = z.object({
    itemId: z.string().min(1, 'itemId is required'),
    showInCart: z.boolean()
});

export const validateUpdateOfferCartVisibilityDto = (body) => {
    const result = cartVisibilitySchema.safeParse(body || {});
    if (!result.success) {
        throw new ValidationError(result.error.errors[0].message);
    }
    return result.data;
};
