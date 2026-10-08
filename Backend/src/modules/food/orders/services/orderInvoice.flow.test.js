import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../../config/prisma.js';
import { uniquePhone, uniqueTag } from '../../../../utils/testIds.js';
import { testPatch } from '../../../../utils/testGeo.js';
import { recordTransaction } from '../../../../core/payments/transaction.service.js';
import { calculateOrder, createOrder } from './order.service.js';
import { createAdminOffer } from '../../admin/services/adminOffer.service.js';
import { validateCreateOfferDto } from '../../admin/validators/offer.validator.js';
import { saveSystemSettings } from '../../admin/services/adminSystemExtras.service.js';
import { invalidateBusinessSettings } from '../../shared/businessSettings.js';
import {
    getOrderInvoice,
    renderInvoiceHtml,
    escapeHtml,
    formatInvoiceDate,
    formatInvoiceMoney,
} from './orderInvoice.service.js';
import {
    getOrderInvoiceAdminController,
    getOrderInvoiceRestaurantController,
    getOrderInvoiceUserController,
} from '../controllers/order.controller.js';

/**
 * Order invoices (admin, restaurant and customer copies) built from real
 * orders placed through createOrder: the bill lines must add up to the order
 * total for every kind of order, all three copies must agree, and nobody may
 * read someone else's bill.
 *
 * Fee row: delivery 40 (band), platform fee 5, GST 5% on items, 18% on delivery.
 */
const HERE = testPatch(61);
const AREAS = ['business_payment', 'business_customer', 'business_order', 'business_deliveryman', 'business_info'];
const DAY = 86400000;
const ymd = (ms) => new Date(Date.now() + ms + 5.5 * 3600000).toISOString().slice(0, 10);
const created = { zones: [], restaurants: [], users: [], foods: [], categories: [], fees: [], offers: [], addons: [], campaigns: [] };
const ctx = {};

const set = (area, value) => saveSystemSettings(area, { value });
const resetSettings = async () => {
    await prisma.foodSystemSetting.deleteMany({ where: { key: { in: AREAS } } });
    invalidateBusinessSettings();
};

const close = (actual, expected, label) =>
    assert.ok(Math.abs(Number(actual) - Number(expected)) < 0.005, `${label}: ${actual} != ${expected}`);

const address = () => ({
    label: 'Home', fullName: 'Invoice <Tester>', street: '1 Test Street', city: 'Indore', state: 'MP',
    zipCode: '452001', phone: uniquePhone('5'), latitude: HERE.lat, longitude: HERE.lng,
});

const line = (extra = {}) => ({
    itemId: ctx.foodId, variantId: ctx.variantId, quantity: 2, addons: [{ addonId: ctx.addonId }], ...extra,
});

const cart = (extra = {}) => ({
    restaurantId: ctx.restaurantId,
    items: [line()],
    address: address(),
    paymentMethod: 'cash',
    ...extra,
});

const makeUser = async (balance = 0) => {
    const user = await prisma.foodUser.create({ data: { name: `Inv ${uniqueTag('u')}`, phone: uniquePhone('5') } });
    created.users.push(user.id);
    if (balance > 0) {
        await recordTransaction({
            entityType: 'user', entityId: user.id, type: 'credit', amount: balance,
            description: 'test top-up', category: 'other',
        });
    }
    return user.id;
};

/** Quote then place with the quote's pricing, as the apps do. */
const place = async (userId, extra = {}) => {
    const quote = await calculateOrder(userId, cart(extra));
    const { order } = await createOrder(userId, cart({ ...extra, pricing: quote.pricing }));
    return order;
};

const makeCoupon = async (body = {}) => {
    const offer = await createAdminOffer(validateCreateOfferDto({
        title: 'Invoice coupon', couponCode: uniqueTag('INV'), couponType: 'default',
        discountType: 'percent', discountValue: 10, startDate: ymd(-DAY), endDate: ymd(10 * DAY), ...body,
    }));
    created.offers.push(offer.id);
    return offer;
};

