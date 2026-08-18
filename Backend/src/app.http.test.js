import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from './config/prisma.js';
import { startTestServer, tokenFor } from './utils/testHttp.js';
import { uniquePhone, uniqueTag } from './utils/testIds.js';

/**
 * The layers in front of the services: routing, auth, and error mapping.
 *
 * Every other test in this suite calls a service directly, so none of them can
 * tell whether a route is mounted where the client asks for it, whether auth
 * runs, or whether a thrown error becomes the right status code. Two real bugs
 * lived in exactly that blind spot — a controller importing a module path that
 * does not exist, and a startup check demanding MONGO_URI long after the last
 * Mongoose model was deleted. Both were found by running the app by hand.
 */
const live = Boolean(process.env.DATABASE_URL);

const ADMIN_BASE = '/api/v1/food/admin';

let http = null;
let adminToken = null;
let userToken = null;
let restaurantId = null;
let tag = null;
const created = { admins: [], restaurants: [], users: [], orders: [] };

test.before(async () => {
    if (!live) return;
    http = await startTestServer();
    tag = uniqueTag('Http');

    const admin = await prisma.foodAdmin.create({
        data: {
            name: `${tag} Admin`,
            email: `${tag}@admin.test`,
            password: 'x',
            adminType: 'super_admin',
        },
    });
    created.admins.push(admin.id);
    adminToken = tokenFor({ userId: admin.id, role: 'ADMIN', adminType: 'super_admin' });

    const user = await prisma.foodUser.create({ data: { phone: uniquePhone('5') } });
    created.users.push(user.id);
    userToken = tokenFor({ userId: user.id, role: 'USER' });

    const restaurant = await prisma.foodRestaurant.create({
        data: {
            restaurantName: `${tag} Kitchen`,
            ownerName: 'Owner',
            ownerPhone: uniquePhone('9'),
            status: 'approved',
        },
    });
    created.restaurants.push(restaurant.id);
    restaurantId = restaurant.id;

    for (let i = 0; i < 3; i += 1) {
        const order = await prisma.foodOrder.create({
            data: {
                userId: user.id,
                restaurantId,
                orderId: `${tag}-${i}`,
                orderStatus: 'delivered',
                paymentMethod: 'cash',
                addrStreet: '1 St', addrCity: 'Indore', addrState: 'MP',
                subtotal: 1000, packagingFee: 0, restaurantCommission: 100, total: 1000,
            },
        });
        created.orders.push(order.id);
    }
});

test.after(async () => {
    if (!live) return;
    await prisma.foodOrder.deleteMany({ where: { id: { in: created.orders } } });
    await prisma.foodUser.deleteMany({ where: { id: { in: created.users } } });
    await prisma.foodRestaurant.deleteMany({ where: { id: { in: created.restaurants } } });
    await prisma.foodAdmin.deleteMany({ where: { id: { in: created.admins } } });
    if (http) await http.close();
    await prisma.$disconnect();
});

test('the app serves and reports its dependencies', { skip: !live }, async () => {
    const { status, body } = await http.get('/health');
    assert.equal(status, 200);
    assert.equal(body.status, 'UP');
    // A green health check that does not actually check the database is worse
    // than none, because it is what a load balancer trusts.
    assert.equal(body.postgres, 'connected');
});

test('an unrouted path is a 404, not a hang or a 500', { skip: !live }, async () => {
    assert.equal((await http.get(`${ADMIN_BASE}/no-such-endpoint`, { token: adminToken })).status, 404);
    assert.equal((await http.get('/not-an-api-path')).status, 404);
});

test('a protected route refuses an absent, malformed or wrong-role token', { skip: !live }, async () => {
    const path = `${ADMIN_BASE}/dashboard-stats`;

    const anonymous = await http.get(path);
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.body.success, false);

    assert.equal((await http.get(path, { token: 'not-a-jwt' })).status, 401);

    // Signed by us, but for a customer. The role gate is the thing under test:
    // a valid token is not an admin token.
    const asCustomer = await http.get(path, { token: userToken });
    assert.equal(asCustomer.status, 403);

    assert.equal((await http.get(path, { token: adminToken })).status, 200);
});

