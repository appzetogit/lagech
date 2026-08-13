import bcrypt from 'bcryptjs';
import { config } from '../../config/env.js';

/**
 * Admin password hashing and comparison.
 *
 * These were a Mongoose pre('save') hook and an instance method on the admin
 * schema. Neither survives the move to Prisma, and both are security-critical:
 * a caller that forgets to hash stores a plaintext password and one that
 * forgets to compare correctly lets anyone in. Keeping them in one place means
 * there is a single obvious thing to call, and only one implementation to audit.
 */

/** Hash a new admin password. Always call this before writing to `password`. */
export const hashAdminPassword = (plain) => bcrypt.hash(String(plain), config.bcryptSaltRounds);

/**
 * Verify a candidate against a stored hash.
 *
 * Returns false rather than throwing on a missing hash, so an account row with
 * no password (created by a script, or mid-migration) fails the login cleanly
 * instead of erroring out of the auth handler.
 */
export const compareAdminPassword = async (candidate, hash) => {
    if (!candidate || !hash) return false;
    return bcrypt.compare(String(candidate), String(hash));
};
