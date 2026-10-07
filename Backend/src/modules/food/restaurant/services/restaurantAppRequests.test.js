import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../../config/prisma.js';
import { startTestServer, tokenFor } from '../../../../utils/testHttp.js';
import { uniquePhone, uniqueTag } from '../../../../utils/testIds.js';
import { updateRestaurantProfile, RESTAURANT_HAS_HISTORY_MESSAGE } from './restaurant.service.js';
import { createRestaurantSupportTicket } from './restaurantSupportTicket.service.js';
import { getSupportTickets, updateSupportTicket } from '../../admin/services/adminSupportTicket.service.js';
import { deleteRestaurant } from '../../admin/services/adminRestaurantLifecycle.service.js';

/**
 * What the restaurant partner app relies on, end to end over HTTP:
 *  - a logo change is saved and sends the restaurant back to pending for review;
 *  - DELETE /v1/food/restaurant/me deletes the account, 400 with history, and
 *    keeps its support tickets and feedback for the admin;
 *  - the admin's reply to a ticket reaches the restaurant as adminResponse +
 *    respondedAt, and the admin's default list shows restaurant tickets.
 */
const BASE = '/api/v1/food/restaurant';
const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
);

let http = null;
const created = { restaurants: [], users: [], orders: [], tickets: [], customerTickets: [], feedback: [] };

const makeRestaurant = async (overrides = {}) => {
    const r = await prisma.foodRestaurant.create({
        data: {
            restaurantName: `${uniqueTag('App')} Kitchen`,
            ownerName: 'Owner',
            ownerPhone: uniquePhone('9'),
            status: 'approved',
            approvedAt: new Date('2026-01-01T00:00:00Z'),
            isAcceptingOrders: true,
            ...overrides,
        },
    });
    created.restaurants.push(r.id);
    return r;
};

const tokenOf = (restaurant) => tokenFor({ userId: restaurant.id, role: 'RESTAURANT' });

const uploadLogo = async (token) => {
    const form = new FormData();
    form.append('file', new Blob([PNG], { type: 'image/png' }), 'logo.png');
    const res = await fetch(`${http.base}${BASE}/profile/profile-image`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
    });
    return { status: res.status, body: await res.json() };
};

test.before(async () => {
    http = await startTestServer();
});

test.after(async () => {
    await prisma.feedbackExperience.deleteMany({ where: { id: { in: created.feedback } } });
    await prisma.foodSupportTicket.deleteMany({ where: { id: { in: created.customerTickets } } });
    await prisma.foodRestaurantSupportTicket.deleteMany({
        where: { OR: [{ id: { in: created.tickets } }, { restaurantId: { in: created.restaurants } }] },
    });
    await prisma.foodOrder.deleteMany({ where: { id: { in: created.orders } } });
    await prisma.foodRestaurant.deleteMany({ where: { id: { in: created.restaurants } } });
    await prisma.foodUser.deleteMany({ where: { id: { in: created.users } } });
    if (http) await http.close();
    await prisma.$disconnect();
});

// ─── 1. Logo ────────────────────────────────────────────────────────────────

test('an approved restaurant changes its logo: saved, and the restaurant goes back to pending for review', async () => {
    const r = await makeRestaurant();
    const token = tokenOf(r);

    const up = await uploadLogo(token);
    assert.equal(up.status, 200, JSON.stringify(up.body));
    assert.ok(up.body.data.profileImage.url);

    const row = await prisma.foodRestaurant.findUnique({ where: { id: r.id } });
    assert.equal(row.status, 'pending', 'a new logo goes back to admin review');
    assert.equal(row.approvedAt, null);
    assert.ok(row.profileImage, 'the new logo is saved on the restaurant');

    const current = await http.get(`${BASE}/current`, { token });
    assert.equal(current.status, 200);
    assert.equal(current.body.data.restaurant.status, 'pending');
    const fileName = row.profileImage.split('/').pop();
    assert.ok(
        String(current.body.data.restaurant.profileImage?.url || '').includes(fileName),
        'GET /current returns the new logo straight away',
    );
});

test('setting the logo through PATCH /profile also sends the restaurant back to review', async () => {
    const r = await makeRestaurant();
    const updated = await updateRestaurantProfile(r.id, { profileImage: 'https://cdn.example.com/new-logo.png' });
    assert.equal(updated.status, 'pending');
    const row = await prisma.foodRestaurant.findUnique({ where: { id: r.id } });
    assert.ok(String(row.profileImage).includes('new-logo.png'));
});

// ─── 2 & 3. Delete account ────────────────────────────────────────────────────

test('DELETE /v1/food/restaurant/me is the route; the app\'s other guesses are 404', async () => {
    const r = await makeRestaurant();
    const token = tokenOf(r);

    // The app moves on to the next path only on a 404.
    assert.equal((await http.request('DELETE', '/api/v1/food/auth/restaurant/account', { token })).status, 404);
    assert.equal((await http.request('DELETE', '/api/v1/food/auth/account', { token })).status, 404);

    // A customer token is not a restaurant.
    const userToken = tokenFor({ userId: r.id, role: 'USER' });
    assert.ok([401, 403].includes((await http.request('DELETE', `${BASE}/me`, { token: userToken })).status));
    assert.ok(await prisma.foodRestaurant.findUnique({ where: { id: r.id } }));
});

