import { z } from 'zod';
import { ValidationError } from '../../core/auth/errors.js';
import { normalizePlatform } from '../../utils/platform.js';

/**
 * Firebase phone login bodies: the Firebase ID token plus the same optional
 * fields each role's verify-otp accepts. No phone field is read — the phone
 * comes from the verified token, never from the client.
 */
const idToken = z
    .string({ required_error: 'idToken is required', invalid_type_error: 'idToken must be a string' })
    .trim()
    .min(1, 'idToken is required')
    .max(8192, 'idToken is too long');

const userSchema = z.object({
    idToken,
    ref: z.string().trim().max(64).optional().or(z.literal('')),
    fcmToken: z.string().optional().nullable(),
    platform: z.preprocess(
        (value) => normalizePlatform(value, { allowUndefined: true }),
        z.enum(['web', 'mobile']).optional(),
    ),
    name: z.string().trim().min(2, 'Name must be at least 2 characters').max(100).optional(),
});

// Restaurant and rider verify-otp default the platform to 'web'; kept identical.
const partnerSchema = z.object({
    idToken,
    fcmToken: z.string().optional().nullable(),
    platform: z.preprocess(
        (value) => normalizePlatform(value, { allowUndefined: true }),
        z.enum(['web', 'mobile']).optional().default('web'),
    ),
});

const parse = (schema, body) => {
    const result = schema.safeParse(body ?? {});
    if (!result.success) {
        throw new ValidationError(result.error.errors[0].message);
    }
    return result.data;
};

export const validateUserFirebaseLoginDto = (body) => parse(userSchema, body);
export const validateRestaurantFirebaseLoginDto = (body) => parse(partnerSchema, body);
export const validateDeliveryFirebaseLoginDto = (body) => parse(partnerSchema, body);
