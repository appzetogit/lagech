/**
 * Regression tests for the per-phone OTP rate window.
 *
 * Run: node --test src/core/otp/otp.rateWindow.test.js
 *
 * The headline case is `spaced-out requests are never throttled` — that is the
 * exact bug that locked legitimate users out of OTP login.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateOtpRateWindow } from './otp.rateWindow.js';

const WINDOW_MS = 600_000; // 10 min, matches OTP_RATE_WINDOW default
const LIMIT = 3; // matches OTP_RATE_LIMIT default
const opts = { windowMs: WINDOW_MS, limit: LIMIT };

const at = (minutes) => new Date(Date.UTC(2026, 0, 1, 0, minutes, 0));

test('first ever request for a phone is allowed', () => {
    const result = evaluateOtpRateWindow(null, at(0), opts);
    assert.equal(result.allowed, true);
    assert.equal(result.requestCount, 1);
});

test('requests within the window accumulate up to the limit', () => {
    let record = { requestCount: 1, windowStartedAt: at(0), lastRequestAt: at(0) };

    const second = evaluateOtpRateWindow(record, at(1), opts);
    assert.equal(second.allowed, true);
    assert.equal(second.requestCount, 2);

    record = { ...record, requestCount: second.requestCount, lastRequestAt: at(1) };
    const third = evaluateOtpRateWindow(record, at(2), opts);
    assert.equal(third.allowed, true);
    assert.equal(third.requestCount, 3);

    record = { ...record, requestCount: third.requestCount, lastRequestAt: at(2) };
    const fourth = evaluateOtpRateWindow(record, at(3), opts);
    assert.equal(fourth.allowed, false, ' 4th request inside the window must be blocked');
});

test('the window anchor does not move when a request is accepted', () => {
    const record = { requestCount: 1, windowStartedAt: at(0), lastRequestAt: at(0) };
    const result = evaluateOtpRateWindow(record, at(5), opts);
    assert.equal(result.windowStartedAt.getTime(), at(0).getTime());
});

test('quota resets once the window has fully elapsed', () => {
    const record = { requestCount: LIMIT, windowStartedAt: at(0), lastRequestAt: at(2) };

    assert.equal(evaluateOtpRateWindow(record, at(9), opts).allowed, false);

    const afterWindow = evaluateOtpRateWindow(record, at(10), opts);
    assert.equal(afterWindow.allowed, true, 'quota must reset at windowStartedAt + windowMs');
    assert.equal(afterWindow.requestCount, 1);
    assert.equal(afterWindow.windowStartedAt.getTime(), at(10).getTime());
});

test('REGRESSION: spaced-out requests are never throttled', () => {
    // One request every 9 minutes: below 3-per-10-minutes at every point.
    // The old sliding window re-anchored on lastRequestAt, so the 3rd request
    // (t=18min) was judged "in window" relative to t=9min and got rejected.
    let record = null;
    for (const minute of [0, 9, 18, 27, 36, 45, 54, 63, 72]) {
        const result = evaluateOtpRateWindow(record, at(minute), opts);
        assert.equal(result.allowed, true, `request at t=${minute}min must be allowed`);
        // The count may reach 2 (t=0 and t=9 share one 10-minute window) but must
        // never hit the limit, because the anchor stops sliding forward.
        assert.ok(
            result.requestCount < LIMIT,
            `t=${minute}min: count ${result.requestCount} must stay under the limit`,
        );
        record = {
            requestCount: result.requestCount,
            windowStartedAt: result.windowStartedAt,
            lastRequestAt: at(minute),
        };
    }
});

test('a blocked request reports a positive, shrinking Retry-After', () => {
    const record = { requestCount: LIMIT, windowStartedAt: at(0), lastRequestAt: at(1) };

    const early = evaluateOtpRateWindow(record, at(2), opts);
    const late = evaluateOtpRateWindow(record, at(8), opts);

    assert.equal(early.allowed, false);
    assert.equal(early.retryAfterSeconds, 8 * 60);
    assert.equal(late.retryAfterSeconds, 2 * 60);
    assert.ok(late.retryAfterSeconds < early.retryAfterSeconds);
    assert.ok(late.retryAfterSeconds > 0);
});

test('legacy records without windowStartedAt fall back to lastRequestAt', () => {
    // Documents written before the windowStartedAt field existed.
    const legacy = { requestCount: LIMIT, lastRequestAt: at(0) };
    assert.equal(evaluateOtpRateWindow(legacy, at(5), opts).allowed, false);
    assert.equal(evaluateOtpRateWindow(legacy, at(10), opts).allowed, true);
});
