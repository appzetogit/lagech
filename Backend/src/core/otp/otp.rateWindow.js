/**
 * Per-phone OTP rate-window arithmetic.
 *
 * Deliberately dependency-free (no mongoose, no config, no logger) so the
 * window logic can be unit-tested in isolation — see otp.rateWindow.test.js.
 */

/**
 * Decides whether a new OTP request for a phone is within its quota.
 *
 * FIXED window anchored on `windowStartedAt`, not a sliding one anchored on
 * `lastRequestAt`. The previous implementation measured the window against
 * lastRequestAt, which was rewritten to `now` on every accepted request — so
 * the window slid forward indefinitely. With a 10-minute window, requests at
 * t=0, t=9min and t=18min were all judged "in window" and the third was
 * rejected, even though the user never sent more than one request per 9
 * minutes. That is the bug that locked legitimate users out of OTP login.
 *
 * @param {{requestCount?: number, windowStartedAt?: Date, lastRequestAt?: Date}|null} existing
 * @param {Date} now
 * @param {{windowMs: number, limit: number}} options
 * @returns {{allowed: boolean, requestCount: number, windowStartedAt: Date, retryAfterSeconds: number}}
 */
export const evaluateOtpRateWindow = (existing, now, { windowMs, limit }) => {
    if (!existing) {
        return { allowed: true, requestCount: 1, windowStartedAt: now, retryAfterSeconds: 0 };
    }

    // lastRequestAt fallback covers documents written before windowStartedAt existed.
    const windowStart = existing.windowStartedAt || existing.lastRequestAt || now;
    const windowEndsAt = new Date(windowStart).getTime() + windowMs;

    if (now.getTime() >= windowEndsAt) {
        // Window fully elapsed — start a new one.
        return { allowed: true, requestCount: 1, windowStartedAt: now, retryAfterSeconds: 0 };
    }

    if ((existing.requestCount || 0) >= limit) {
        return {
            allowed: false,
            requestCount: existing.requestCount,
            windowStartedAt: new Date(windowStart),
            retryAfterSeconds: Math.ceil((windowEndsAt - now.getTime()) / 1000),
        };
    }

    return {
        allowed: true,
        requestCount: (existing.requestCount || 0) + 1,
        windowStartedAt: new Date(windowStart),
        retryAfterSeconds: 0,
    };
};
