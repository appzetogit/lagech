import { z } from 'zod';
import { ValidationError } from '../../../../core/auth/errors.js';

/**
 * Request shapes for withdrawal methods, restaurant payments, social links,
 * email templates and settings. These check structure; the services check
 * meaning (a field's type, a balance, a placeholder) and own the messages.
 */

const flag = z.union([z.boolean(), z.enum(['true', 'false'])]).optional();
const amount = z.union([z.number(), z.string().regex(/^\d+(\.\d{1,2})?$/, 'Amount must be a number')]);

const fieldSchema = z.object({
    key: z.string().max(60).optional(),
    label: z.string().max(200),
    type: z.string().max(20).optional(),
    required: flag,
    placeholder: z.string().max(300).optional(),
});

export const withdrawalMethodSchema = z.object({
    name: z.string().max(200).optional(),
    fields: z.array(fieldSchema).max(50).optional(),
    isActive: flag,
    isDefault: flag,
    sortOrder: z.union([z.number(), z.string()]).optional(),
});

export const payoutDetailsSchema = z.object({
    methodId: z.string().min(1, 'Choose a payout method').max(24),
    values: z.record(z.union([z.string(), z.number()])).optional(),
});

export const restaurantPaymentSchema = z.object({
    restaurantId: z.string().min(1, 'Choose a restaurant').max(24),
    amount,
    method: z.string().max(40),
    reference: z.string().max(200).optional(),
    note: z.string().max(1000).optional(),
    requestKey: z.string().max(64).optional(),
});

export const socialLinkSchema = z.object({
    platform: z.string().max(100).optional(),
    url: z.string().max(1000).optional(),
    isActive: flag,
    sortOrder: z.union([z.number(), z.string()]).optional(),
});

export const emailTemplateSchema = z.object({
    subject: z.string().max(1000),
    body: z.string().max(60000),
    isActive: flag,
    values: z.record(z.union([z.string(), z.number()])).optional(),
});

export const settingsSchema = z.object({ value: z.record(z.any()) }).or(z.record(z.any()));

/** Parse or throw a ValidationError with the first problem, in plain words. */
export function validate(schema, body) {
    const result = schema.safeParse(body ?? {});
    if (!result.success) {
        const issue = result.error.issues[0];
        const where = issue?.path?.length ? `${issue.path.join('.')}: ` : '';
        throw new ValidationError(`${where}${issue?.message || 'Invalid request'}`);
    }
    return result.data;
}
