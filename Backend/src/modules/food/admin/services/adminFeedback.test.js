import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../../config/prisma.js';
import { uniquePhone, uniqueTag } from '../../../../utils/testIds.js';
import {
    getRestaurantComplaints,
    getRestaurantComplaintStats,
    updateRestaurantComplaint,
    getRestaurantReviews,
    getContactMessages,
    globalSearch,
} from './adminFeedback.service.js';

/**
 * Complaints, reviews, feedback and the global search box.
 *
 * The feedback author is the awkward one: userId is not a foreign key — it
 * points at a customer, a restaurant or a delivery partner depending on
 * userModel — so it cannot be a join.
 */
const live = Boolean(process.env.DATABASE_URL);

const created = {
    users: [], restaurants: [], partners: [], orders: [],
    tickets: [], feedback: [], categories: [], foods: [], addons: [],
};

const makeUser = async (name) => {
    const u = await prisma.foodUser.create({
        data: { name, phone: uniquePhone('5'), role: 'USER' },
    });
    created.users.push(u.id);
    return u;
};

const makeRestaurant = async (name) => {
    const r = await prisma.foodRestaurant.create({
        data: {
            restaurantName: name,
            ownerName: 'Owner',
            ownerPhone: uniquePhone('9'),
            status: 'approved',
        },
    });
    created.restaurants.push(r.id);
    return r;
};

const makeOrder = async (user, restaurant, over = {}) => {
    const o = await prisma.foodOrder.create({
        data: {
            userId: user.id,
            restaurantId: restaurant.id,
            orderStatus: 'delivered',
            paymentMethod: 'cash',
            addrStreet: '1 Test Street',
            addrCity: 'Indore',
            addrState: 'MP',
            subtotal: 100,
            total: 100,
            ...over,
        },
    });
    created.orders.push(o.id);
    return o;
};

test.after(async () => {
    if (!live) return;
    await prisma.foodSupportTicket.deleteMany({ where: { id: { in: created.tickets } } });
    await prisma.feedbackExperience.deleteMany({ where: { id: { in: created.feedback } } });
    await prisma.foodAddon.deleteMany({ where: { id: { in: created.addons } } });
    await prisma.foodItem.deleteMany({ where: { id: { in: created.foods } } });
    await prisma.foodOrder.deleteMany({ where: { id: { in: created.orders } } });
    await prisma.foodCategory.deleteMany({ where: { id: { in: created.categories } } });
    await prisma.foodUser.deleteMany({ where: { id: { in: created.users } } });
    await prisma.foodDeliveryPartner.deleteMany({ where: { id: { in: created.partners } } });
    await prisma.foodRestaurant.deleteMany({ where: { id: { in: created.restaurants } } });
    await prisma.$disconnect();
});

test('complaints search through their relations', { skip: !live }, async () => {
    const tag = uniqueTag('Cx');
    const user = await makeUser(`${tag} Customer`);
    const restaurant = await makeRestaurant(`${tag} Diner`);
    const order = await makeOrder(user, restaurant, { orderId: `${tag}-1` });

    const ticket = await prisma.foodSupportTicket.create({
        data: {
            userId: user.id,
            restaurantId: restaurant.id,
            orderId: order.id,
            type: 'order',
            issueType: 'Food was cold',
            description: 'Arrived stone cold',
        },
    });
    created.tickets.push(ticket.id);

    // Each of these lives on a different table; the filter reaches through the
    // relations rather than pre-resolving three id lists.
    for (const term of [`${tag} Customer`, `${tag} Diner`, `${tag}-1`, 'stone cold']) {
        const found = await getRestaurantComplaints({ search: term });
        assert.ok(found.complaints.some((c) => c.id === ticket.id), `search: ${term}`);
    }

    const row = (await getRestaurantComplaints({ search: `${tag}-1` })).complaints[0];
    assert.equal(row.user.name, `${tag} Customer`);
    assert.equal(row.restaurant.name ?? row.restaurant.restaurantName, `${tag} Diner`);
});

test('a complaint updates and reports the API status spelling', { skip: !live }, async () => {
    const user = await makeUser(uniqueTag('U'));
    const ticket = await prisma.foodSupportTicket.create({
        data: { userId: user.id, type: 'order', issueType: 'Late', description: 'x' },
    });
    created.tickets.push(ticket.id);

    const updated = await updateRestaurantComplaint(ticket.id, {
        status: 'in-progress',
        adminResponse: 'Looking into it',
    });
    // The enum's Prisma name is in_progress; the API says 'in-progress'.
    assert.equal(updated.status, 'in-progress');
    assert.equal(updated.adminResponse, 'Looking into it');

    const filtered = await getRestaurantComplaints({ status: 'in-progress' });
    assert.ok(filtered.complaints.some((c) => c.id === ticket.id));

    const stats = await getRestaurantComplaintStats({});
    assert.ok(stats.inProgress >= 1);
    assert.equal(stats.total, stats.open + stats.inProgress + stats.resolved);

    await assert.rejects(
        () => updateRestaurantComplaint('a'.repeat(24), { status: 'open' }),
        /Complaint not found/,
    );
    await assert.rejects(() => updateRestaurantComplaint('bad', {}), /Invalid complaint ID/);
});

