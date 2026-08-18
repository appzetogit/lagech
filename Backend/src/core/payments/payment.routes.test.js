import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../config/prisma.js';
import { startTestServer, tokenFor } from '../../utils/testHttp.js';
import { uniquePhone, uniqueTag } from '../../utils/testIds.js';
import { creditWallet } from './wallet.service.js';
import { getBalance } from './transaction.service.js';

/**
 * Who may reach what under /v1/food/payments.
 *
 * The router is mounted behind authMiddleware alone, and used to state no
 * roles of its own. So any signed-in customer could process a settlement —
 * debit a restaurant's wallet and mark it paid out — read the platform's
 * finance summary, and read any wallet by putting its id in the URL. These are
 * HTTP-level on purpose: a service test cannot see whether a guard is mounted.
 */
const BASE = '/api/v1/food/payments';

let http;
let stop;
const created = { users: [], restaurants: [], partners: [], orders: [], admins: [] };
let customer, stranger, restaurant, otherRestaurant, rider, admin, order;
let customerToken, strangerToken, restaurantToken, riderToken, adminToken;

test.before(async () => {
    ({ request: http, close: stop } = await startTestServer());
    const tag = uniqueTag('PayRt');

    [customer, stranger] = await Promise.all([
        prisma.foodUser.create({ data: { name: `${tag} Customer`, phone: uniquePhone('5') } }),
        prisma.foodUser.create({ data: { name: `${tag} Stranger`, phone: uniquePhone('5') } }),
    ]);
    created.users.push(customer.id, stranger.id);

    [restaurant, otherRestaurant] = await Promise.all(['A', 'B'].map((n) => prisma.foodRestaurant.create({
        data: { restaurantName: `${tag} ${n}`, ownerName: 'Owner', ownerPhone: uniquePhone('9'), status: 'approved' },
    })));
    created.restaurants.push(restaurant.id, otherRestaurant.id);

    rider = await prisma.foodDeliveryPartner.create({
        data: { name: `${tag} Rider`, phone: uniquePhone('6'), status: 'approved' },
    });
    created.partners.push(rider.id);

    admin = await prisma.foodAdmin.create({
        data: { email: `${tag.toLowerCase()}@test.local`, password: 'x', adminType: 'super_admin' },
    });
    created.admins.push(admin.id);

    order = await prisma.foodOrder.create({
        data: {
            userId: customer.id, restaurantId: restaurant.id,
            orderId: `${tag}-O1`, order_id: `${tag}-O1`,
            orderStatus: 'delivered', paymentMethod: 'razorpay', paymentStatus: 'paid',
            addrStreet: '1 Test Street', addrCity: 'Indore', addrState: 'MP',
            subtotal: 500, total: 500,
        },
    });
    created.orders.push(order.id);

    // Something in the restaurant's wallet, so a settlement could actually be paid.
    await creditWallet({
        entityType: 'restaurant', entityId: restaurant.id, amount: 1000,
        description: 'Earnings', category: 'order_payment',
    });

    customerToken = tokenFor({ userId: customer.id, role: 'USER' });
    strangerToken = tokenFor({ userId: stranger.id, role: 'USER' });
    restaurantToken = tokenFor({ userId: restaurant.id, role: 'RESTAURANT' });
    riderToken = tokenFor({ userId: rider.id, role: 'DELIVERY_PARTNER' });
    adminToken = tokenFor({ userId: admin.id, role: 'ADMIN', adminType: 'super_admin' });
});

test.after(async () => {
    const entityIds = [...created.restaurants, ...created.partners, ...created.users];
    await prisma.transaction.deleteMany({ where: { entityId: { in: entityIds } } });
    await prisma.settlement.deleteMany({ where: { entityId: { in: entityIds } } });
    await prisma.wallet.deleteMany({ where: { entityId: { in: entityIds } } });
    await prisma.foodOrder.deleteMany({ where: { id: { in: created.orders } } });
    await prisma.foodDeliveryPartner.deleteMany({ where: { id: { in: created.partners } } });
    await prisma.foodRestaurant.deleteMany({ where: { id: { in: created.restaurants } } });
    await prisma.foodUser.deleteMany({ where: { id: { in: created.users } } });
    await prisma.foodAdmin.deleteMany({ where: { id: { in: created.admins } } });
    await prisma.$disconnect();
    await stop();
});

// ── admin surface ──

test('a customer cannot create or process a settlement', async () => {
    const create = await http('POST', `${BASE}/admin/settlements`, {
        token: customerToken,
        body: { entityType: 'restaurant', entityId: restaurant.id, amount: 800 },
    });
    assert.equal(create.status, 403);

    // Nothing was written, so nothing can be processed — but drive the point
    // home with a real pending settlement the admin made.
    const made = await http('POST', `${BASE}/admin/settlements`, {
        token: adminToken,
        body: { entityType: 'restaurant', entityId: restaurant.id, amount: 800 },
    });
    assert.equal(made.status, 201);
    const settlementId = made.body.data.settlement.id;

    const process = await http('POST', `${BASE}/admin/settlements/${settlementId}/process`, {
        token: customerToken, body: { payoutRef: 'stolen' },
    });
    assert.equal(process.status, 403);

    // The money is still there. This is the assertion that matters.
    const { balance } = await getBalance('restaurant', restaurant.id);
    assert.equal(balance, 1000, 'a customer could not move a restaurant\'s money');
});

