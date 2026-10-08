import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../config/prisma.js';
import { uniquePhone, uniqueTag } from '../../../utils/testIds.js';
import { testPatch } from '../../../utils/testGeo.js';
import { calculateOrder, createOrder } from '../orders/services/order.service.js';
import { getOrderMoneyReport } from '../admin/services/adminOrderMoneyReport.service.js';

/**
 * A food campaign dish ordered through the real checkout: priced from the
 * campaign row (never from the client), its discount platform-funded, the
 * restaurant settled on the full price, and the Transaction report adding up.
 */
const HERE = testPatch(23);
const hour = 60 * 60 * 1000;
const made = { zones: [], restaurants: [], users: [], foods: [], categories: [], campaigns: [] };
let restaurantId;
let otherRestaurantId;
let userId;
let foodId;
let campaignId;

const address = () => ({
    label: 'Home',
    fullName: 'Camp Customer',
    street: '1 Test Street',
    city: 'Indore',
    state: 'MP',
    phone: uniquePhone('5'),
    latitude: HERE.lat,
    longitude: HERE.lng,
});

const restaurantData = (name, zoneId) => ({
    restaurantName: name,
    ownerName: 'Owner',
    ownerPhone: uniquePhone('9'),
    status: 'approved',
    zoneId,
    latitude: HERE.lat,
    longitude: HERE.lng,
    isAcceptingOrders: true,
    outsideHoursOverride: true,
});

const campaign = async (over = {}) => {
    const row = await prisma.foodItemCampaign.create({
        data: {
            restaurantId,
            title: uniqueTag('Camp Thali '),
            price: 200,
            discountType: 'percent',
            discount: 25,
            startsAt: new Date(Date.now() - hour),
            endsAt: new Date(Date.now() + hour),
            ...over,
        },
    });
    made.campaigns.push(row.id);
    return row;
};

test.before(async () => {
    const tag = uniqueTag('CampOrd');
    const zone = await prisma.foodZone.create({ data: { name: `${tag} Zone`, coordinates: HERE.ring, isActive: true } });
    made.zones.push(zone.id);
    const r = await prisma.foodRestaurant.create({ data: restaurantData(`${tag} Kitchen`, zone.id) });
    const other = await prisma.foodRestaurant.create({ data: restaurantData(`${tag} Other`, zone.id) });
    made.restaurants.push(r.id, other.id);
    restaurantId = r.id;
    otherRestaurantId = other.id;
    // 10% commission, so the restaurant's settlement is checkable.
    await prisma.foodRestaurantCommission.create({
        data: { restaurantId, commissionType: 'percentage', commissionValue: 10 },
    });

    const category = await prisma.foodCategory.create({ data: { name: `${tag} Mains`, restaurantId, approvalStatus: 'approved' } });
    made.categories.push(category.id);
    const food = await prisma.foodItem.create({
        data: {
            restaurantId, categoryId: category.id, categoryName: category.name,
            name: `${tag} Roti`, price: 100, approvalStatus: 'approved', isAvailable: true,
        },
    });
    made.foods.push(food.id);
    foodId = food.id;

    const user = await prisma.foodUser.create({ data: { name: `${tag} Customer`, phone: uniquePhone('5') } });
    made.users.push(user.id);
    userId = user.id;

    campaignId = (await campaign()).id;
});

test.after(async () => {
    const orders = await prisma.foodOrder.findMany({ where: { restaurantId: { in: made.restaurants } }, select: { id: true } });
    const ids = orders.map((o) => o.id);
    await prisma.foodTransaction.deleteMany({ where: { orderId: { in: ids } } });
    await prisma.orderItem.deleteMany({ where: { orderId: { in: ids } } });
    await prisma.orderStatusHistory.deleteMany({ where: { orderId: { in: ids } } });
    await prisma.foodOrder.deleteMany({ where: { id: { in: ids } } });
    await prisma.foodItemCampaign.deleteMany({ where: { id: { in: made.campaigns } } });
    await prisma.foodItem.deleteMany({ where: { id: { in: made.foods } } });
    await prisma.foodCategory.deleteMany({ where: { id: { in: made.categories } } });
    await prisma.foodRestaurantCommission.deleteMany({ where: { restaurantId: { in: made.restaurants } } });
    await prisma.foodUser.deleteMany({ where: { id: { in: made.users } } });
    await prisma.foodRestaurant.deleteMany({ where: { id: { in: made.restaurants } } });
    await prisma.foodZone.deleteMany({ where: { id: { in: made.zones } } });
    await prisma.$disconnect();
});

// The client claims the dish costs 1; the server must not care.
const cart = (items) => ({ restaurantId, items, address: address(), paymentMethod: 'cash' });
const campaignLine = (id = campaignId, quantity = 2) => ({ itemId: id, campaignId: id, name: 'Thali', price: 1, quantity });