/** Every line that counts toward the total adds up to it. */
const assertSums = (invoice, label) => {
    const sum = invoice.lines.filter((l) => l.inTotal).reduce((s, l) => s + l.amount, 0);
    close(sum, invoice.total, `${label}: lines sum to total`);
    assert.ok(!invoice.lines.some((l) => l.key === 'adjustment'), `${label}: no adjustment line needed`);
};
const lineOf = (invoice, key) => invoice.lines.find((l) => l.key === key);

/** All three copies, checked to agree on every number. */
const copies = async (orderId, userId) => {
    const [admin, restaurant, customer] = await Promise.all([
        getOrderInvoice(orderId, { copy: 'admin' }),
        getOrderInvoice(orderId, { copy: 'restaurant', restaurantId: ctx.restaurantId }),
        getOrderInvoice(orderId, { copy: 'customer', userId }),
    ]);
    for (const other of [restaurant, customer]) {
        assert.deepEqual(other.lines, admin.lines, 'same bill lines on every copy');
        assert.equal(other.total, admin.total);
        assert.deepEqual(other.items, admin.items);
        assert.deepEqual(other.payment, admin.payment);
    }
    assert.equal(admin.restaurantEarning, null);
    assert.equal(customer.restaurantEarning, null);
    assert.ok(restaurant.restaurantEarning, 'the restaurant copy carries its earning');
    return { admin, restaurant, customer };
};

test.before(async () => {
    await resetSettings();
    const tag = uniqueTag('Inv');
    const zone = await prisma.foodZone.create({ data: { name: `${tag} Zone`, coordinates: HERE.ring, isActive: true } });
    created.zones.push(zone.id);
    const restaurant = await prisma.foodRestaurant.create({
        data: {
            restaurantName: `${tag} <script>alert(1)</script> Kitchen`, ownerName: 'Owner', ownerPhone: uniquePhone('9'),
            status: 'approved', zoneId: zone.id, latitude: HERE.lat, longitude: HERE.lng,
            addressLine1: '5 Market Road', city: 'Indore',
            isAcceptingOrders: true, outsideHoursOverride: true,
        },
    });
    created.restaurants.push(restaurant.id);
    ctx.restaurantId = restaurant.id;
    const other = await prisma.foodRestaurant.create({
        data: {
            restaurantName: `${tag} Other`, ownerName: 'Owner', ownerPhone: uniquePhone('9'),
            status: 'approved', zoneId: zone.id, latitude: HERE.lat, longitude: HERE.lng,
        },
    });
    created.restaurants.push(other.id);
    ctx.otherRestaurantId = other.id;

    const category = await prisma.foodCategory.create({ data: { name: `${tag} Mains`, restaurantId: restaurant.id, approvalStatus: 'approved' } });
    created.categories.push(category.id);
    const food = await prisma.foodItem.create({
        data: {
            restaurantId: restaurant.id, categoryId: category.id, categoryName: category.name,
            name: `${tag} Pizza`, price: 250, approvalStatus: 'approved', isAvailable: true,
            variants: { create: [{ name: 'Large', price: 300 }] },
        },
        include: { variants: true },
    });
    created.foods.push(food.id);
    ctx.foodId = food.id;
    ctx.variantId = food.variants[0].id;
    const addon = await prisma.foodAddon.create({
        data: {
            restaurantId: restaurant.id, foodIds: [food.id],
            draft: { name: 'Cheese', price: 30 }, published: { name: 'Cheese', price: 30 },
            approvalStatus: 'approved', isAvailable: true,
        },
    });
    created.addons.push(addon.id);
    ctx.addonId = addon.id;

    const fee = await prisma.foodFeeSettings.create({
        data: {
            zoneId: zone.id, isActive: true, deliveryFee: 40, platformFee: 5, platformFeeEnabled: true,
            gstRate: 5, gstEnabled: true, deliveryFeeGstRate: 18, deliveryFeeGstEnabled: true,
            deliveryFeeBands: { create: [{ minDistanceKm: 0, maxDistanceKm: 50, fee: 40, deliveryBoyBasePay: 25 }] },
        },
    });
    created.fees.push(fee.id);
});