test('a restaurant with order history gets a 400 and is kept', async () => {
    const r = await makeRestaurant();
    const user = await prisma.foodUser.create({ data: { phone: uniquePhone('5') } });
    created.users.push(user.id);
    const order = await prisma.foodOrder.create({
        data: {
            userId: user.id,
            restaurantId: r.id,
            orderId: uniqueTag('DEL'),
            orderStatus: 'delivered',
            paymentMethod: 'cash',
            addrStreet: '1 St', addrCity: 'Indore', addrState: 'MP',
            subtotal: 100, packagingFee: 0, restaurantCommission: 10, total: 100,
        },
    });
    created.orders.push(order.id);

    const res = await http.request('DELETE', `${BASE}/me`, { token: tokenOf(r) });
    assert.equal(res.status, 400);
    assert.equal(res.body.message, 'Restaurants with order history cannot be deleted. Please contact support.');
    assert.equal(res.body.message, RESTAURANT_HAS_HISTORY_MESSAGE);
    assert.ok(await prisma.foodRestaurant.findUnique({ where: { id: r.id } }));
});

test('a deleted restaurant\'s support tickets and feedback are kept, detached, under its name', async () => {
    const r = await makeRestaurant();
    const user = await prisma.foodUser.create({ data: { phone: uniquePhone('5') } });
    created.users.push(user.id);

    const ticket = await createRestaurantSupportTicket(r.id, { category: 'payments', issueType: 'Payout', subject: 'Where is my money' });
    created.tickets.push(ticket.id);
    assert.equal(ticket.restaurantName, r.restaurantName);
    // A ticket from before restaurantName existed gets the name at deletion.
    const legacy = await prisma.foodRestaurantSupportTicket.create({
        data: { restaurantId: r.id, category: 'other', issueType: 'Old' },
    });
    created.tickets.push(legacy.id);
    const customerTicket = await prisma.foodSupportTicket.create({
        data: { userId: user.id, type: 'restaurant', restaurantId: r.id, issueType: 'Rude staff' },
    });
    created.customerTickets.push(customerTicket.id);
    const feedback = await prisma.feedbackExperience.create({
        data: { userId: user.id, restaurantId: r.id, rating: 4, module: 'user' },
    });
    created.feedback.push(feedback.id);

    const res = await http.request('DELETE', `${BASE}/me`, { token: tokenOf(r) });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.success, true);
    assert.equal(await prisma.foodRestaurant.findUnique({ where: { id: r.id } }), null);

    for (const id of [ticket.id, legacy.id]) {
        const kept = await prisma.foodRestaurantSupportTicket.findUnique({ where: { id } });
        assert.ok(kept, 'the restaurant ticket is kept');
        assert.equal(kept.restaurantId, null);
        assert.equal(kept.restaurantName, r.restaurantName);
    }
    assert.equal((await prisma.foodSupportTicket.findUnique({ where: { id: customerTicket.id } })).restaurantId, null);
    assert.equal((await prisma.feedbackExperience.findUnique({ where: { id: feedback.id } })).restaurantId, null);

    // The admin still sees it, named.
    const { tickets } = await getSupportTickets({ source: 'restaurant', search: r.restaurantName, limit: 50 });
    const row = tickets.find((t) => t.id === ticket.id);
    assert.ok(row, 'searchable by the deleted restaurant\'s name');
    assert.equal(row.restaurantName, r.restaurantName);
    assert.equal(row.restaurantDeleted, true);
});

test('an admin delete keeps tickets and feedback the same way', async () => {
    const r = await makeRestaurant();
    const ticket = await createRestaurantSupportTicket(r.id, { category: 'menu', issueType: 'Menu' });
    created.tickets.push(ticket.id);

    await deleteRestaurant(r.id);

    const kept = await prisma.foodRestaurantSupportTicket.findUnique({ where: { id: ticket.id } });
    assert.ok(kept);
    assert.equal(kept.restaurantId, null);
    assert.equal(kept.restaurantName, r.restaurantName);
});

// ─── 4. Support tickets ─────────────────────────────────────────────────────

test('the admin\'s reply reaches the restaurant as adminResponse + respondedAt', async () => {
    const r = await makeRestaurant();
    const token = tokenOf(r);

    const create = await http.post(`${BASE}/support/tickets`, {
        token,
        body: { category: 'technical', issueType: 'App crash', subject: 'Crash on login', priority: 'high' },
    });
    assert.equal(create.status, 201, JSON.stringify(create.body));
    const ticketId = create.body.data.ticket.id;
    created.tickets.push(ticketId);
    assert.equal(create.body.data.ticket.adminResponse, '');
    assert.equal(create.body.data.ticket.respondedAt, null);

    // The admin's plain Support Tickets view (no filters) lists it.
    const inbox = await getSupportTickets({ limit: 1000 });
    const listed = inbox.tickets.find((t) => t.id === ticketId);
    assert.ok(listed, 'restaurant tickets are in the default admin list');
    assert.equal(listed.source, 'restaurant');
    // The Order Issue Reports preset is customer order tickets only.
    const issues = await getSupportTickets({ source: 'user', type: 'order', limit: 1000 });
    assert.ok(!issues.tickets.some((t) => t.id === ticketId));

    await updateSupportTicket(ticketId, { source: 'restaurant', status: 'resolved', adminResponse: 'Fixed in 2.1' });

    const mine = await http.get(`${BASE}/support/tickets`, { token });
    assert.equal(mine.status, 200);
    const row = mine.body.data.tickets.find((t) => t.id === ticketId);
    assert.equal(row.adminResponse, 'Fixed in 2.1');
    assert.ok(row.respondedAt && !Number.isNaN(Date.parse(row.respondedAt)));
    assert.equal(row.status, 'resolved');
});
