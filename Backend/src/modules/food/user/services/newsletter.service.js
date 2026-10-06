import { prisma } from '../../../../config/prisma.js';
import { ValidationError } from '../../../../core/auth/errors.js';
import { normalizeEmail } from '../../shared/customerRewards.util.js';

/**
 * Newsletter sign-up (public, no login). Subscribing an address that is
 * already on the list is not an error -- it simply stays subscribed -- so the
 * endpoint is safe to call twice.
 */
export const subscribeToNewsletter = async (rawEmail) => {
    const email = normalizeEmail(rawEmail);
    if (!email) throw new ValidationError('Enter a valid email address');

    // ON CONFLICT DO NOTHING: two sign-ups racing cannot trip the unique key.
    // The answer is the same whether or not the address was already there, so
    // the endpoint cannot be used to check who is on the list.
    await prisma.foodNewsletterSubscriber.createMany({
        data: [{ email }],
        skipDuplicates: true,
    });
    return { subscribed: true };
};
