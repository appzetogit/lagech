import { z } from 'zod';
import { ValidationError } from '../../core/auth/errors.js';
import { normalizePlatform } from '../../utils/platform.js';

const schema = z.object({
    // The apps sometimes have no refresh token left (null) when logging out;
    // the device's push token must still be detached, so neither is required.
    refreshToken: z.string().nullish(),
    fcmToken: z.string().nullish(),
    platform: z.preprocess(
        (value) => normalizePlatform(value, { allowUndefined: true }),
        z.enum(['web', 'mobile']).optional()
    )
});

export const validateLogoutDto = (body) => {
    const result = schema.safeParse(body);
    if (!result.success) {
        throw new ValidationError(result.error.errors[0].message);
    }
    return result.data;
};