test('a campaign dish is priced from the campaign, not from the client', async () => {
    const quote = await calculateOrder(userId, cart([{ itemId: foodId, quantity: 1 }, campaignLine()]));
    const p = quote.pricing;

    // 100 (menu) + 2 x 200 (campaign full price); the campaign takes 2 x 50 off.
    assert.equal(p.subtotal, 500);
    assert.equal(p.campaignDiscount, 100);
    assert.equal(p.discount, round(100 + p.newCustomerDiscount));
    assert.equal(
        p.total,
        round(p.subtotal + p.packagingFee + p.deliveryFee + p.deliveryFeeGst + p.platformFee + p.tax - p.discount),
    );

    const line = quote.items.find((i) => i.itemCampaignId === campaignId);
    assert.equal(line.price, 200);
    assert.equal(line.campaignPrice, 150);
    // The 1 the client sent comes back as a price change to 150.
    const change = quote.priceChanges.find((c) => c.itemId === campaignId);
    assert.deepEqual([change.previousPrice, change.price], [1, 150]);
    // Sending the right price raises no change.
    const again = await calculateOrder(userId, cart([{ ...campaignLine(), price: 150 }]));
    assert.equal(again.priceChanges.length, 0);
});

test('the order, its ledger and the Transaction report agree', async () => {
    const quote = await calculateOrder(userId, cart([{ itemId: foodId, quantity: 1 }, campaignLine()]));
    const { order } = await createOrder(userId, cart([{ itemId: foodId, quantity: 1 }, campaignLine()]));
    const id = order._id || order.id;

    const row = await prisma.foodOrder.findUnique({ where: { id }, include: { items: true } });
    assert.equal(Number(row.total), quote.pricing.total);
    assert.equal(Number(row.campaignDiscount), 100);
    assert.equal(order.pricing.campaignDiscount, 100);
    const line = row.items.find((i) => i.itemCampaignId === campaignId);
    assert.ok(line, 'the line remembers its campaign');
    assert.equal(line.itemId, campaignId);
    assert.equal(Number(line.price), 200);
    assert.equal(line.quantity, 2);

    // Platform-funded: commission and settlement on the full 500.
    const tx = await prisma.foodTransaction.findUnique({ where: { orderId: id } });
    assert.equal(Number(tx.commissionAmount), 50);
    assert.equal(Number(tx.restaurantDiscountShare), 0);
    assert.equal(Number(tx.adminDiscountShare), round(100 + Number(row.newCustomerDiscount)));
    assert.equal(Number(tx.restaurantShare), 450);

    // Delivered, it reconciles in the Transaction report.
    await prisma.foodOrder.update({ where: { id }, data: { orderStatus: 'delivered', deliveryPhase: 'delivered' } });
    const day = (offset) => new Date(Date.now() + offset * 24 * hour).toISOString().slice(0, 10);
    const report = await getOrderMoneyReport({ from: day(-1), to: day(1), restaurantId, limit: 100 });
    const r = report.orders.find((o) => o.id === id);
    assert.ok(r, 'the order is in the report');
    assert.equal(r.campaignDiscount, 100);
    assert.equal(r.couponDiscount, round(Number(row.discount) - 100));
    assert.equal(r.storeNetIncome, 450);
    assert.equal(r.orderAmount, round(r.storeNetIncome + r.adminNetIncome + r.deliverymanEarning + r.vatTax));
});

test('campaign dishes are refused unless running and from this restaurant', async () => {
    const off = await campaign({ isActive: false });
    const ended = await campaign({ startsAt: new Date(Date.now() - 3 * hour), endsAt: new Date(Date.now() - hour) });
    const later = await campaign({ startsAt: new Date(Date.now() + hour), endsAt: new Date(Date.now() + 2 * hour) });
    const elsewhere = await campaign({ restaurantId: otherRestaurantId });

    for (const c of [off, ended, later]) {
        await assert.rejects(() => calculateOrder(userId, cart([campaignLine(c.id)])), /not running/);
    }
    await assert.rejects(() => calculateOrder(userId, cart([campaignLine(elsewhere.id)])), /no longer available/);
    await assert.rejects(() => calculateOrder(userId, cart([campaignLine('b'.repeat(24))])), /no longer available/);

    // Ordered for later, the campaign must be running then.
    const at = new Date(Date.now() + 90 * 60 * 1000).toISOString();
    const scheduled = await calculateOrder(userId, { ...cart([campaignLine(later.id, 1)]), scheduledAt: at });
    assert.equal(scheduled.pricing.campaignDiscount, 50);
});

function round(v) {
    return Math.round((Number(v) || 0) * 100) / 100;
}