test('reviews come from the rating columns, not a subdocument', { skip: !live }, async () => {
    const tag = uniqueTag('Rev');
    const user = await makeUser(`${tag} Rater`);
    const restaurant = await makeRestaurant(`${tag} Place`);

    const rated = await makeOrder(user, restaurant, {
        orderId: `${tag}-rated`,
        restaurantRating: 4,
        restaurantRatingComment: 'Good but slow',
    });
    // An order with no rating is not a review.
    await makeOrder(user, restaurant, { orderId: `${tag}-unrated` });

    const { reviews } = await getRestaurantReviews({ search: tag });
    assert.equal(reviews.length, 1);
    assert.equal(reviews[0].rating, 4);
    assert.equal(reviews[0].review, 'Good but slow');
    assert.equal(reviews[0].restaurant, `${tag} Place`);
    assert.equal(reviews[0].customer, `${tag} Rater`);
    assert.equal(reviews[0].orderId, `${tag}-rated`);
});

test('feedback resolves its author across three tables', { skip: !live }, async () => {
    const tag = uniqueTag('Fb');

    const user = await makeUser(`${tag} Eater`);
    const restaurant = await makeRestaurant(`${tag} Kitchen`);
    const partner = await prisma.foodDeliveryPartner.create({
        data: { name: `${tag} Rider`, phone: uniquePhone('6'), status: 'approved' },
    });
    created.partners.push(partner.id);

    for (const [id, userModel, module] of [
        [user.id, 'FoodUser', 'user'],
        [restaurant.id, 'FoodRestaurant', 'restaurant'],
        [partner.id, 'FoodDeliveryPartner', 'delivery'],
    ]) {
        const row = await prisma.feedbackExperience.create({
            data: { userId: id, userModel, module, rating: 5, comment: `${tag} feedback` },
        });
        created.feedback.push(row.id);
    }

    const { reviews, pagination } = await getContactMessages({ search: tag });
    assert.equal(pagination.total, 3);

    // userId is not a foreign key, so each author is looked up in whichever
    // table its userModel names.
    const names = reviews.map((r) => r.customer.name).sort();
    assert.deepEqual(names, [`${tag} Eater`, `${tag} Kitchen`, `${tag} Rider`].sort());
    assert.ok(reviews.every((r) => r.customer.phone !== 'N/A'));
});

test('feedback filters by rating', { skip: !live }, async () => {
    const tag = uniqueTag('Rate');
    const user = await makeUser(`${tag} Person`);

    for (const rating of [1, 5]) {
        const row = await prisma.feedbackExperience.create({
            data: {
                userId: user.id, userModel: 'FoodUser', module: 'user',
                rating, comment: `${tag} note`,
            },
        });
        created.feedback.push(row.id);
    }

    assert.equal((await getContactMessages({ search: tag })).pagination.total, 2);
    assert.equal((await getContactMessages({ search: tag, rating: '1' })).pagination.total, 1);
});

test('global search reaches every kind of record', { skip: !live }, async () => {
    const tag = uniqueTag('Gs');

    const user = await makeUser(`${tag} Person`);
    const restaurant = await makeRestaurant(`${tag} Cafe`);
    const order = await makeOrder(user, restaurant, { orderId: `${tag}-9` });

    const category = await prisma.foodCategory.create({ data: { name: `${tag} Snacks` } });
    created.categories.push(category.id);

    const food = await prisma.foodItem.create({
        data: { restaurantId: restaurant.id, name: `${tag} Samosa`, price: 40 },
    });
    created.foods.push(food.id);

    const addon = await prisma.foodAddon.create({
        data: { restaurantId: restaurant.id, draft: { name: `${tag} Chutney`, price: 15 } },
    });
    created.addons.push(addon.id);

    const results = await globalSearch(tag);
    const types = new Set(results.map((r) => r.type));

    assert.ok(types.has('Order'));
    assert.ok(types.has('User'));
    assert.ok(types.has('Restaurant'));
    assert.ok(types.has('Product'));
    assert.ok(types.has('Category'));
    // An add-on's name lives inside its draft Json, so this is a JSON path match.
    assert.ok(types.has('Addon'), 'add-ons are searchable through their draft');

    const addonHit = results.find((r) => r.type === 'Addon');
    assert.equal(addonHit.title, `${tag} Chutney`);
    assert.match(addonHit.description, /15/);

    assert.deepEqual(await globalSearch('   '), []);
});
