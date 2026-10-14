import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';

import { prisma } from '../../../../config/prisma.js';
import { startTestServer, tokenFor } from '../../../../utils/testHttp.js';
import { uniquePhone, uniqueTag } from '../../../../utils/testIds.js';

/**
 * Restaurant staff over the real HTTP API: the owner sets up a role and an
 * employee, the employee signs in with email or phone + password and is held
 * to the role, the owner's own token is untouched, and an old Laravel hash
 * signs in as it is.
 */
const tag = uniqueTag('EMP');
const made = { restaurants: [] };
let http;
let restaurant;
let ownerToken;

test.before(async () => {
    http = await startTestServer();
    restaurant = await prisma.foodRestaurant.create({
        data: {
            restaurantName: `${tag} Kitchen`, ownerName: 'Owner', ownerPhone: uniquePhone('9'),
            status: 'approved', approvedAt: new Date(), city: 'Indore',
            accountNumber: '123456789012', ifscCode: 'HDFC0000001', accountHolderName: 'Owner', upiId: 'owner@upi',
        },
    });
    made.restaurants.push(restaurant.id);
    ownerToken = tokenFor({ userId: restaurant.id, role: 'RESTAURANT' });
});

test.after(async () => {
    const employees = await prisma.foodRestaurantEmployee.findMany({ where: { restaurantId: { in: made.restaurants } }, select: { id: true } });
    await prisma.foodRefreshToken.deleteMany({ where: { userId: { in: employees.map((e) => e.id) } } });
    // Employees and roles go with the restaurant (ON DELETE CASCADE).
    await prisma.foodRestaurant.deleteMany({ where: { id: { in: made.restaurants } } });
    await http?.close();
    await prisma.$disconnect();
});

const api = (token, method, path, body) =>
    http.request(method, `/api/v1/food/restaurant${path}`, { token, ...(body !== undefined ? { body } : {}) });
const login = (body) => http.post('/api/v1/food/auth/restaurant-employee/login', { body });

const makeRole = async (name, permissions, token = ownerToken) => {
    const res = await api(token, 'POST', '/employee-roles', { name, permissions });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body.data.role;
};
const makeEmployee = async (roleId, over = {}, token = ownerToken) => {
    const res = await api(token, 'POST', '/employees', {
        firstName: 'Asha', lastName: 'Cook', email: `${uniqueTag('e').toLowerCase()}@staff.test`,
        phone: `+91${uniquePhone('7')}`, password: 'Kitchen#1', roleId, ...over,
    });
    return res;
};

test('the owner creates a role and an employee; the employee signs in by email or phone', async () => {
    const role = await makeRole(`${tag} Order desk`, ['orders', 'nope']);
    assert.deepEqual(role.permissions, ['orders'], 'unknown keys dropped');

    const created = await makeEmployee(role.id, { email: `Desk.${tag}@Staff.test` });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const employee = created.body.data.employee;
    assert.equal(employee.email, `desk.${tag.toLowerCase()}@staff.test`);
    assert.equal(employee.password, undefined, 'the hash never leaves the server');
    assert.equal(employee.role.name, `${tag} Order desk`);

    const listed = await api(ownerToken, 'GET', '/employees');
    assert.equal(listed.status, 200);
    assert.ok(listed.body.data.employees.some((e) => e.id === employee.id));
    const roles = await api(ownerToken, 'GET', '/employee-roles');
    assert.equal(roles.body.data.roles.find((r) => r.id === role.id).employeeCount, 1);

    const wrong = await login({ email: employee.email, password: 'nope-nope' });
    assert.equal(wrong.status, 401);

    const byEmail = await login({ email: employee.email.toUpperCase(), password: 'Kitchen#1' });
    assert.equal(byEmail.status, 200, JSON.stringify(byEmail.body));
    assert.ok(byEmail.body.data.accessToken && byEmail.body.data.refreshToken);
    assert.equal(byEmail.body.data.user.id, restaurant.id, 'the session is the restaurant\'s');
    assert.deepEqual(byEmail.body.data.employee.permissions, ['orders']);
    assert.equal(byEmail.body.data.user.accountNumber, undefined);

    const byPhone = await login({ identifier: employee.phone.slice(-10), password: 'Kitchen#1' });
    assert.equal(byPhone.status, 200, JSON.stringify(byPhone.body));
    const token = byPhone.body.data.accessToken;

    // Single device, like the owner: the email sign-in's session is gone.
    const stale = await api(byEmail.body.data.accessToken, 'GET', '/orders');
    assert.equal(stale.status, 401);

    // Within the role.
    assert.equal((await api(token, 'GET', '/orders')).status, 200);
    const current = await api(token, 'GET', '/current');
    assert.equal(current.status, 200);
    assert.doesNotMatch(JSON.stringify(current.body), /123456789012|owner@upi|HDFC0000001/, 'no payout details for staff without wallet');

    // Outside it.
    for (const [method, path] of [['GET', '/finance'], ['GET', '/payout-details'], ['GET', '/employees'], ['POST', '/employee-roles'], ['GET', '/my-offers'], ['DELETE', '/me']]) {
        const res = await api(token, method, path, method === 'POST' ? { name: 'x', permissions: ['orders'] } : undefined);
        assert.equal(res.status, 403, `${method} ${path}: ${JSON.stringify(res.body)}`);
    }
    const chat = await http.get('/api/v1/food/chat/conversations', { token });
    assert.equal(chat.status, 403, 'chat needs its permission');

    const me = await http.get('/api/v1/food/auth/me', { token });
    assert.equal(me.status, 200);
    assert.equal(me.body.data.employee.id, employee.id);
    assert.deepEqual(me.body.data.employee.permissions, ['orders']);

    // A role edit applies at the next request; the refresh token carries it.
    const edited = await api(ownerToken, 'PATCH', `/employee-roles/${role.id}`, { permissions: ['orders', 'wallet', 'employees'] });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.equal((await api(token, 'GET', '/employees')).status, 200);
    const refreshed = await http.post('/api/v1/food/auth/refresh-token', { body: { refreshToken: byPhone.body.data.refreshToken } });
    assert.equal(refreshed.status, 200, JSON.stringify(refreshed.body));
    const claims = JSON.parse(Buffer.from(refreshed.body.data.accessToken.split('.')[1], 'base64url').toString());
    assert.equal(claims.employeeId, employee.id);
    assert.deepEqual(claims.permissions, ['orders', 'wallet', 'employees']);
    const withWallet = await api(refreshed.body.data.accessToken, 'GET', '/current');
    assert.match(JSON.stringify(withWallet.body), /123456789012/, 'finance staff see the bank details');

    // Deactivated: signed out at once, and cannot sign in.
    const off = await api(ownerToken, 'PATCH', `/employees/${employee.id}/status`, { isActive: false });
    assert.equal(off.status, 200, JSON.stringify(off.body));
    assert.equal((await api(token, 'GET', '/orders')).status, 401);
    assert.equal((await login({ email: employee.email, password: 'Kitchen#1' })).status, 401);
    assert.equal((await http.post('/api/v1/food/auth/refresh-token', { body: { refreshToken: byPhone.body.data.refreshToken } })).status, 401);

    // A role someone is on cannot be deleted.
    assert.equal((await api(ownerToken, 'DELETE', `/employee-roles/${role.id}`)).status, 400);
});

