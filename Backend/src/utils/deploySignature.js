import crypto from 'crypto';

/**
 * Verifies the HMAC on the deploy webhook.
 *
 * Extracted from the route so it can be tested: the endpoint it guards runs a
 * shell script on the server, and a check nobody can exercise is not a check.
 *
 * The secret used to be a literal in server.js. Anything signed with that old
 * value should be treated as public — it is in the git history — so rotate it
 * rather than moving it into the environment unchanged.
 */
export const verifyDeploySignature = ({ payload, signature, secret }) => {
    if (!secret || !signature) return false;

    const expected = `sha256=${crypto.createHmac('sha256', secret).update(payload).digest('hex')}`;
    const received = String(signature);

    // Constant-time. `!==` returns at the first differing byte, which leaks how
    // much of a guess was correct — enough to recover a signature one request
    // at a time. timingSafeEqual throws on a length mismatch, so that is
    // checked first, and lengths are fixed here anyway.
    if (received.length !== expected.length) return false;
    return crypto.timingSafeEqual(Buffer.from(received), Buffer.from(expected));
};
