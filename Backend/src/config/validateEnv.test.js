import test from 'node:test';
import assert from 'node:assert/strict';

import { findConfigProblems } from './validateEnv.js';

/**
 * Boot-time configuration checks.
 *
 * The point of these is that production refuses to start rather than serving
 * traffic it cannot complete. A server missing a payment secret looks healthy
 * to a load balancer and fails one customer at a time.
 */

/** A production configuration with nothing missing. */
const complete = (over = {}) => ({
    nodeEnv: 'production',
    databaseUrl: 'postgresql://localhost/x',
    jwtAccessSecret: 'a',
    jwtRefreshSecret: 'b',
    razorpayKeyId: 'k',
    razorpayKeySecret: 's',
    razorpayWebhookSecret: 'w',
    smsApiKey: 'sms',
    smsSenderId: 'sender',
    smsDltTemplateId: 'dlt',
    firebaseServiceAccount: '{}',
    ...over,
});

test('a complete production configuration is accepted', () => {
    assert.deepEqual(findConfigProblems(complete()), []);
});

test('production refuses to start with the OTP bypass on', () => {
    const problems = findConfigProblems(complete({ useDefaultOtp: true }));

    // Every OTP becomes 1234 and comes back in the login response. Anyone can
    // then sign in as any phone number, including an admin's.
    assert.equal(problems.length, 1);
    assert.match(problems[0], /USE_DEFAULT_OTP/);
});

test('the OTP bypass is allowed outside production', () => {
    const problems = findConfigProblems({
        nodeEnv: 'development',
        databaseUrl: 'x', jwtAccessSecret: 'a', jwtRefreshSecret: 'b',
        useDefaultOtp: true,
    });
    assert.deepEqual(problems, [], 'a developer needs neither a gateway nor an SMS account');
});

test('each production secret is reported by name, with what it breaks', () => {
    for (const field of [
        'razorpayKeyId', 'razorpayKeySecret', 'razorpayWebhookSecret',
        'smsApiKey', 'smsSenderId', 'smsDltTemplateId',
    ]) {
        const problems = findConfigProblems(complete({ [field]: undefined }));
        assert.equal(problems.length, 1, `dropping ${field} should be the only problem`);
        // The name of the variable to set, and the consequence of not setting
        // it — an error naming neither is one nobody can act on.
        assert.match(problems[0], /^[A-Z0-9_ or]+ is not set — .+\.$/);
    }
});

test('either form of the Firebase credential satisfies the check', () => {
    const viaPath = complete({ firebaseServiceAccount: undefined, firebaseServiceAccountPath: '/x.json' });
    assert.deepEqual(findConfigProblems(viaPath), []);

    const neither = complete({ firebaseServiceAccount: undefined });
    assert.equal(findConfigProblems(neither).length, 1);
});

test('the things with no safe default are demanded everywhere', () => {
    const problems = findConfigProblems({ nodeEnv: 'development' });

    // No database and no way to sign a token: nothing works in any environment.
    assert.equal(problems.length, 3);
    assert.ok(problems.some((p) => p.startsWith('DATABASE_URL')));
    assert.ok(problems.some((p) => p.includes('JWT_ACCESS_SECRET')));
    assert.ok(problems.some((p) => p.includes('JWT_REFRESH_SECRET')));
});

test('a dependency that is switched on has to be configured', () => {
    const noUrl = findConfigProblems(complete({ redisEnabled: true }));
    assert.equal(noUrl.length, 1);
    assert.match(noUrl[0], /REDIS_URL/);

    // Queues run on Redis, so asking for one without the other cannot work.
    const noRedis = findConfigProblems(complete({ bullmqEnabled: true }));
    assert.equal(noRedis.length, 1);
    assert.match(noRedis[0], /BULLMQ_ENABLED/);
});
