import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../config/prisma.js';
import { logger } from '../../utils/logger.js';
import { startTestServer } from '../../utils/testHttp.js';
import { uniquePhone, uniqueTag } from '../../utils/testIds.js';
import {
    firebaseLoginUser,
    firebaseLoginRestaurant,
    firebaseLoginDelivery,
    requestUserOtp,
    verifyUserOtpAndLogin,
} from './auth.service.js';
import {
    setFirebaseIdTokenVerifier,
    resetFirebaseIdTokenVerifier,
    normalizeFirebasePhone,
} from './firebasePhone.verifier.js';
import { deleteCurrentUserAccount } from '../../modules/food/user/services/userProfile.service.js';
import { saveSystemSettings, getSystemSettings, getPublicBusinessSettings } from '../../modules/food/admin/services/adminSystemExtras.service.js';

/**
 * Firebase phone login. firebase-admin's verifyIdToken is replaced by a stub
 * that reads a fake token of the form "fake:<json claims>", so each test says
 * exactly what Firebase would have vouched for.
 */
const PROJECT = 'pr-2602-048---lagech';

const fakeToken = (claims) => `fake:${Buffer.from(JSON.stringify(claims)).toString('base64url')}`;

const phoneToken = (phone10, extra = {}) => fakeToken({
    aud: PROJECT,
    uid: `uid-${phone10}`,
    phone_number: `+91${phone10}`,
    firebase: { sign_in_provider: 'phone' },
    ...extra,
});

const stubVerifier = async (idToken) => {
    if (!idToken.startsWith('fake:')) {
        const err = new Error('Decoding Firebase ID token failed.');
        err.code = 'auth/argument-error';
        throw err;
    }
    const claims = JSON.parse(Buffer.from(idToken.slice(5), 'base64url').toString('utf8'));
    if (claims.expired) {
        const err = new Error('Firebase ID token has expired.');
        err.code = 'auth/id-token-expired';
        throw err;
    }
    return claims;
};

const created = { users: [], restaurants: [], riders: [], orders: [] };
const logLines = [];
const originalLogger = { ...logger };
let originalLoginSetup = null;
let http = null;

