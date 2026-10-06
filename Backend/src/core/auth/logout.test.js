import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../config/prisma.js';
import { logout } from './auth.service.js';
import { validateLogoutDto } from '../../dtos/auth/logout.dto.js';

test.after(async () => {
    await prisma.$disconnect();
});

test('the apps may log out with a null refresh token', () => {
    const dto = validateLogoutDto({ refreshToken: null, fcmToken: 'device-token', platform: 'mobile' });
    assert.equal(dto.refreshToken, null);
    assert.equal(dto.fcmToken, 'device-token');
});

test('logging out with only a push token detaches it and succeeds', async () => {
    const result = await logout(null, `logout-test-${Date.now()}`, 'mobile');
    assert.deepEqual(result, { invalidated: false });
});

test('logging out with neither token is refused', async () => {
    await assert.rejects(() => logout(null, null), /Refresh token is required/);
});

test('an unknown refresh token reports nothing invalidated', async () => {
    const result = await logout(`no-such-token-${Date.now()}`);
    assert.deepEqual(result, { invalidated: false });
});
