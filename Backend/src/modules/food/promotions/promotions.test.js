import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../config/prisma.js';
import { uniquePhone } from '../../../utils/testIds.js';
import {
    adState,
    reelState,
    createAdAdmin,
    decideAd,
    listRunningAds,
    requestAd,
    withdrawAdRequest,
    createReel,
    countReelEvent,
    listShowingReels,
} from './promotions.service.js';

const day = 24 * 60 * 60 * 1000;

test('an ad is running only while approved and between its dates', () => {
    const now = new Date('2026-09-18T12:00:00Z');
    const base = { status: 'approved', startDate: new Date(now - day), endDate: new Date(+now + day) };
    assert.equal(adState(base, now), 'running');
    assert.equal(adState({ ...base, startDate: new Date(+now + day) }, now), 'scheduled');
    assert.equal(adState({ ...base, endDate: new Date(now - 1) }, now), 'expired');
    assert.equal(adState({ ...base, status: 'paused' }, now), 'paused');
    assert.equal(reelState({ isActive: false, alwaysVisible: true }, now), 'off');
    assert.equal(reelState({ isActive: true, alwaysVisible: false, endDate: new Date(now - 1) }, now), 'expired');
});

const made = { restaurants: [] };
test.after(async () => {
    await prisma.foodRestaurant.deleteMany({ where: { id: { in: made.restaurants } } });
    await prisma.$disconnect();
});

test('a restaurant request waits for approval; approved ads run and reels count', async () => {
    const r = await prisma.foodRestaurant.create({
        data: { restaurantName: `Promo ${Date.now()}`, ownerName: 'O', ownerPhone: uniquePhone('9'), status: 'approved' },
    });
    made.restaurants.push(r.id);
    const from = new Date(Date.now() - day).toISOString();
    const to = new Date(Date.now() + day).toISOString();

    const request = await requestAd(r.id, { type: 'video', title: 'Try us', videoUrl: '/uploads/food/advertisements/x.mp4', startDate: from, endDate: to });
    assert.equal(request.state, 'pending');
    assert.ok(!(await listRunningAds()).some((a) => a.id === request.id), 'not shown before approval');
    await assert.rejects(() => decideAd(request.id, { status: 'denied' }), /Say why/);

    await decideAd(request.id, { status: 'approved' });
    const running = (await listRunningAds()).find((a) => a.id === request.id);
    assert.ok(running, 'shown once approved');
    assert.equal(running.restaurant.name, r.restaurantName);
    await assert.rejects(() => withdrawAdRequest(r.id, request.id), /still waiting/);

    await assert.rejects(() => createAdAdmin({ restaurantId: r.id, type: 'restaurant', title: 'No cover', startDate: from, endDate: to }), /cover image/);
    const placed = await createAdAdmin({ restaurantId: r.id, type: 'restaurant', title: 'Card', coverImage: '/uploads/a.webp', startDate: from, endDate: to, showRating: false });
    assert.equal(placed.state, 'running', 'an admin-placed ad needs no approval');
    assert.equal((await listRunningAds()).find((a) => a.id === placed.id).restaurant.rating, undefined, 'rating hidden when asked');

    const reel = await createReel({ restaurantId: r.id, videoUrl: '/uploads/food/reels/r.mp4', description: 'Hot' });
    await countReelEvent(reel.id, 'view');
    await countReelEvent(reel.id, 'view');
    await countReelEvent(reel.id, 'like');
    const shown = (await listShowingReels()).find((x) => x.id === reel.id);
    assert.equal(shown.views, 2);
    assert.equal(shown.likes, 1);
    await assert.rejects(() => countReelEvent(reel.id, 'share'), /Invalid reel event/);
});
