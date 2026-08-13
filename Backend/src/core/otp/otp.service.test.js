import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../config/prisma.js';
import { createOrUpdateOtp, verifyOtp } from './otp.service.js';
import { findOrCreateUserByPhone } from '../users/user.service.js';
import { hashAdminPassword, compareAdminPassword } from '../auth/adminPassword.util.js';

/**
 * OTP issue/verify and the admin password helpers.
 *
 * The OTP row is now unique per phone, which is what makes "one live code" a
 * guarantee rather than an assumption — previously a duplicate row made the
 * lookup nondeterministic and let a stale code verify.
 *
 * Assumes USE_DEFAULT_OTP so no SMS is sent; the code is then '1234'.
 */
const live = Boolean(process.env.DATABASE_URL) && process.env.USE_DEFAULT_OTP === 'true';

const phone = () => `55${String(Date.now()).slice(-8)}`;
const created = [];

const issue = async (p) => {
    created.push(p);
    return createOrUpdateOtp(p);
};

test.after(async () => {
    if (!live) return;
    await prisma.foodOtp.deleteMany({ where: { phone: { in: created } } });
    await prisma.foodUser.deleteMany({ where: { phone: { in: created } } });
    await prisma.$disconnect();
});

test('hashing a password never stores it in the clear', async () => {
    const hash = await hashAdminPassword('correct horse');
    assert.notEqual(hash, 'correct horse');
    assert.ok(hash.startsWith('$2'), 'bcrypt hash');
    assert.equal(await compareAdminPassword('correct horse', hash), true);
    assert.equal(await compareAdminPassword('wrong', hash), false);
});

test('comparing against a missing hash fails cleanly', async () => {
    // An account row with no password (created by a script, or mid-migration)
    // must fail the login rather than throw out of the auth handler.
    assert.equal(await compareAdminPassword('anything', null), false);
    assert.equal(await compareAdminPassword('', 'somehash'), false);
});

test('issuing an OTP twice keeps exactly one row', { skip: !live }, async () => {
    const p = phone();
    await issue(p);
    await createOrUpdateOtp(p);

    const rows = await prisma.foodOtp.findMany({ where: { phone: p } });
    assert.equal(rows.length, 1, 'one live code per phone');
    assert.equal(rows[0].requestCount, 2, 'the quota counter accumulates');
});

test('re-issuing resets the attempt counter', { skip: !live }, async () => {
    const p = phone();
    await issue(p);
    await verifyOtp(p, '9999');

    let row = await prisma.foodOtp.findUnique({ where: { phone: p } });
    assert.equal(row.attempts, 1);

    await createOrUpdateOtp(p);
    row = await prisma.foodOtp.findUnique({ where: { phone: p } });
    assert.equal(row.attempts, 0, 'a fresh code starts with a fresh allowance');
});

test('a wrong code is counted, a right one is consumed', { skip: !live }, async () => {
    const p = phone();
    const code = await issue(p);

    assert.deepEqual(await verifyOtp(p, 'nope'), { valid: false, reason: 'Invalid OTP' });
    assert.equal((await prisma.foodOtp.findUnique({ where: { phone: p } })).attempts, 1);

    assert.deepEqual(await verifyOtp(p, code), { valid: true });
    assert.equal(
        await prisma.foodOtp.findUnique({ where: { phone: p } }),
        null,
        'a used code must not be replayable',
    );
});

test('parallel wrong guesses each cost an attempt', { skip: !live }, async () => {
    const p = phone();
    await issue(p);

    // Read-modify-write would let several guesses share one attempt, handing an
    // attacker free tries.
    await Promise.all(['1', '2', '3'].map((g) => verifyOtp(p, g)));

    const row = await prisma.foodOtp.findUnique({ where: { phone: p } });
    assert.equal(row.attempts, 3);
});

test('verifying an unknown phone is not an error', { skip: !live }, async () => {
    assert.deepEqual(await verifyOtp('00000000000', '1234'), { valid: false, reason: 'OTP not found' });
});

test('an expired code is refused', { skip: !live }, async () => {
    const p = phone();
    const code = await issue(p);
    await prisma.foodOtp.update({
        where: { phone: p },
        data: { expiresAt: new Date(Date.now() - 1000) },
    });

    assert.deepEqual(await verifyOtp(p, code), { valid: false, reason: 'OTP expired' });
});

test('finding a customer by phone is idempotent under concurrency', { skip: !live }, async () => {
    const p = phone();
    created.push(p);

    // Two OTP verifications for the same phone landing together both used to see
    // "no user" and both insert, and one lost to the unique constraint.
    const users = await Promise.all([
        findOrCreateUserByPhone({ phone: p }),
        findOrCreateUserByPhone({ phone: p }),
    ]);

    assert.equal(users[0].id, users[1].id);
    assert.equal(await prisma.foodUser.count({ where: { phone: p } }), 1);
});
