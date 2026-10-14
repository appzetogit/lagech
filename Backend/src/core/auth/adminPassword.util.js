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
 *
 * Restaurant employees use the same two (as hashPassword / comparePassword).
 */

/** Hash a new admin password. Always call this before writing to `password`. */
export const hashAdminPassword = (plain) => bcrypt.hash(String(plain), config.bcryptSaltRounds);

/**
 * The old Laravel system's bcrypt hashes start `$2y$`, PHP's name for the
 * same algorithm as `$2b$`. Rewriting the prefix lets any bcrypt library
 * check them, so imported accounts sign in with the passwords they had.
 */
export const normalizeBcryptHash = (hash) => String(hash || '').replace(/^\$2y\$/, '$2b$');

/**
 * Verify a candidate against a stored hash.
 *
 * Returns false rather than throwing on a missing hash, so an account row with
 * no password (created by a script, or mid-migration) fails the login cleanly
 * instead of erroring out of the auth handler. A stored value that is not a
 * bcrypt hash at all is a failed login too, never a plaintext comparison.
 */
export const compareAdminPassword = async (candidate, hash) => {
    if (!candidate || !hash) return false;
    const normalized = normalizeBcryptHash(hash);
    if (!/^\$2[abxy]?\$\d\d\$/.test(normalized)) return false;
    try {
        return await bcrypt.compare(String(candidate), normalized);
    } catch {
        return false;
    }
};

export const hashPassword = hashAdminPassword;
export const comparePassword = compareAdminPassword;
