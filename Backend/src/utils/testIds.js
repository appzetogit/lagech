import { randomBytes } from 'crypto';

/**
 * Unique phone numbers for tests.
 *
 * Test files each built their own from `Date.now()`, and two of those schemes
 * collided: `55` + the last 8 digits produces the same 10-digit number as `5` +
 * the last 9 whenever the timestamp's ninth-from-last digit is a 5. Phones are
 * unique on users and delivery partners, so the loser of that collision failed
 * — rarely, in whichever file happened to run alongside.
 *
 * Random rather than time-based, because node runs test files in parallel and
 * a shared clock is exactly what caused the problem.
 *
 * @param {string} prefix leading digit(s); the rest is filled randomly to 10.
 */
export const uniquePhone = (prefix = '9') => {
    const digits = 10 - String(prefix).length;
    const value = randomBytes(8).readBigUInt64BE() % 10n ** BigInt(digits);
    return `${prefix}${String(value).padStart(digits, '0')}`;
};

/** A short unique token for names, codes and search terms in tests. */
export const uniqueTag = (prefix = 'T') => `${prefix}${randomBytes(6).toString('hex')}`;