test.after(async () => {
    await resetSettings();
    const orders = await prisma.foodOrder.findMany({ where: { restaurantId: { in: created.restaurants } }, select: { id: true } });
    const ids = orders.map((o) => o.id);
    await prisma.foodTransaction.deleteMany({ where: { orderId: { in: ids } } });
    await prisma.orderItem.deleteMany({ where: { orderId: { in: ids } } });
    await prisma.orderStatusHistory.deleteMany({ where: { orderId: { in: ids } } });
    await prisma.orderDispatchOffer.deleteMany({ where: { orderId: { in: ids } } }).catch(() => {});
    await prisma.transaction.deleteMany({ where: { entityType: 'user', entityId: { in: created.users } } });
    await prisma.wallet.deleteMany({ where: { entityType: 'user', entityId: { in: created.users } } });
    await prisma.foodNotification.deleteMany({ where: { ownerId: { in: [...created.users, ...created.restaurants] } } }).catch(() => {});
    await prisma.foodOrder.deleteMany({ where: { id: { in: ids } } });
    await prisma.foodOfferUsage.deleteMany({ where: { offerId: { in: created.offers } } }).catch(() => {});
    await prisma.foodOffer.deleteMany({ where: { id: { in: created.offers } } });
    await prisma.foodItemCampaign.deleteMany({ where: { id: { in: created.campaigns } } });
    await prisma.foodFeeSettings.deleteMany({ where: { id: { in: created.fees } } });
    await prisma.foodAddon.deleteMany({ where: { id: { in: created.addons } } });
    await prisma.foodItem.deleteMany({ where: { id: { in: created.foods } } });
    await prisma.foodCategory.deleteMany({ where: { id: { in: created.categories } } });
    await prisma.foodUser.deleteMany({ where: { id: { in: created.users } } });
    await prisma.foodRestaurant.deleteMany({ where: { id: { in: created.restaurants } } });
    await prisma.foodZone.deleteMany({ where: { id: { in: created.zones } } });
    await prisma.$disconnect();
});