test.before(async () => {
    setFirebaseIdTokenVerifier(stubVerifier, { projectId: PROJECT });
    for (const level of ['info', 'warn', 'error']) {
        logger[level] = (...args) => {
            logLines.push(args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
        };
    }
    originalLoginSetup = (await getSystemSettings('login_setup')).value;
    http = await startTestServer();
});

test.after(async () => {
    resetFirebaseIdTokenVerifier();
    Object.assign(logger, originalLogger);
    if (originalLoginSetup) await saveSystemSettings('login_setup', originalLoginSetup);
    await prisma.foodRefreshToken.deleteMany({ where: { userId: { in: [...created.users, ...created.restaurants, ...created.riders] } } });
    await prisma.foodOrder.deleteMany({ where: { id: { in: created.orders } } });
    await prisma.foodUser.deleteMany({ where: { id: { in: created.users } } });
    await prisma.foodRestaurant.deleteMany({ where: { id: { in: created.restaurants } } });
    await prisma.foodDeliveryPartner.deleteMany({ where: { id: { in: created.riders } } });
    if (http) await http.close();
    await prisma.$disconnect();
});

test('Firebase phone numbers are stored as the 10-digit Indian number', () => {
    assert.equal(normalizeFirebasePhone('+919876543210'), '9876543210');
    assert.equal(normalizeFirebasePhone('+14155550100'), null);
    assert.equal(normalizeFirebasePhone('+9198765'), null);
    assert.equal(normalizeFirebasePhone(''), null);
});

test('a valid phone token creates a new customer, like the OTP verify', async () => {
    const phone = uniquePhone('6');
    const result = await firebaseLoginUser(phoneToken(phone), { name: 'Asha', platform: 'mobile' });
    created.users.push(result.user.id);
    assert.equal(result.user.phone, phone);
    assert.equal(result.user.name, 'Asha');
    assert.equal(result.user.isVerified, true);
    assert.equal(result.isNewUser, true);
    assert.ok(result.accessToken && result.refreshToken);
    const stored = await prisma.foodRefreshToken.findUnique({ where: { token: result.refreshToken } });
    assert.equal(stored.userId, result.user.id);
});

test('a valid phone token logs an existing customer in, with the same response as the OTP verify', async () => {
    const phone = uniquePhone('6');
    const user = await prisma.foodUser.create({ data: { phone, name: 'Ravi', isVerified: true } });
    created.users.push(user.id);

    const viaFirebase = await firebaseLoginUser(phoneToken(phone));
    assert.equal(viaFirebase.user.id, user.id);
    assert.equal(viaFirebase.isNewUser, false);

    // Same account through the SMS OTP path (USE_DEFAULT_OTP is on in tests).
    const { otp } = await requestUserOtp(phone);
    const viaOtp = await verifyUserOtpAndLogin(phone, otp);
    assert.deepEqual(Object.keys(viaFirebase).sort(), Object.keys(viaOtp).sort());
    assert.equal(viaOtp.user.id, user.id);
});

test('a deactivated customer is refused, as with the OTP verify', async () => {
    const phone = uniquePhone('6');
    const user = await prisma.foodUser.create({ data: { phone, name: 'Off', isActive: false } });
    created.users.push(user.id);
    await assert.rejects(
        () => firebaseLoginUser(phoneToken(phone)),
        (err) => err.statusCode === 401 && /deactivated/.test(err.message),
    );
});

test('an anonymised (deleted) customer signs up afresh with the same number, as with the OTP verify', async () => {
    const phone = uniquePhone('6');
    const user = await prisma.foodUser.create({ data: { phone, name: 'Gone' } });
    created.users.push(user.id);
    const restaurant = await prisma.foodRestaurant.create({
        data: { restaurantName: `${uniqueTag('Fb')} Kitchen`, ownerName: 'O', ownerPhone: uniquePhone('9'), status: 'approved' },
    });
    created.restaurants.push(restaurant.id);
    const order = await prisma.foodOrder.create({
        data: {
            userId: user.id, restaurantId: restaurant.id, orderId: uniqueTag('FbO'), orderStatus: 'delivered',
            paymentMethod: 'cash', addrStreet: '1 St', addrCity: 'Indore', addrState: 'MP',
            subtotal: 100, packagingFee: 0, restaurantCommission: 10, total: 100,
        },
    });
    created.orders.push(order.id);
    const deleted = await deleteCurrentUserAccount(user.id);
    assert.equal(deleted.anonymised, true);

    const result = await firebaseLoginUser(phoneToken(phone));
    created.users.push(result.user.id);
    assert.notEqual(result.user.id, user.id);
    assert.equal(result.isNewUser, true);
    const old = await prisma.foodUser.findUnique({ where: { id: user.id } });
    assert.equal(old.isActive, false);
    assert.notEqual(old.phone, phone);
});

test('restaurant: a known approved restaurant logs in, an unknown number is sent to registration', async () => {
    const phone = uniquePhone('8');
    const restaurant = await prisma.foodRestaurant.create({
        data: { restaurantName: `${uniqueTag('Fb')} Dhaba`, ownerName: 'Owner', ownerPhone: phone, status: 'approved' },
    });
    created.restaurants.push(restaurant.id);

    const ok = await firebaseLoginRestaurant(phoneToken(phone), { platform: 'mobile' });
    assert.equal(ok.needsRegistration, false);
    assert.equal(ok.user.id, restaurant.id);
    assert.ok(ok.accessToken && ok.refreshToken);

    const unknown = uniquePhone('8');
    assert.deepEqual(await firebaseLoginRestaurant(phoneToken(unknown)), { needsRegistration: true, phone: unknown });
});

test('restaurant: a new pending registration stays blocked, as with the OTP verify', async () => {
    const phone = uniquePhone('8');
    const restaurant = await prisma.foodRestaurant.create({
        data: { restaurantName: `${uniqueTag('Fb')} New`, ownerName: 'Owner', ownerPhone: phone, status: 'pending' },
    });
    created.restaurants.push(restaurant.id);
    await assert.rejects(() => firebaseLoginRestaurant(phoneToken(phone)), /pending approval/);
});

test('rider: approved logs in, pending gets pendingApproval, unknown needs registration', async () => {
    const approvedPhone = uniquePhone('7');
    const pendingPhone = uniquePhone('7');
    const approved = await prisma.foodDeliveryPartner.create({ data: { name: 'Rider A', phone: approvedPhone, status: 'approved' } });
    const pending = await prisma.foodDeliveryPartner.create({ data: { name: 'Rider P', phone: pendingPhone, status: 'pending' } });
    created.riders.push(approved.id, pending.id);

    const ok = await firebaseLoginDelivery(phoneToken(approvedPhone), { platform: 'mobile' });
    assert.equal(ok.needsRegistration, false);
    assert.equal(ok.user.id, approved.id);
    assert.ok(ok.accessToken);

    const waiting = await firebaseLoginDelivery(phoneToken(pendingPhone));
    assert.equal(waiting.pendingApproval, true);
    assert.equal(waiting.accessToken, undefined);

    const unknown = uniquePhone('7');
    assert.deepEqual(await firebaseLoginDelivery(phoneToken(unknown)), { needsRegistration: true, phone: unknown });
});

test('tokens that do not prove a phone number are refused with 401', async () => {
    const phone = uniquePhone('6');
    const cases = [
        [fakeToken({ aud: PROJECT, phone_number: `+91${phone}`, firebase: { sign_in_provider: 'password' } }), /Only phone number sign-in/],
        [fakeToken({ aud: PROJECT, firebase: { sign_in_provider: 'phone' } }), /no phone number/],
        [phoneToken(phone, { aud: 'some-other-project' }), /different app/],
        [phoneToken(phone, { phone_number: '+14155550100' }), /\+91/],
        [phoneToken(phone, { expired: true }), /expired/],
        ['not-a-firebase-token', /Invalid phone verification token/],
    ];
    for (const [token, message] of cases) {
        await assert.rejects(
            () => firebaseLoginUser(token),
            (err) => err.statusCode === 401 && message.test(err.message),
            String(message),
        );
    }
    assert.equal(await prisma.foodUser.findUnique({ where: { phone } }), null);
});

test('the HTTP endpoints are mounted, validate the body, and map errors to 401', async () => {
    const phone = uniquePhone('6');
    const ok = await http.post('/api/v1/food/auth/user/firebase-login', { body: { idToken: phoneToken(phone), platform: 'mobile' } });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.success, true);
    assert.equal(ok.body.data.user.phone, phone);
    created.users.push(ok.body.data.user.id);

    const missing = await http.post('/api/v1/food/auth/user/firebase-login', { body: {} });
    assert.equal(missing.status, 400);

    for (const role of ['user', 'restaurant', 'delivery']) {
        const bad = await http.post(`/api/v1/food/auth/${role}/firebase-login`, { body: { idToken: 'garbage-token' } });
        assert.equal(bad.status, 401, role);
        assert.match(bad.body.message, /Invalid phone verification token/);
    }
    const expired = await http.post('/api/v1/food/auth/delivery/firebase-login', { body: { idToken: phoneToken(phone, { expired: true }) } });
    assert.equal(expired.status, 401);
    assert.match(expired.body.message, /expired/);
});