test('a successful response has the envelope the clients parse', { skip: !live }, async () => {
    const { status, body } = await http.get(`${ADMIN_BASE}/dashboard-stats`, { token: adminToken });

    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.equal(typeof body.message, 'string');
    assert.ok(body.data, 'the payload is nested under `data`');
    assert.ok(Number.isFinite(body.data.orders.total));
    // Decimals must not reach the client as strings.
    assert.equal(typeof body.data.revenue.total, 'number');
});

test('every report route ported in this migration is reachable', { skip: !live }, async () => {
    // The regression net: a route renamed, unmounted, or pointed at a function
    // that no longer exists fails here and nowhere else.
    const paths = [
        '/dashboard-stats',
        '/sidebar-badges',
        '/reports/transactions',
        '/reports/restaurants',
        '/reports/tax',
        '/delivery/earnings',
        '/restaurant-subscriptions/invoices',
        '/restaurant-subscriptions/summary',
        '/restaurant-subscriptions/invoices/export',
        '/restaurant-subscriptions/history',
        '/feedback-experiences',
        '/foods/pending-approvals',
        '/notifications/broadcast',
        '/restaurant-app-banners',
        '/delivery/support-tickets',
        '/delivery/bonus-transactions',
        '/delivery/earning-addon-history',
    ];

    const failures = [];
    for (const path of paths) {
        const { status } = await http.get(ADMIN_BASE + path, { token: adminToken });
        if (status !== 200) failures.push(`${path} -> ${status}`);
    }
    assert.deepEqual(failures, [], `unreachable: ${failures.join(', ')}`);
});

test('query parameters reach the service', { skip: !live }, async () => {
    // Pagination is plumbed through the controller, so a controller that reads
    // the wrong key silently returns a default-sized page.
    const one = await http.get(`${ADMIN_BASE}/reports/transactions?limit=1`, { token: adminToken });
    assert.equal(one.status, 200);
    assert.equal(one.body.data.pagination.limit, 1);

    const searched = await http.get(
        `${ADMIN_BASE}/reports/restaurants?search=${encodeURIComponent(tag)}`,
        { token: adminToken },
    );
    assert.equal(searched.body.data.total, 1, 'the search term reached the query');
    assert.equal(searched.body.data.restaurants[0].restaurantName, `${tag} Kitchen`);
});

test('a thrown error becomes its own status, not a 500', { skip: !live }, async () => {
    // NotFoundError -> 404, through the error handler.
    const missing = await http.post(
        `${ADMIN_BASE}/restaurant-subscriptions/invoices/${'a'.repeat(24)}/waive`,
        { token: adminToken, body: { remarks: 'test' } },
    );
    assert.equal(missing.status, 404);
    assert.equal(missing.body.success, false);
    assert.match(missing.body.message, /not found/i);

    // ValidationError -> 400, with the message the admin needs to act on.
    const badId = await http.post(
        `${ADMIN_BASE}/restaurant-subscriptions/invoices/not-an-id/waive`,
        { token: adminToken, body: { remarks: 'test' } },
    );
    assert.equal(badId.status, 400);
    assert.match(badId.body.message, /Invalid invoice id/);
});

test('a controller guard answers before the service is asked', { skip: !live }, async () => {
    const bad = await http.get(`${ADMIN_BASE}/restaurants/not-an-id/analytics`, { token: adminToken });
    assert.equal(bad.status, 400);

    const absent = await http.get(`${ADMIN_BASE}/restaurants/${'a'.repeat(24)}/analytics`, { token: adminToken });
    assert.equal(absent.status, 404);

    const real = await http.get(`${ADMIN_BASE}/restaurants/${restaurantId}/analytics`, { token: adminToken });
    assert.equal(real.status, 200);
    assert.equal(real.body.data.analytics.totalOrders, 3);
});

test('the public endpoints stay public', { skip: !live }, async () => {
    // These are read by the apps before anyone signs in; putting them behind the
    // admin guard would break the launch screen.
    for (const path of [
        '/business-settings/public',
        '/power-scanning/public',
        '/fee-settings/public',
        '/feature-settings/public',
        '/restaurant-subscription-settings/public',
    ]) {
        const { status } = await http.get(ADMIN_BASE + path);
        assert.equal(status, 200, `${path} should not require a token`);
    }
});
