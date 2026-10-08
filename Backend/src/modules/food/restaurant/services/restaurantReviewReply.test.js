import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../../config/prisma.js';
import { uniquePhone, uniqueTag } from '../../../../utils/testIds.js';
import { saveSystemSettings } from '../../admin/services/adminSystemExtras.service.js';
import { invalidateBusinessSettings } from '../../shared/businessSettings.js';
import { listFoodReviews } from '../../admin/services/adminFoodReviews.service.js';
import { getRestaurantReviews, listOwnRestaurantReviews, replyToRestaurantReview } from './restaurantReviews.service.js';

/**
 * A restaurant replying to a customer's review: only while Business Settings
 * allows it, only on its own reviewed orders, shown publicly with the review
 * and to the admin as the "Store reply".
 *
 * business_vendor is a global row; whatever was there is put back afterwards.
 */
const made = { restaurants: [], users: [], orders: [] };
let original;
let restaurantId;
let otherId;
let reviewed;
let unrated;

const setReplies = async (on) => {
    await saveSystemSettings('business_vendor', { value: { ...(original?.value || {}), canReplyToReviews: on } });
};

test.before(async () => {
    original = await prisma.foodSystemSetting.findUnique({ where: { key: 'business_vendor' } });
    const tag = uniqueTag('Reply');
    const restaurant = async (name) => {
        const r = await prisma.foodRestaurant.create({
            data: { restaurantName: `${tag} ${name}`, ownerName: 'O', ownerPhone: uniquePhone('9'), status: 'approved' },
        });
        made.restaurants.push(r.id);
        return r.id;
    };
    restaurantId = await restaurant('Kitchen');
    otherId = await restaurant('Other');
    const user = await prisma.foodUser.create({ data: { name: 'Neha Verma', phone: uniquePhone('5') } });
    made.users.push(user.id);

    const order = async (over) => {
        const row = await prisma.foodOrder.create({
            data: {
                userId: user.id, restaurantId, orderId: uniqueTag('RPL-'), customerName: 'Neha Verma',
                addrStreet: '1 Test Street', addrCity: 'Indore', addrState: 'MP',
                orderStatus: 'delivered', deliveryPhase: 'delivered', paymentMethod: 'cash', paymentStatus: 'paid',
                subtotal: 100, total: 100, ...over,
            },
        });
        made.orders.push(row.id);
        return row;
    };
    reviewed = await order({ restaurantRating: 4, restaurantRatingComment: 'Tasty but late', restaurantRatedAt: new Date() });
    unrated = await order({});
    await prisma.orderItemRating.create({ data: { orderId: reviewed.id, itemId: 'c'.repeat(24), name: `${tag} Dal`, rating: 4, comment: 'Good dal' } });
});

test.after(async () => {
    if (original) {
        await prisma.foodSystemSetting.update({ where: { key: 'business_vendor' }, data: { value: original.value } });
    } else {
        await prisma.foodSystemSetting.deleteMany({ where: { key: 'business_vendor' } });
    }
    invalidateBusinessSettings();
    await prisma.orderItemRating.deleteMany({ where: { orderId: { in: made.orders } } });
    await prisma.foodOrder.deleteMany({ where: { id: { in: made.orders } } });
    await prisma.foodUser.deleteMany({ where: { id: { in: made.users } } });
    await prisma.foodRestaurant.deleteMany({ where: { id: { in: made.restaurants } } });
    await prisma.$disconnect();
});

test('replies are refused while the admin has them switched off', async () => {
    await setReplies(false);
    assert.equal((await listOwnRestaurantReviews(restaurantId)).canReply, false);
    await assert.rejects(() => replyToRestaurantReview(restaurantId, reviewed.id, { reply: 'Sorry!' }), /switched off/);
});

test('a restaurant replies to, edits and removes its reply', async () => {
    await setReplies(true);
    const own = await listOwnRestaurantReviews(restaurantId);
    assert.equal(own.canReply, true);
    assert.equal(own.reviews[0].id, reviewed.id);
    assert.equal(own.reviews[0].reply, null);

    const saved = await replyToRestaurantReview(restaurantId, reviewed.id, { reply: '  Sorry about the wait!  ' });
    assert.equal(saved.reply.text, 'Sorry about the wait!');

    // Public, with the review.
    let pub = await getRestaurantReviews(restaurantId);
    assert.equal(pub.reviews[0].reply.text, 'Sorry about the wait!');
    assert.ok(pub.reviews[0].reply.repliedAt);

    // The admin sees it as the store reply on the dish review of that order.
    const admin = await listFoodReviews({ restaurantId });
    assert.equal(admin.reviews[0].storeReply, 'Sorry about the wait!');

    await replyToRestaurantReview(restaurantId, reviewed.id, { reply: 'Sorry, we were short-staffed.' });
    pub = await getRestaurantReviews(restaurantId);
    assert.equal(pub.reviews[0].reply.text, 'Sorry, we were short-staffed.');

    await replyToRestaurantReview(restaurantId, reviewed.id, { reply: '' });
    pub = await getRestaurantReviews(restaurantId);
    assert.equal(pub.reviews[0].reply, null);
    const row = await prisma.foodOrder.findUnique({ where: { id: reviewed.id } });
    assert.equal(row.restaurantRepliedAt, null);
});

test('only its own reviewed orders, and only a sensible reply', async () => {
    await setReplies(true);
    await assert.rejects(() => replyToRestaurantReview(otherId, reviewed.id, { reply: 'Not mine' }), /Review not found/);
    await assert.rejects(() => replyToRestaurantReview(restaurantId, unrated.id, { reply: 'No review yet' }), /Review not found/);
    await assert.rejects(() => replyToRestaurantReview(restaurantId, reviewed.id, { reply: 'x'.repeat(1001) }), /at most 1000/);
    await assert.rejects(() => replyToRestaurantReview(restaurantId, reviewed.id, {}), /Write a reply/);
});