test('formatting matches the old receipt', () => {
    // 07:57 UTC = 01:27 pm IST
    assert.equal(formatInvoiceDate('2026-09-14T07:57:00Z'), '14/Sep/2026 01:27:pm');
    assert.equal(formatInvoiceDate('2026-09-13T18:35:00Z'), '14/Sep/2026 12:05:am');
    assert.equal(formatInvoiceMoney(150), '₹ 150');
    assert.equal(formatInvoiceMoney(12.5), '₹ 12.50');
    assert.equal(escapeHtml(`<a href="x">'&\``), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#96;');
});

test('a normal order: variant + add-on, GST, delivery GST, platform fee, additional charge -- lines sum to the total', async () => {
    await set('business_info', { additionalCharge: { enabled: true, name: 'Service <b>fee</b>', amount: 7 } });
    try {
        const userId = await makeUser();
        const order = await place(userId);
        const { admin, restaurant } = await copies(order.id, userId);
        assertSums(admin, 'normal');

        close(admin.total, order.pricing.total, 'total is the order total');
        assert.equal(admin.title, 'Cash receipt');
        assert.match(admin.orderId, /^FOD-/);
        assert.match(admin.date, /^\d{2}\/[A-Z][a-z]{2}\/\d{4} \d{2}:\d{2}:(am|pm)$/);
        assert.equal(admin.items.length, 1);
        const item = admin.items[0];
        assert.equal(item.variantName, 'Large');
        assert.deepEqual(item.addons, [{ name: 'Cheese', price: 30 }]);
        close(item.unitPrice, 330, 'unit price includes the add-on');
        close(item.lineTotal, 660, 'line');
        close(lineOf(admin, 'itemsPrice').amount, 600, 'items price');
        close(lineOf(admin, 'addonCost').amount, 60, 'addon cost');
        close(lineOf(admin, 'subtotal').amount, 660, 'subtotal');
        close(lineOf(admin, 'tax').amount, 33, 'GST 5%');
        close(lineOf(admin, 'deliveryFee').amount, 40, 'delivery');
        close(lineOf(admin, 'deliveryFeeGst').amount, 7.2, 'delivery GST');
        close(lineOf(admin, 'platformFee').amount, 5, 'platform fee without the additional charge');
        const extra = lineOf(admin, 'additionalCharge');
        assert.equal(extra.label, 'Service <b>fee</b>');
        close(extra.amount, 7, 'additional charge');
        close(lineOf(admin, 'riderTip').amount, 0, 'tip line always printed');
        close(lineOf(admin, 'discount').amount, 0, 'discount line always printed');
        close(lineOf(admin, 'couponDiscount').amount, 0, 'coupon line always printed');
        assert.equal(lineOf(admin, 'campaignDiscount'), undefined, 'no campaign line when zero');
        assert.equal(admin.payment.methodLabel, 'Cash on delivery');
        assert.equal(admin.payment.statusLabel, 'Unpaid');
        assert.equal(admin.customer.name, 'Invoice <Tester>');
        assert.match(admin.customer.address, /1 Test Street, Indore/);
        assert.match(admin.restaurant.address, /5 Market Road/);

        const earning = restaurant.restaurantEarning;
        close(earning.lines.find((l) => l.key === 'itemTotal').amount, 660, 'restaurant item total');
        assert.ok(earning.lines.find((l) => l.key === 'commission').amount < 0, 'commission is taken off');
        assert.ok(earning.netPayout > 0 && earning.netPayout < 660, `payout ${earning.netPayout}`);
    } finally {
        await resetSettings();
    }
});

test('coupon + free delivery over: coupon and "Free delivery" lines, still summing', async () => {
    await set('business_order', { freeDelivery: { enabled: true, minSubtotal: 100 } });
    try {
        const coupon = await makeCoupon();
        const userId = await makeUser();
        const order = await place(userId, { couponCode: coupon.couponCode });
        const { customer } = await copies(order.id, userId);
        assertSums(customer, 'coupon + free delivery');
        close(lineOf(customer, 'couponDiscount').amount, -66, 'coupon 10% of 660');
        assert.match(lineOf(customer, 'couponDiscount').label, new RegExp(coupon.couponCode));
        assert.equal(lineOf(customer, 'deliveryFee').display, 'Free delivery');
        close(lineOf(customer, 'deliveryFee').amount, 0, 'fee waived');
        assert.equal(lineOf(customer, 'deliveryFeeGst'), undefined, 'GST on a waived fee is not printed');
    } finally {
        await resetSettings();
    }
});

test('free-delivery coupon', async () => {
    const coupon = await makeCoupon({ couponType: 'free_delivery', discountType: '', discountValue: '' });
    const userId = await makeUser();
    const order = await place(userId, { couponCode: coupon.couponCode });
    const { admin } = await copies(order.id, userId);
    assertSums(admin, 'free-delivery coupon');
    assert.equal(lineOf(admin, 'deliveryFee').display, 'Free delivery');
});

test('rider tip is printed and counted', async () => {
    await set('business_deliveryman', { tipsEnabled: true });
    try {
        const userId = await makeUser();
        const order = await place(userId, { riderTip: 30 });
        const { admin } = await copies(order.id, userId);
        assertSums(admin, 'tip');
        close(lineOf(admin, 'riderTip').amount, 30, 'tip');
    } finally {
        await resetSettings();
    }
});

test('partial payment: wallet + cash split under the total', async () => {
    await set('business_payment', { partialPayment: true });
    try {
        const userId = await makeUser(100);
        const order = await place(userId, { useWallet: true, walletAmount: 100 });
        const { customer } = await copies(order.id, userId);
        assertSums(customer, 'partial');
        assert.equal(customer.payment.isPartial, true);
        close(customer.payment.walletAmount, 100, 'wallet part');
        close(customer.payment.amountDue, customer.total - 100, 'cash part');
        assert.equal(customer.payment.split.length, 2);
        assert.match(customer.payment.methodLabel, /^Wallet ₹ 100 \+ Cash on delivery ₹ /);
        assert.equal(customer.payment.statusLabel, 'Partially paid');
    } finally {
        await resetSettings();
    }
});

test('takeaway: "Takeaway" address and delivery line, no fee', async () => {
    await set('business_order', { takeaway: true });
    try {
        const userId = await makeUser();
        const { address: _a, ...noAddress } = cart({ orderType: 'takeaway', paymentMethod: 'razorpay' });
        const quote = await calculateOrder(userId, noAddress);
        const { order } = await createOrder(userId, { ...noAddress, pricing: quote.pricing });
        // A takeaway is paid in the app; mark it paid as the payment flow would.
        await prisma.foodOrder.update({ where: { id: order.id }, data: { paymentStatus: 'paid', orderStatus: 'created' } });
        const { admin } = await copies(order.id, userId);
        assertSums(admin, 'takeaway');
        assert.equal(admin.customer.address, 'Takeaway');
        assert.equal(admin.orderType, 'takeaway');
        assert.equal(lineOf(admin, 'deliveryFee').display, 'Takeaway');
        assert.equal(admin.payment.statusLabel, 'Paid');
        assert.equal(admin.payment.methodLabel, 'Online payment');
    } finally {
        await resetSettings();
    }
});

test('campaign dish: campaign discount line', async () => {
    const row = await prisma.foodItemCampaign.create({
        data: {
            restaurantId: ctx.restaurantId, title: uniqueTag('Camp Thali '), price: 200,
            discountType: 'percent', discount: 25,
            startsAt: new Date(Date.now() - 3600000), endsAt: new Date(Date.now() + 3600000),
        },
    });
    created.campaigns.push(row.id);
    const userId = await makeUser();
    const order = await place(userId, {
        items: [line({ quantity: 1 }), { itemId: row.id, campaignId: row.id, name: 'Thali', price: 1, quantity: 2 }],
    });
    const { admin } = await copies(order.id, userId);
    assertSums(admin, 'campaign');
    close(lineOf(admin, 'campaignDiscount').amount, -100, 'campaign 25% of 2 x 200');
    assert.equal(admin.items.length, 2);
    assert.equal(admin.items[1].campaign, true);
});

test('new customer discount line', async () => {
    await set('business_customer', { newCustomerDiscount: { enabled: true, type: 'amount', value: 50 } });
    try {
        const userId = await makeUser();
        const order = await place(userId);
        const { admin } = await copies(order.id, userId);
        assertSums(admin, 'new customer');
        close(lineOf(admin, 'newCustomerDiscount').amount, -50, 'first-order discount');
        close(lineOf(admin, 'couponDiscount').amount, 0, 'not a coupon');
    } finally {
        await resetSettings();
    }
});

test('access: another customer or restaurant gets 404; display id works for the owner', async () => {
    const owner = await makeUser();
    const stranger = await makeUser();
    const order = await place(owner);
    await assert.rejects(getOrderInvoice(order.id, { copy: 'customer', userId: stranger }), (e) => e.statusCode === 404);
    await assert.rejects(getOrderInvoice(order.id, { copy: 'customer' }), (e) => e.statusCode === 404);
    await assert.rejects(
        getOrderInvoice(order.id, { copy: 'restaurant', restaurantId: ctx.otherRestaurantId }),
        (e) => e.statusCode === 404,
    );
    const byDisplay = await getOrderInvoice(order.order_id || order.orderId, { copy: 'customer', userId: owner });
    assert.equal(byDisplay.id, order.id);
    await assert.rejects(getOrderInvoice('FOD-000000nope', { copy: 'admin' }), (e) => e.statusCode === 404);

    // Through the controllers: the error reaches next() as a 404.
    let error;
    await getOrderInvoiceUserController(
        { params: { orderId: order.id }, query: {}, user: { userId: stranger } },
        {},
        (err) => { error = err; },
    );
    assert.equal(error?.statusCode, 404);
    error = undefined;
    await getOrderInvoiceRestaurantController(
        { params: { orderId: order.id }, query: {}, user: { userId: ctx.otherRestaurantId } },
        {},
        (err) => { error = err; },
    );
    assert.equal(error?.statusCode, 404);
});

const mockRes = () => {
    const res = { headers: {}, statusCode: 0, body: null };
    res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
    res.type = (t) => { res.headers['content-type'] = t; return res; };
    res.status = (c) => { res.statusCode = c; return res; };
    res.send = (b) => { res.body = b; return res; };
    res.json = (b) => { res.body = b; return res; };
    return res;
};

test('HTML: escapes names, thermal by default, A4 on request, own CSP', async () => {
    await set('business_info', { additionalCharge: { enabled: true, name: 'Service <b>fee</b>', amount: 7 } });
    try {
        const userId = await makeUser();
        const order = await place(userId, { note: '"><img src=x onerror=alert(1)>' });

        const res = mockRes();
        let failed;
        await getOrderInvoiceAdminController({ params: { orderId: order.id }, query: { format: 'html', print: '1' } }, res, (e) => { failed = e; });
        assert.equal(failed, undefined, failed?.message);
        assert.equal(res.statusCode, 200);
        assert.equal(res.headers['content-type'], 'html');
        const html = res.body;
        assert.match(res.headers['content-security-policy'], /script-src 'nonce-[^']+'/);
        const nonce = res.headers['content-security-policy'].match(/'nonce-([^']+)'/)[1];
        assert.ok(html.includes(`<script nonce="${nonce}">`), 'the print script carries the nonce');
        assert.equal((html.match(/<script/g) || []).length, 1, 'no other script');
        assert.ok(!html.includes('<script>alert'), 'restaurant name escaped');
        assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
        assert.ok(!html.includes('<img src=x'), 'note escaped');
        assert.ok(html.includes('Invoice &lt;Tester&gt;'));
        assert.ok(html.includes('Service &lt;b&gt;fee&lt;/b&gt;'));
        assert.ok(html.includes('size: 80mm auto'), 'thermal by default');
        assert.ok(html.includes('Cash receipt'));
        assert.ok(html.includes('THANK YOU'));
        assert.ok(!html.includes('Items price'), 'the thermal receipt starts at Subtotal');

        const json = mockRes();
        await getOrderInvoiceUserController({ params: { orderId: order.id }, query: {}, user: { userId } }, json, (e) => { throw e; });
        assert.equal(json.body.success, true);
        assert.equal(json.body.data.invoice.id, order.id);

        const invoice = await getOrderInvoice(order.id, { copy: 'restaurant', restaurantId: ctx.restaurantId });
        const a4 = renderInvoiceHtml(invoice, { size: 'a4' });
        assert.ok(a4.includes('size: A4'));
        assert.ok(a4.includes('Items price'));
        assert.ok(a4.includes('Your earning'));
        assert.ok(a4.includes("You'll receive") || a4.includes('You&#39;ll receive'));
        assert.ok(!a4.includes('<script'), 'no script without print');

        // A logo URL that is not http(s) never reaches the page.
        const evil = renderInvoiceHtml({ ...invoice, business: { ...invoice.business, logoUrl: 'javascript:alert(1)' } });
        assert.ok(!evil.includes('javascript:'));
    } finally {
        await resetSettings();
    }
});
