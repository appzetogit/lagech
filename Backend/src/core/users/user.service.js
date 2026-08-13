import { prisma } from '../../config/prisma.js';
import { buildPaginationOptions, buildPaginatedResult } from '../../utils/helpers.js';

/**
 * Look up a customer by phone, creating them on first sign-in.
 *
 * An upsert rather than find-then-create: OTP verification is the only caller,
 * and two requests for the same phone landing together would otherwise both see
 * "no user" and both insert, with one failing on the unique phone.
 */
export const findOrCreateUserByPhone = async ({ phone, countryCode = '+91' }) =>
    prisma.foodUser.upsert({
        where: { phone },
        create: { phone, countryCode },
        // Writing `phone` back to itself is a deliberate no-op, not a mistake.
        // Prisma only compiles an upsert to INSERT ... ON CONFLICT when `update`
        // is non-empty; with `update: {}` it degrades to SELECT-then-INSERT and
        // two simultaneous first logins for the same phone both insert, with one
        // failing on the unique. Everything else the customer already has is
        // deliberately untouched — writing countryCode here would overwrite a
        // corrected one on every login.
        update: { phone },
    });

export const getUsers = async (query) => {
    const { page, limit, skip } = buildPaginationOptions(query);

    const [docs, total] = await Promise.all([
        prisma.foodUser.findMany({ skip, take: limit, orderBy: { createdAt: 'desc' } }),
        prisma.foodUser.count(),
    ]);

    return buildPaginatedResult({ docs, total, page, limit });
};