test("the owner's token is unaffected, even after staff sign in", async () => {
    const role = await makeRole(`${tag} Cashier`, ['orders']);
    const res = await makeEmployee(role.id);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal((await login({ email: res.body.data.employee.email, password: 'Kitchen#1' })).status, 200);

    assert.equal((await api(ownerToken, 'GET', '/employees')).status, 200);
    assert.equal((await api(ownerToken, 'GET', '/employee-roles/permissions')).status, 200);
    const current = await api(ownerToken, 'GET', '/current');
    assert.equal(current.status, 200);
    assert.match(JSON.stringify(current.body), /123456789012/, 'the owner sees their bank details');
});

test('staff who manage staff cannot give more than they hold', async () => {
    const managerRole = await makeRole(`${tag} Manager`, ['orders', 'employees']);
    const managerRes = await makeEmployee(managerRole.id);
    assert.equal(managerRes.status, 201, JSON.stringify(managerRes.body));
    const signedIn = await login({ email: managerRes.body.data.employee.email, password: 'Kitchen#1' });
    const manager = signedIn.body.data.accessToken;

    const wider = await api(manager, 'POST', '/employee-roles', { name: `${tag} Accounts`, permissions: ['wallet'] });
    assert.equal(wider.status, 403, JSON.stringify(wider.body));
    const fine = await api(manager, 'POST', '/employee-roles', { name: `${tag} Desk 2`, permissions: ['orders'] });
    assert.equal(fine.status, 201, JSON.stringify(fine.body));

    const financeRole = await makeRole(`${tag} Finance`, ['wallet']);
    const onFinance = await makeEmployee(financeRole.id, {}, manager);
    assert.equal(onFinance.status, 403, 'cannot put someone on a wider role');
    const self = await api(manager, 'PATCH', `/employees/${managerRes.body.data.employee.id}`, { roleId: financeRole.id });
    assert.equal(self.status, 403);

    // Another restaurant's staff and roles are invisible.
    const other = await prisma.foodRestaurant.create({
        data: { restaurantName: `${tag} Other`, ownerName: 'O', ownerPhone: uniquePhone('8'), status: 'approved', approvedAt: new Date() },
    });
    made.restaurants.push(other.id);
    const otherToken = tokenFor({ userId: other.id, role: 'RESTAURANT' });
    assert.equal((await api(otherToken, 'GET', `/employees/${managerRes.body.data.employee.id}`)).status, 404);
    assert.equal((await makeEmployee(managerRole.id, {}, otherToken)).status, 404);
});

test('an employee imported from the old system signs in with their old password', async () => {
    const role = await prisma.foodRestaurantRole.create({ data: { restaurantId: restaurant.id, name: `${tag} Legacy`, permissions: ['orders'] } });
    const laravelHash = bcrypt.hashSync('OldPass!9', 4).replace(/^\$2[ab]\$/, '$2y$');
    const email = `legacy.${tag.toLowerCase()}@staff.test`;
    await prisma.foodRestaurantEmployee.create({
        data: { restaurantId: restaurant.id, roleId: role.id, firstName: 'Old', email, password: laravelHash },
    });
    const res = await login({ email, password: 'OldPass!9' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal((await login({ email, password: 'OldPass!8' })).status, 401);
});
