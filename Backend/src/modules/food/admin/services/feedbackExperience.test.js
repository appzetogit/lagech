import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../../config/prisma.js';
import { uniquePhone, uniqueTag } from '../../../../utils/testIds.js';
import {
    createFeedbackExperience,
    getFeedbackExperiences,
    deleteFeedbackExperience,
} from './feedbackExperience.service.js';

/**
 * The "how was your experience" survey.
 *
 * `userId` is polymorphic, so the author lookup is the part worth pinning: a
 * restaurant's name lives in a different column from a customer's.
 */
const created = { feedback: [], users: [], restaurants: [], partners: [] };

test.after(async () => {
    await prisma.feedbackExperience.deleteMany({ where: { id: { in: created.feedback } } });
    await prisma.foodRestaurant.deleteMany({ where: { id: { in: created.restaurants } } });
    await prisma.foodDeliveryPartner.deleteMany({ where: { id: { in: created.partners } } });
    await prisma.foodUser.deleteMany({ where: { id: { in: created.users } } });
    await prisma.$disconnect();
});

test('the author is resolved from whichever table it lives in', async () => {
    const tag = uniqueTag('Fx');

    const user = await prisma.foodUser.create({
        data: { name: `${tag} Customer`, phone: uniquePhone('5'), email: `${tag}@user.test` },
    });
    const restaurant = await prisma.foodRestaurant.create({
        data: {
            restaurantName: `${tag} Kitchen`,
            ownerName: 'Owner',
            ownerPhone: uniquePhone('9'),
            ownerEmail: `${tag}@rest.test`,
        },
    });
    const partner = await prisma.foodDeliveryPartner.create({
        data: { name: `${tag} Rider`, phone: uniquePhone('6') },
    });
    created.users.push(user.id);
    created.restaurants.push(restaurant.id);
    created.partners.push(partner.id);

    for (const [author, role, module] of [
        [user, 'USER', 'user'],
        [restaurant, 'RESTAURANT', 'restaurant'],
        [partner, 'DELIVERY_PARTNER', 'delivery'],
    ]) {
        const fb = await createFeedbackExperience(
            { userId: author.id, role },
            { rating: 4, module, comment: `${tag} fine` },
        );
        created.feedback.push(fb.id);
    }

    const { feedbacks } = await getFeedbackExperiences({ module: 'restaurant', limit: 100 });
    const mine = feedbacks.find((f) => f.comment === `${tag} fine`);
    // A restaurant's name is restaurantName, not name — the old populate
    // reached across three schemas for exactly this.
    assert.equal(mine.userName, `${tag} Kitchen`);
    assert.equal(mine.userEmail, `${tag}@rest.test`);
    assert.equal(mine.restaurantId, restaurant.id, 'a restaurant is attributed to itself');
    assert.equal(mine.restaurant.restaurantName, `${tag} Kitchen`);

    const asCustomer = (await getFeedbackExperiences({ module: 'user', limit: 100 }))
        .feedbacks.find((f) => f.comment === `${tag} fine`);
    assert.equal(asCustomer.userName, `${tag} Customer`);
    assert.equal(asCustomer.restaurantId, null, 'a customer is not attributed to a restaurant');

    const asRider = (await getFeedbackExperiences({ module: 'delivery', limit: 100 }))
        .feedbacks.find((f) => f.comment === `${tag} fine`);
    assert.equal(asRider.userName, `${tag} Rider`);
});

test('a rating outside the scale is refused', async () => {
    const user = await prisma.foodUser.create({ data: { phone: uniquePhone('5') } });
    created.users.push(user.id);
    const who = { userId: user.id, role: 'USER' };

    await assert.rejects(
        () => createFeedbackExperience(who, { module: 'user' }),
        /Rating and module are required/,
    );
    await assert.rejects(
        () => createFeedbackExperience(who, { rating: 4 }),
        /Rating and module are required/,
    );
    await assert.rejects(
        () => createFeedbackExperience(who, { rating: 4, module: 'courier' }),
        /Invalid module/,
    );
    // The survey stores 1–5; the panel doubles it for display. Accepting an 8
    // here would make every average wrong.
    await assert.rejects(
        () => createFeedbackExperience(who, { rating: 8, module: 'user' }),
        /whole number from 1 to 5/,
    );
    await assert.rejects(
        () => createFeedbackExperience(who, { rating: 3.5, module: 'user' }),
        /whole number from 1 to 5/,
    );
});

test('statistics are reported out of ten', async () => {
    const user = await prisma.foodUser.create({ data: { phone: uniquePhone('5') } });
    created.users.push(user.id);

    // A window no other row can fall into, so the aggregate is only ours.
    const day = new Date('2031-03-05T10:00:00Z');
    for (const rating of [1, 3, 5]) {
        const fb = await prisma.feedbackExperience.create({
            data: { userId: user.id, userModel: 'FoodUser', module: 'user', rating, createdAt: day },
        });
        created.feedback.push(fb.id);
    }

    const { statistics, pagination } = await getFeedbackExperiences({
        startDate: '2031-03-05',
        endDate: '2031-03-05',
    });

    assert.equal(pagination.total, 3, 'endDate covers the whole day');
    assert.equal(statistics.totalFeedback, 3);
    assert.equal(statistics.averageRating, 6, '(1+3+5)/3 = 3, doubled');
    assert.equal(statistics.minRating, 2);
    assert.equal(statistics.maxRating, 10);
});

test('the filters halve the displayed rating back to the stored one', async () => {
    const user = await prisma.foodUser.create({ data: { phone: uniquePhone('5') } });
    created.users.push(user.id);

    const day = new Date('2031-04-09T10:00:00Z');
    const window = { startDate: '2031-04-09', endDate: '2031-04-09' };
    for (const rating of [2, 5]) {
        const fb = await prisma.feedbackExperience.create({
            data: { userId: user.id, userModel: 'FoodUser', module: 'user', rating, createdAt: day },
        });
        created.feedback.push(fb.id);
    }

    // The panel sends 10; the row is stored as 5.
    const byRating = await getFeedbackExperiences({ ...window, rating: '10' });
    assert.equal(byRating.pagination.total, 1);
    assert.equal(byRating.feedbacks[0].rating, 5);

    const byLabel = await getFeedbackExperiences({ ...window, experience: 'below_average' });
    assert.equal(byLabel.pagination.total, 1);
    assert.equal(byLabel.feedbacks[0].rating, 2);

    // An unrecognised label is ignored rather than matching nothing.
    const unknown = await getFeedbackExperiences({ ...window, experience: 'meh' });
    assert.equal(unknown.pagination.total, 2);
});

test('deleting reports whether anything went', async () => {
    const user = await prisma.foodUser.create({ data: { phone: uniquePhone('5') } });
    created.users.push(user.id);
    const fb = await createFeedbackExperience(
        { userId: user.id, role: 'USER' },
        { rating: 2, module: 'user' },
    );

    assert.equal(await deleteFeedbackExperience(fb.id), true);
    assert.equal(await deleteFeedbackExperience(fb.id), false, 'already gone');
    assert.equal(await deleteFeedbackExperience('not-an-id'), false);
});