test('ID tokens never reach the logs', async () => {
    const secretish = phoneToken(uniquePhone('6'), { firebase: { sign_in_provider: 'password' } });
    await http.post('/api/v1/food/auth/user/firebase-login', { body: { idToken: secretish } });
    await http.post('/api/v1/food/auth/user/firebase-login', { body: { idToken: 'garbage-token-xyz' } });
    assert.ok(logLines.length > 0, 'the error handler logs the failures');
    for (const line of logLines) {
        assert.ok(!line.includes(secretish), 'an ID token was logged');
        assert.ok(!line.includes('garbage-token-xyz'), 'an ID token was logged');
        assert.ok(!line.includes('fake:'), 'an ID token was logged');
    }
});

test('the apps are told which OTP provider to use, Firebase by default', async () => {
    const { otpProvider: _ignored, ...withoutProvider } = originalLoginSetup;
    await saveSystemSettings('login_setup', withoutProvider);
    assert.equal((await getPublicBusinessSettings()).login.otpProvider, 'firebase');

    await saveSystemSettings('login_setup', { ...withoutProvider, otpProvider: 'sms' });
    assert.equal((await getPublicBusinessSettings()).login.otpProvider, 'sms');

    const res = await http.get('/api/v1/food/public/business-settings');
    assert.equal(res.status, 200);
    assert.equal(res.body.data.login.otpProvider, 'sms');

    await saveSystemSettings('login_setup', { ...withoutProvider, otpProvider: 'carrier-pigeon' });
    assert.equal((await getSystemSettings('login_setup')).value.otpProvider, 'firebase');
});
