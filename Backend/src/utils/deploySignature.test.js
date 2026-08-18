import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';

import { verifyDeploySignature } from './deploySignature.js';

/**
 * The guard on /api/deploy, which runs a shell script on the server.
 *
 * These do not need a database — the point is that the check is exercisable at
 * all. It previously sat inline in startServer() with the secret hardcoded, so
 * nothing could reach it.
 */
const SECRET = 'a-test-secret';
const sign = (payload, secret = SECRET) =>
    `sha256=${crypto.createHmac('sha256', secret).update(payload).digest('hex')}`;

test('a correct signature passes', () => {
    const payload = JSON.stringify({ ref: 'refs/heads/main' });
    assert.equal(
        verifyDeploySignature({ payload, signature: sign(payload), secret: SECRET }),
        true,
    );
});

test('a signature from a different secret is refused', () => {
    const payload = JSON.stringify({ ref: 'refs/heads/main' });
    // The whole point of moving the secret out of the file: knowing the code
    // must not be enough to forge this.
    assert.equal(
        verifyDeploySignature({ payload, signature: sign(payload, 'wrong'), secret: SECRET }),
        false,
    );
});

test('a signature for a different payload is refused', () => {
    const signed = sign(JSON.stringify({ ref: 'refs/heads/main' }));
    assert.equal(
        verifyDeploySignature({
            payload: JSON.stringify({ ref: 'refs/heads/attacker' }),
            signature: signed,
            secret: SECRET,
        }),
        false,
    );
});

test('an absent secret or signature never passes', () => {
    const payload = '{}';
    // The dangerous failure mode: no secret configured must mean "refuse", not
    // "nothing to compare against, so allow".
    assert.equal(verifyDeploySignature({ payload, signature: sign(payload), secret: '' }), false);
    assert.equal(verifyDeploySignature({ payload, signature: sign(payload), secret: undefined }), false);
    assert.equal(verifyDeploySignature({ payload, signature: '', secret: SECRET }), false);
    assert.equal(verifyDeploySignature({ payload, signature: undefined, secret: SECRET }), false);
});

test('a malformed or truncated signature is refused, not thrown on', () => {
    const payload = '{}';
    const valid = sign(payload);

    // timingSafeEqual throws on a length mismatch, so the length is checked
    // first — otherwise a short header would 500 instead of 403.
    for (const signature of [
        'garbage',
        valid.slice(0, -1),
        valid.replace('sha256=', ''),
        `${valid}extra`,
        'sha256=',
    ]) {
        assert.equal(
            verifyDeploySignature({ payload, signature, secret: SECRET }),
            false,
            `should refuse: ${signature.slice(0, 24)}`,
        );
    }
});

test('a signature differing only in the last byte is refused', () => {
    const payload = '{}';
    const valid = sign(payload);
    const lastChar = valid.at(-1);
    const tampered = valid.slice(0, -1) + (lastChar === '0' ? '1' : '0');

    // Same length, correct prefix — the case a non-constant-time compare would
    // still get right, but which proves the comparison runs to the end.
    assert.equal(verifyDeploySignature({ payload, signature: tampered, secret: SECRET }), false);
});