test('an admin can, and the guard does not get in the way of them', async () => {
    const list = await http('GET', `${BASE}/admin/settlements?entityId=${restaurant.id}`, { token: adminToken });
    assert.equal(list.status, 200);
    const pending = list.body.data.settlements.find((s) => s.status === 'pending');
    assert.ok(pending, 'the settlement from the previous test is listed');

    const done = await http('POST', `${BASE}/admin/settlements/${pending.id}/process`, {
        token: adminToken, body: { payoutRef: 'NEFT-1' },
    });
    assert.equal(done.status, 200);
    assert.equal(done.body.data.settlement.status, 'processed');
    assert.equal((await getBalance('restaurant', restaurant.id)).balance, 200);
});

test('the finance summary, refunds and platform wallet are admin-only', async () => {
    for (const path of ['/admin/finance/summary', '/admin/refunds', '/admin/wallet', '/admin/settlements']) {
        for (const [who, token] of [['customer', customerToken], ['restaurant', restaurantToken], ['rider', riderToken]]) {
            const res = await http('GET', `${BASE}${path}`, { token });
            assert.equal(res.status, 403, `${who} reached ${path}`);
        }
        const ok = await http('GET', `${BASE}${path}`, { token: adminToken });
        assert.equal(ok.status, 200, `admin refused ${path}`);
    }
});

test('the finance summary adds pending amounts up rather than concatenating them', async () => {
    const res = await http('GET', `${BASE}/admin/finance/summary`, { token: adminToken });
    assert.equal(res.status, 200);
    // Decimal amounts summed with a reduce used to come out as "0300500".
    assert.equal(typeof res.body.data.pendingSettlements.totalAmount, 'number');
    assert.equal(typeof res.body.data.pendingRefunds.totalAmount, 'number');
});

// ── wallets ──

test('a restaurant reads its own wallet and nobody else\'s', async () => {
    const own = await http('GET', `${BASE}/restaurant/${restaurant.id}/wallet`, { token: restaurantToken });
    assert.equal(own.status, 200);
    assert.equal(Number(own.body.data.wallet?.balance ?? own.body.data.balance), 200);

    // The URL says another restaurant. req.user carries no restaurantId, so
    // the old code fell through to the URL for everyone.
    const other = await http('GET', `${BASE}/restaurant/${otherRestaurant.id}/wallet`, { token: restaurantToken });
    assert.equal(other.status, 403);

    // A customer, whatever id they put in the URL.
    const customer = await http('GET', `${BASE}/restaurant/${restaurant.id}/wallet`, { token: customerToken });
    assert.equal(customer.status, 403);

    // An admin reads any.
    const asAdmin = await http('GET', `${BASE}/restaurant/${restaurant.id}/wallet`, { token: adminToken });
    assert.equal(asAdmin.status, 200);
});

test('a rider reads its own wallet and nobody else\'s', async () => {
    const own = await http('GET', `${BASE}/delivery/${rider.id}/wallet`, { token: riderToken });
    assert.equal(own.status, 200);

    const asRestaurant = await http('GET', `${BASE}/delivery/${rider.id}/wallet`, { token: restaurantToken });
    assert.equal(asRestaurant.status, 403);
    const asCustomer = await http('GET', `${BASE}/delivery/${rider.id}/wallet`, { token: customerToken });
    assert.equal(asCustomer.status, 403);
});

test('a customer\'s wallet endpoints are for customers', async () => {
    const own = await http('GET', `${BASE}/wallet/balance`, { token: customerToken });
    assert.equal(own.status, 200);
    assert.equal(typeof own.body.data.balance, 'number');

    const asRestaurant = await http('GET', `${BASE}/wallet/balance`, { token: restaurantToken });
    assert.equal(asRestaurant.status, 403);
});

// ── an order's payment trail ──

test('a customer reads the payment trail of their own order, not another\'s', async () => {
    for (const path of ['payments', 'transactions', 'refunds']) {
        const own = await http('GET', `${BASE}/orders/${order.id}/${path}`, { token: customerToken });
        assert.equal(own.status, 200, `owner refused ${path}`);

        // Same 404 as for an order that does not exist: no signal that the id
        // was real.
        const stranger = await http('GET', `${BASE}/orders/${order.id}/${path}`, { token: strangerToken });
        assert.equal(stranger.status, 404, `stranger reached ${path}`);

        const missing = await http('GET', `${BASE}/orders/${'a'.repeat(24)}/${path}`, { token: customerToken });
        assert.equal(missing.status, 404);

        const asAdmin = await http('GET', `${BASE}/orders/${order.id}/${path}`, { token: adminToken });
        assert.equal(asAdmin.status, 200, `admin refused ${path}`);
    }
});

test('nothing here is reachable without a token', async () => {
    for (const path of ['/wallet/balance', '/admin/settlements', `/restaurant/${restaurant.id}/wallet`]) {
        const res = await http('GET', `${BASE}${path}`);
        assert.equal(res.status, 401, path);
    }
});
