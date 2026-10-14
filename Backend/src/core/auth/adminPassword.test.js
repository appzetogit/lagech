import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';

import { compareAdminPassword, hashAdminPassword, normalizeBcryptPrefix } from './adminPassword.util.js';

/**
 * Admins brought over from the old PHP panel keep the "$2y$" hash PHP wrote.
 * Same algorithm as "$2b$"; only the label differs. These pin that such a
 * hash logs in with its password, and with nothing else.
 */
const phpStyle = (plain) => `$2y$${bcrypt.hashSync(plain, 4).slice(4)}`;

test('a $2y$ hash from the old panel accepts its password', async () => {
    const hash = phpStyle('Old-panel pass 1');
    assert.ok(hash.startsWith('$2y$'));
    assert.equal(await compareAdminPassword('Old-panel pass 1', hash), true);
});

test('a $2y$ hash still refuses a wrong, empty or near-miss password', async () => {
    const hash = phpStyle('Old-panel pass 1');
    for (const wrong of ['old-panel pass 1', 'Old-panel pass 2', 'Old-panel pass 1 ', '', null, undefined]) {
        assert.equal(await compareAdminPassword(wrong, hash), false, String(wrong));
    }
});

test('hashes made here are compared exactly as before', async () => {
    const hash = await hashAdminPassword('New pass 9');
    assert.match(hash, /^\$2[ab]\$/);
    assert.equal(await compareAdminPassword('New pass 9', hash), true);
    assert.equal(await compareAdminPassword('New pass 8', hash), false);
    assert.equal(await compareAdminPassword('New pass 9', ''), false, 'no hash never matches');
});

test('only the exact $2y$ prefix is relabelled', () => {
    assert.equal(normalizeBcryptPrefix('$2y$10$abc'), '$2b$10$abc');
    for (const other of ['$2a$10$abc', '$2b$10$abc', 'plaintext', '2y$10$abc', 'x$2y$10$abc']) {
        assert.equal(normalizeBcryptPrefix(other), other);
    }
});

test('a plaintext value in the password column is not a password', async () => {
    // A row with the password stored raw must not let that raw value in.
    assert.equal(await compareAdminPassword('hunter2', 'hunter2').catch(() => false), false);
});
