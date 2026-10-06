import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../config/prisma.js';
import { uniquePhone, uniqueTag } from '../../../utils/testIds.js';
import {
    createBasicCampaign,
    createFoodCampaign,
    listRunningCampaigns,
    setCampaignRestaurant,
    updateBasicCampaign,
    updateFoodCampaign,
} from './campaigns.service.js';

const hour = 60 * 60 * 1000;
const made = { restaurants: [], campaigns: [] };

test.after(async () => {
    await prisma.foodCampaign.deleteMany({ where: { id: { in: made.campaigns } } });
    await prisma.foodRestaurant.deleteMany({ where: { id: { in: made.restaurants } } });
    await prisma.$disconnect();
});

test('only running campaigns reach the customer app, with their restaurants', async () => {
    const r = await prisma.foodRestaurant.create({
        data: { restaurantName: uniqueTag('Camp '), ownerName: 'O', ownerPhone: uniquePhone('9'), status: 'approved' },
    });
    made.restaurants.push(r.id);
    const from = new Date(Date.now() - hour).toISOString();
    const to = new Date(Date.now() + hour).toISOString();

    await assert.rejects(() => createBasicCampaign({ title: 'Backwards', startsAt: to, endsAt: from }), /end after it starts/);
    const basic = await createBasicCampaign({ title: uniqueTag('Feast '), startsAt: from, endsAt: to });
    made.campaigns.push(basic.id);
    assert.equal(basic.state, 'running');
    await setCampaignRestaurant(basic.id, r.id, true);
    await setCampaignRestaurant(basic.id, r.id, true); // joining twice is harmless

    await assert.rejects(() => createFoodCampaign({ restaurantId: r.id, title: 'Too cheap', price: 100, discountType: 'amount', discount: 150, startsAt: from, endsAt: to }), /more than the price/);
    const food = await createFoodCampaign({ restaurantId: r.id, title: uniqueTag('Biryani '), price: 200, discountType: 'percent', discount: 25, startsAt: from, endsAt: to });
    assert.equal(food.finalPrice, 150);

    let running = await listRunningCampaigns();
    assert.equal(running.basic.find((c) => c.id === basic.id).restaurants[0].id, r.id);
    assert.equal(running.food.find((c) => c.id === food.id).finalPrice, 150);

    await updateBasicCampaign(basic.id, { isActive: false });
    await updateFoodCampaign(food.id, { startsAt: new Date(Date.now() + hour / 2).toISOString() });
    running = await listRunningCampaigns();
    assert.ok(!running.basic.some((c) => c.id === basic.id), 'switched off');
    assert.ok(!running.food.some((c) => c.id === food.id), 'not started yet');
    await assert.rejects(() => updateFoodCampaign(food.id, { endsAt: from }), /end after it starts/);
});
