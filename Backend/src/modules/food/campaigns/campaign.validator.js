import { z } from 'zod';
import { ValidationError } from '../../../core/auth/errors.js';
import { discountErrors, scheduleErrors } from './campaignSchedule.js';

const media = z
    .string()
    .trim()
    .max(2000)
    .refine((v) => !v || /^(https?:\/\/|\/uploads\/)/.test(v), 'Images must be uploaded files');

const when = z.preprocess((v) => (v === '' || v === null ? undefined : v), z.coerce.date({ invalid_type_error: 'Invalid date' }).optional());

const common = {
    title: z.string().trim().min(1, 'Title is required').max(120, 'Title must be 120 characters or fewer'),
    description: z.string().trim().max(1000, 'Description must be 1000 characters or fewer').optional(),
    image: media.optional(),
    startsAt: when,
    endsAt: when,
    isActive: z.boolean().optional(),
};

const basicSchema = z.object(common);

const foodSchema = z.object({
    ...common,
    restaurantId: z.string().regex(/^[a-f0-9]{24}$/i, 'Choose a restaurant'),
    price: z.coerce.number({ invalid_type_error: 'Price must be a number' }),
    discountType: z.enum(['percent', 'amount']).optional(),
    discount: z.coerce.number({ invalid_type_error: 'Discount must be a number' }).optional(),
    foodType: z.enum(['Veg', 'Non-Veg']).optional(),
});

const parse = (schema, body) => {
    const result = schema.safeParse(body ?? {});
    if (!result.success) throw new ValidationError(result.error.errors[0]?.message || 'Invalid campaign');
    return result.data;
};

/**
 * A campaign body, whole (create) or partial (edit). For an edit the stored
 * row is passed so the schedule and discount are checked as they will be once
 * the change lands, not just the fields sent.
 */
function check(schema, body, existing, extra) {
    const data = parse(existing ? schema.partial() : schema, body);
    const merged = { ...(existing || {}), ...data };
    const errors = [...scheduleErrors(merged.startsAt, merged.endsAt), ...(extra ? extra(merged) : [])];
    if (errors.length) throw new ValidationError(errors[0]);
    return data;
}

export const validateBasicCampaign = (body, existing = null) => check(basicSchema, body, existing);

export const validateFoodCampaign = (body, existing = null) =>
    check(foodSchema, body, existing, (m) =>
        discountErrors(Number(m.price), m.discountType || 'percent', Number(m.discount || 0)));
