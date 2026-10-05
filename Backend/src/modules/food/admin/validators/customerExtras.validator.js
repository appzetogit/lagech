import { z } from 'zod';
import { isId } from '../../../../utils/helpers.js';
import { ValidationError } from '../../../../core/auth/errors.js';
import { BONUS_TYPES, istDayEnd, istDayStart } from '../../shared/customerRewards.util.js';

const fail = (result) => {
    throw new ValidationError(result.error.errors[0].message);
};

/** Admin credits a customer's wallet. Most a single credit may be, to catch a mistyped zero. */
export const MAX_ADD_FUND = 100000;

const addFundSchema = z.object({
    userId: z.string().refine(isId, 'Choose a customer'),
    amount: z.number({ invalid_type_error: 'Enter an amount' })
        .positive('Amount must be greater than 0')
        .max(MAX_ADD_FUND, `Amount can be at most ₹${MAX_ADD_FUND}`)
        .refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, 'Amount can have at most 2 decimals'),
    reference: z.string().max(200, 'Reference is too long'),
    requestId: z.string().max(64),
});

export const validateAddFundDto = (body = {}) => {
    const result = addFundSchema.safeParse({
        userId: String(body.userId || ''),
        amount: body.amount === '' || body.amount == null ? NaN : Number(body.amount),
        reference: String(body.reference ?? '').trim(),
        requestId: String(body.requestId ?? '').trim(),
    });
    if (!result.success) fail(result);
    return result.data;
};

const bonusSchema = z.object({
    title: z.string().min(1, 'Title is required').max(120, 'Title is too long'),
    description: z.string().max(500, 'Description is too long'),
    bonusType: z.enum(BONUS_TYPES, { errorMap: () => ({ message: 'Bonus type must be percentage or amount' }) }),
    bonusAmount: z.number({ invalid_type_error: 'Enter the bonus' }).positive('Bonus must be greater than 0'),
    minimumAddAmount: z.number().min(0, 'Minimum add amount cannot be negative'),
    maximumBonus: z.number().min(0, 'Maximum bonus cannot be negative'),
    startDate: z.date({ required_error: 'Choose a start date', invalid_type_error: 'Choose a start date' }),
    endDate: z.date({ required_error: 'Choose an end date', invalid_type_error: 'Choose an end date' }),
    isActive: z.boolean(),
});

const num = (v, fallback) => (v === '' || v == null ? fallback : Number(v));

/** Dates arrive as 'YYYY-MM-DD' and cover whole days, Indian time. */
export const validateWalletBonusDto = (body = {}) => {
    const result = bonusSchema.safeParse({
        title: String(body.title ?? '').trim().replace(/\s+/g, ' '),
        description: String(body.description ?? '').trim(),
        bonusType: String(body.bonusType || 'percentage'),
        bonusAmount: num(body.bonusAmount, NaN),
        minimumAddAmount: num(body.minimumAddAmount, 0),
        maximumBonus: num(body.maximumBonus, 0),
        startDate: istDayStart(body.startDate) ?? undefined,
        endDate: istDayEnd(body.endDate) ?? undefined,
        isActive: body.isActive === undefined ? true : Boolean(body.isActive),
    });
    if (!result.success) fail(result);
    const data = result.data;
    if (data.endDate < data.startDate) throw new ValidationError('End date must be on or after the start date');
    if (data.bonusType === 'percentage' && data.bonusAmount > 100) {
        throw new ValidationError('A percentage bonus can be at most 100%');
    }
    if (data.bonusType === 'amount') data.maximumBonus = 0;
    return data;
};

const loyaltySchema = z.object({
    isEnabled: z.boolean(),
    pointsPerHundred: z.number({ invalid_type_error: 'Enter the points earned per ₹100' })
        .min(0, 'Points per ₹100 cannot be negative').max(10000, 'Points per ₹100 is too high'),
    pointsPerRupee: z.number({ invalid_type_error: 'Enter the points needed for ₹1' })
        .int('Points needed for ₹1 must be a whole number').min(0, 'Points needed for ₹1 cannot be negative'),
    minimumConvertPoints: z.number({ invalid_type_error: 'Enter the minimum points to convert' })
        .int('Minimum points must be a whole number').min(0, 'Minimum points cannot be negative'),
});

export const validateLoyaltySettingsDto = (body = {}) => {
    const result = loyaltySchema.safeParse({
        isEnabled: Boolean(body.isEnabled),
        pointsPerHundred: num(body.pointsPerHundred, 0),
        pointsPerRupee: num(body.pointsPerRupee, 0),
        minimumConvertPoints: num(body.minimumConvertPoints, 0),
    });
    if (!result.success) fail(result);
    const data = result.data;
    if (data.isEnabled && (data.pointsPerHundred <= 0 || data.pointsPerRupee <= 0)) {
        throw new ValidationError('Set the points earned per ₹100 and the points needed for ₹1 before switching loyalty points on');
    }
    data.pointsPerHundred = Math.round(data.pointsPerHundred * 100) / 100;
    return data;
};
