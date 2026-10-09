/**
 * Shared harness for the end-to-end order tests (e2e*.test.js).
 *
 * Everything a scenario does goes through the real HTTP API the three apps
 * call (USER_APP_API.md, RESTAURANT_API_SPEC.md, DELIVERY_API_SPEC.md), with
 * three stand-ins only:
 *   - Razorpay is a fake client (setRazorpayClientForTests) with fake keys, so
 *     nothing can reach a real account;
 *   - Socket.IO is a fake server that records every emit (setIOForTests);
 *   - jobs that a scheduler runs (scheduled release, stalled-order expiry) are
 *     called directly, as the scheduler would.
 *
 * The test files set the fake Razorpay keys in process.env BEFORE importing
 * this module (config/env.js reads them at import).
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { prisma } from '../../../../config/prisma.js';
import { setIOForTests, rooms } from '../../../../config/socket.js';
import { startTestServer, tokenFor } from '../../../../utils/testHttp.js';
import { uniquePhone, uniqueTag } from '../../../../utils/testIds.js';
import { testPatch } from '../../../../utils/testGeo.js';
import { setRazorpayClientForTests } from '../helpers/razorpay.helper.js';
import { saveSystemSettings } from '../../admin/services/adminSystemExtras.service.js';
import { invalidateBusinessSettings } from '../../shared/businessSettings.js';
import { recordTransaction, getBalance } from '../../../../core/payments/transaction.service.js';
import { getCashInHandMap } from '../../delivery/services/riderCash.service.js';
import { getOrderMoneyReport } from '../../admin/services/adminOrderMoneyReport.service.js';

export const AREAS = ['business_info', 'business_deliveryman', 'business_order', 'business_vendor', 'business_customer',
    'business_payment', 'business_refund', 'website'];

export const money = (v) => Math.round((Number(v) || 0) * 100) / 100;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll until fn() returns something truthy (or throw with the label). */
export async function waitFor(fn, label = 'condition', { timeout = 8000, every = 100 } = {}) {
    const end = Date.now() + timeout;
    let last;
    while (Date.now() < end) {
        last = await fn();
        if (last) return last;
        await sleep(every);
    }
    throw new Error(`Timed out waiting for ${label}`);
}

// ─── Fake Razorpay ───────────────────────────────────────────────────────────

export function makeFakeRazorpay(secret) {
    let n = 0;
    const fake = {
        rzOrders: new Map(),
        payments: new Map(),
        refunds: [],
        qrs: new Map(),
        qrPayments: new Map(),
        calls: [],
    };
    const ordersApi = {
        async create(params) {
            const id = `order_fake${++n}${crypto.randomBytes(3).toString('hex')}`;
            const order = { id, amount: params.amount, currency: params.currency || 'INR', receipt: params.receipt };
            fake.rzOrders.set(id, order);
            fake.calls.push(['orders.create', params.amount]);
            return order;
        },
    };
    const client = {
        orders: ordersApi,
        payments: {
            async fetch(id) {
                const p = fake.payments.get(id);
                if (!p) throw new Error('payment not found');
                return p;
            },
            async refund(paymentId, params) {
                fake.calls.push(['refund', paymentId, params.amount]);
                fake.refunds.push({ paymentId, amount: params.amount });
                return { id: `rfnd_fake${++n}`, status: 'processed' };
            },
        },
        qrCode: {
            async create(params) {
                const id = `qr_fake${++n}${crypto.randomBytes(3).toString('hex')}`;
                const qr = {
                    id, entity: 'qr_code', image_url: `https://rzp.io/fake/${id}.png`, status: 'active',
                    close_by: params.close_by, payment_amount: params.payment_amount, payments_amount_received: 0, notes: params.notes,
                };
                fake.qrs.set(id, qr);
                fake.calls.push(['qr.create', params.payment_amount]);
                return qr;
            },
            async fetch(id) { return fake.qrs.get(id); },
            async fetchAllPayments(id) { return { items: fake.qrPayments.get(id) || [] }; },
            async close(id) { const qr = fake.qrs.get(id); if (qr) qr.status = 'closed'; return qr; },
        },
        paymentLink: {
            async create() { throw new Error('payment links not used in the e2e tests'); },
            async fetch() { return null; },
            async cancel() { return null; },
        },
    };
    /** The customer pays a gateway order in the Razorpay sheet. */
    fake.pay = (rzOrderId, { amount } = {}) => {
        const order = fake.rzOrders.get(rzOrderId);
        const paymentId = `pay_fake${++n}${crypto.randomBytes(3).toString('hex')}`;
        fake.payments.set(paymentId, {
            id: paymentId, entity: 'payment', order_id: rzOrderId, amount: amount ?? order.amount, status: 'captured', method: 'upi',
        });
        const signature = crypto.createHmac('sha256', secret).update(`${rzOrderId}|${paymentId}`).digest('hex');
        return { razorpayOrderId: rzOrderId, razorpayPaymentId: paymentId, razorpaySignature: signature };
    };
    /** The customer scans and pays a door QR. */
    fake.payQr = (qrId) => {
        const qr = fake.qrs.get(qrId);
        const payment = { id: `pay_fakeqr${++n}`, entity: 'payment', amount: qr.payment_amount, status: 'captured', method: 'upi' };
        fake.qrPayments.set(qrId, [...(fake.qrPayments.get(qrId) || []), payment]);
        qr.payments_amount_received += qr.payment_amount;
        qr.status = 'closed';
        qr.close_reason = 'paid';
        return payment;
    };
    fake.client = client;
    return fake;
}

// ─── The world one test file runs in ────────────────────────────────────────

export async function createWorld({ patch, prefix = 'E2E' }) {
    const HERE = testPatch(patch);
    const tag = uniqueTag(prefix);
    const created = { zones: [], restaurants: [], users: [], foods: [], categories: [], fees: [], partners: [], admins: [], offers: [] };
    const emitted = [];
    const fakeIO = { to: (room) => ({ emit: (event, payload) => emitted.push({ room, event, payload, at: Date.now() }) }) };
    setIOForTests(fakeIO);

    const fake = makeFakeRazorpay(process.env.RAZORPAY_KEY_SECRET);
    setRazorpayClientForTests(fake.client);

    const http = await startTestServer();

    const resetSettings = async () => {
        await prisma.foodSystemSetting.deleteMany({ where: { key: { in: AREAS } } });
        invalidateBusinessSettings();
    };
    await resetSettings();
    const set = async (area, value) => {
        await saveSystemSettings(area, { value });
        invalidateBusinessSettings();
    };

    const zone = await prisma.foodZone.create({ data: { name: `${tag} Zone`, coordinates: HERE.ring, isActive: true } });
    created.zones.push(zone.id);

    // Two distance bands: under 3 km the customer pays 30 and the rider earns
    // 20; from 3 km, 50 and 35. Items carry 5% GST, the delivery fee 18%.
    const fee = await prisma.foodFeeSettings.create({
        data: {
            zoneId: zone.id, isActive: true, deliveryFee: 30, platformFee: 0, platformFeeEnabled: false,
            gstRate: 5, gstEnabled: true, deliveryFeeGstRate: 18, deliveryFeeGstEnabled: true,
            deliveryFeeBands: {
                create: [
                    { minDistanceKm: 0, maxDistanceKm: 3, fee: 30, deliveryBoyBasePay: 20 },
                    { minDistanceKm: 3, maxDistanceKm: 50, fee: 50, deliveryBoyBasePay: 35 },
                ],
            },
        },
    });
    created.fees.push(fee.id);

    const restaurant = await prisma.foodRestaurant.create({
        data: {
            restaurantName: `${tag} Kitchen`, ownerName: 'Owner', ownerPhone: uniquePhone('9'),
            status: 'approved', approvedAt: new Date(), zoneId: zone.id, latitude: HERE.lat, longitude: HERE.lng,
            addressLine1: '5 Market Road', city: 'Indore', state: 'MP',
            isAcceptingOrders: true, outsideHoursOverride: true,
        },
    });
    created.restaurants.push(restaurant.id);

    const category = await prisma.foodCategory.create({ data: { name: `${tag} Mains`, restaurantId: restaurant.id, approvalStatus: 'approved' } });
    created.categories.push(category.id);
    const mkFood = async (name, price) => {
        const food = await prisma.foodItem.create({
            data: {
                restaurantId: restaurant.id, categoryId: category.id, categoryName: category.name,
                name: `${tag} ${name}`, price, approvalStatus: 'approved', isAvailable: true,
            },
        });
        created.foods.push(food.id);
        return food;
    };
    const thali = await mkFood('Thali', 200);
    const lassi = await mkFood('Lassi', 60);

    const admin = await prisma.foodAdmin.create({
        data: { name: `${tag} Admin`, email: `${tag.toLowerCase()}@admin.test`, password: 'x', adminType: 'super_admin' },
    });
    created.admins.push(admin.id);

    const W = {
        HERE, tag, created, emitted, fake, http, zone, fee, restaurant, thali, lassi, admin,
        set, resetSettings, rooms,
        tokens: {
            restaurant: tokenFor({ userId: restaurant.id, role: 'RESTAURANT' }),
            admin: tokenFor({ userId: admin.id, role: 'ADMIN', adminType: 'super_admin' }),
        },
    };

    /** About 2.2 km north of the restaurant: the first band. */
    W.address = (over = {}) => ({
        label: 'Home', fullName: `${tag} Diner`, street: '1 Test Street', city: 'Indore', state: 'MP', zipCode: '452001',
        phone: '9876500000',
        location: { type: 'Point', coordinates: [HERE.lng, HERE.lat + 0.02] },
        ...over,
    });

    W.makeUser = async (walletBalance = 0) => {
        const user = await prisma.foodUser.create({ data: { name: `${tag} Diner`, phone: uniquePhone('5') } });
        created.users.push(user.id);
        if (walletBalance > 0) {
            await recordTransaction({
                entityType: 'user', entityId: user.id, type: 'credit', amount: walletBalance,
                description: 'test top-up', category: 'other',
            });
        }
        return { id: user.id, token: tokenFor({ userId: user.id, role: 'USER' }) };
    };

    /** An approved rider, online through the app's availability call, `km` north of the restaurant. */
    W.makeRider = async ({ km = 0.5, online = true } = {}) => {
        const rider = await prisma.foodDeliveryPartner.create({
            data: { name: `${tag} Rider ${uniqueTag('r')}`, phone: uniquePhone('6'), status: 'approved' },
        });
        created.partners.push(rider.id);
        const token = tokenFor({ userId: rider.id, role: 'DELIVERY_PARTNER' });
        if (online) {
            const res = await http.request('PATCH', '/api/v1/food/delivery/availability', {
                token, body: { status: 'online', latitude: HERE.lat + km / 111, longitude: HERE.lng },
            });
            assert.equal(res.status, 200, JSON.stringify(res.body));
            assert.equal(res.body.data.availabilityStatus, 'online');
        }
        return { id: rider.id, token };
    };

    W.balance = async (userId) => money((await getBalance('user', userId)).balance);

    /** A cart line as the apps send it. */
    W.line = (food, quantity = 1) => ({ itemId: food.id, name: food.name, price: Number(food.price), quantity });

    W.cart = (over = {}) => ({
        restaurantId: restaurant.id,
        items: [W.line(thali, 2), W.line(lassi, 1)],
        ...over,
    });

    /** Customer: /orders/calculate then POST /orders with the returned pricing. */
    W.place = async (user, { paymentMethod = 'cash', calc = {}, body = {}, expectStatus = 201 } = {}) => {
        const address = body.address === undefined ? W.address() : body.address;
        const quote = await http.post('/api/v1/food/orders/calculate', {
            token: user.token,
            body: W.cart({ deliveryAddress: address || undefined, ...calc }),
        });
        assert.equal(quote.status, 200, `calculate: ${JSON.stringify(quote.body)}`);
        const pricing = quote.body.data.pricing;
        const res = await http.post('/api/v1/food/orders', {
            token: user.token,
            body: {
                ...W.cart(),
                ...(address ? { address } : {}),
                pricing: {
                    subtotal: pricing.subtotal, tax: pricing.tax, packagingFee: pricing.packagingFee, deliveryFee: pricing.deliveryFee,
                    platformFee: pricing.platformFee, discount: pricing.discount, deliveryFeeWaived: pricing.deliveryFeeWaived,
                    campaignDiscount: pricing.campaignDiscount, total: pricing.total, couponCode: pricing.couponCode,
                },
                paymentMethod,
                note: 'less spicy',
                ...calc,
                ...body,
                ...(body.address === null ? { address: undefined } : {}),
            },
        });
        assert.equal(res.status, expectStatus, `place: ${JSON.stringify(res.body)}`);
        if (expectStatus !== 201) return { quote: quote.body.data, res };
        const order = res.body.data.order;
        return { quote: quote.body.data, order, id: order._id || order.id, razorpay: res.body.data.razorpay, res };
    };

    /** Customer pays a Razorpay order in the sheet and the app verifies it. */
    W.payOnline = async (user, placed) => {
        const proof = W.fake.pay(placed.razorpay.orderId);
        const res = await http.post('/api/v1/food/orders/verify-payment', {
            token: user.token, body: { orderId: placed.id, ...proof },
        });
        assert.equal(res.status, 200, `verify: ${JSON.stringify(res.body)}`);
        return { ...proof, order: res.body.data.order };
    };

    W.userOrder = async (user, id) => {
        const res = await http.get(`/api/v1/food/orders/${id}`, { token: user.token });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        return res.body.data.order;
    };

    W.restaurantStatus = async (id, orderStatus, { note, expect = 200 } = {}) => {
        const res = await http.request('PATCH', `/api/v1/food/restaurant/orders/${id}/status`, {
            token: W.tokens.restaurant, body: { orderStatus, ...(note ? { note } : {}) },
        });
        assert.equal(res.status, expect, `restaurant ${orderStatus}: ${JSON.stringify(res.body)}`);
        return res.body;
    };

    W.restaurantList = async () => {
        const res = await http.get('/api/v1/food/restaurant/orders?limit=100', { token: W.tokens.restaurant });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        return res.body.data.data || res.body.data.orders;
    };

    W.rider = (rider, method, path, body) =>
        http.request(method, `/api/v1/food/delivery${path}`, { token: rider.token, ...(body !== undefined ? { body } : {}) });

    W.admin = (method, path, body) =>
        http.request(method, `/api/v1/food/admin${path}`, { token: W.tokens.admin, ...(body !== undefined ? { body } : {}) });

    /** Socket events, optionally to one room and/or of one name, for one order. */
    W.events = ({ room, event, orderId } = {}) => emitted.filter((e) =>
        (!room || e.room === room) && (!event || e.event === event) &&
        (!orderId || [e.payload?.orderId, e.payload?.orderMongoId, e.payload?._id, e.payload?.id].map(String).includes(String(orderId))));

    /** Wait for dispatch to offer the order to this rider (socket new_order + an offer row). */
    W.waitOffer = async (orderId, rider) => waitFor(async () => {
        const offer = await prisma.orderDispatchOffer.findFirst({ where: { orderId, partnerId: rider.id } });
        return offer && W.events({ room: rooms.delivery(rider.id), orderId }).some((e) => ['new_order', 'new_order_available'].includes(e.event));
    }, `offer of ${orderId} to rider ${rider.id}`);

    /** Restaurant accepts and cooks; dispatch offers to the rider; the rider accepts. */
    W.acceptAndAssign = async (id, rider) => {
        await W.restaurantStatus(id, 'confirmed');
        await W.waitOffer(id, rider);
        const avail = await W.rider(rider, 'GET', '/orders/available');
        assert.equal(avail.status, 200, JSON.stringify(avail.body));
        assert.ok(avail.body.data.data.some((o) => (o._id || o.id) === id), 'the offer is in the rider\'s available list');
        const acc = await W.rider(rider, 'PATCH', `/orders/${id}/accept`);
        assert.equal(acc.status, 200, `accept: ${JSON.stringify(acc.body)}`);
        await W.restaurantStatus(id, 'preparing');
        await W.restaurantStatus(id, 'ready_for_pickup');
    };

    /** Rider trip: reached pickup, picked up, reached drop, OTP from the customer, delivered. */
    W.deliver = async (id, rider, user, { collect = 'cash' } = {}) => {
        let r = await W.rider(rider, 'PATCH', `/orders/${id}/reached-pickup`);
        assert.equal(r.status, 200, `reached-pickup: ${JSON.stringify(r.body)}`);
        r = await W.rider(rider, 'PATCH', `/orders/${id}/confirm-pickup`, {});
        assert.equal(r.status, 200, `confirm-pickup: ${JSON.stringify(r.body)}`);
        r = await W.rider(rider, 'PATCH', `/orders/${id}/reached-drop`);
        assert.equal(r.status, 200, `reached-drop: ${JSON.stringify(r.body)}`);
        const otpRes = await http.get(`/api/v1/food/orders/${id}/drop-otp`, { token: user.token });
        assert.equal(otpRes.status, 200, JSON.stringify(otpRes.body));
        const otp = otpRes.body.data.otp;
        assert.match(String(otp), /^\d{4}$/);
        const bad = await W.rider(rider, 'POST', `/orders/${id}/verify-drop-otp`, { otp: otp === '0000' ? '1111' : '0000' });
        assert.equal(bad.status, 400, 'a wrong OTP is refused');
        r = await W.rider(rider, 'POST', `/orders/${id}/verify-drop-otp`, { otp });
        assert.equal(r.status, 200, `verify-otp: ${JSON.stringify(r.body)}`);
        if (typeof collect === 'function') await collect();
        if (collect === 'cash') {
            const cash = await W.rider(rider, 'POST', `/orders/${id}/collect/cash`);
            assert.equal(cash.status, 200, `collect/cash: ${JSON.stringify(cash.body)}`);
        }
        r = await W.rider(rider, 'PATCH', `/orders/${id}/complete`, {});
        assert.equal(r.status, 200, `complete: ${JSON.stringify(r.body)}`);
        return r.body.data.order;
    };

    /** The ledger row, the order row and the admin Transaction report row for one order. */
    W.moneyOf = async (id) => {
        const order = await prisma.foodOrder.findUnique({ where: { id } });
        const tx = await prisma.foodTransaction.findUnique({ where: { orderId: id } });
        const report = await getOrderMoneyReport({
            status: 'all', search: order.order_id,
            from: new Date(Date.now() - 86400000).toISOString().slice(0, 10),
            to: new Date(Date.now() + 86400000).toISOString().slice(0, 10),
        });
        const row = report.orders.find((o) => o.id === id) || null;
        return { order, tx, row };
    };

    /**
     * The money identity for a delivered order:
     *   total = restaurant net + admin net + rider (incl. tip) + item tax
     *   restaurant net = food + packaging − commission − restaurant-funded discount
     *   rider = the distance band's pay + tip
     */
    W.assertDeliveredMoney = async (id, { riderPay = 20, tip = 0, commissionPct = 15, restaurantDiscount = 0, rider = null, cashCollected = null } = {}) => {
        const { order, tx, row } = await W.moneyOf(id);
        assert.equal(order.orderStatus, 'delivered');
        assert.ok(tx, 'a ledger row exists');
        const subtotal = money(order.subtotal);
        const commission = money(subtotal * commissionPct / 100);
        assert.equal(money(tx.commissionAmount), commission, 'commission is the % of the item total');
        assert.equal(money(tx.restaurantDiscountShare), money(restaurantDiscount), 'restaurant-funded discount');
        assert.equal(money(tx.restaurantShare), money(subtotal + Number(order.packagingFee) - commission - restaurantDiscount),
            'restaurant net = food + packaging - commission - its discount');
        assert.equal(money(order.riderEarning), money(riderPay + tip), 'rider earning = band pay + tip');
        assert.equal(money(tx.riderShare), money(riderPay + tip));
        assert.equal(
            money(Number(tx.restaurantShare) + Number(tx.platformNetProfit) + Number(tx.riderShare) + Number(order.tax)),
            money(order.total),
            'order total = restaurant net + admin net + rider + tax',
        );
        assert.ok(row, 'the order is on the admin Transaction report');
        assert.equal(row.earned, true);
        assert.equal(row.orderAmount, money(order.total));
        assert.equal(row.storeNetIncome, money(tx.restaurantShare));
        assert.equal(row.adminNetIncome, money(tx.platformNetProfit));
        assert.equal(row.deliverymanEarning, money(riderPay + tip));
        assert.equal(row.riderTip, money(tip));
        assert.equal(money(row.storeNetIncome + row.adminNetIncome + row.deliverymanEarning + row.vatTax), row.orderAmount);
        if (rider && cashCollected !== null) {
            const cash = (await getCashInHandMap([rider.id])).get(rider.id);
            assert.equal(money(cash), money(cashCollected), 'rider cash in hand');
        }
        return { order, tx, row };
    };

    /** A cancelled order earns nobody anything and is not on the earned report. */
    W.assertCancelledMoney = async (id, rider = null) => {
        const { order, row } = await W.moneyOf(id);
        assert.match(order.orderStatus, /^cancelled_by_/);
        if (row) {
            assert.equal(row.earned, false);
            assert.equal(row.storeNetIncome, null);
            assert.equal(row.deliverymanEarning, null);
        }
        if (rider) {
            const delivered = await prisma.foodOrder.aggregate({
                where: { dispatchDeliveryPartnerId: rider.id, orderStatus: 'delivered', id },
                _sum: { riderEarning: true },
            });
            assert.equal(money(delivered._sum.riderEarning), 0, 'the rider earns nothing on a cancelled order');
        }
        return order;
    };

    W.inbox = (ownerType, ownerId, category) => prisma.foodNotification.findMany({
        where: { ownerType, ownerId, ...(category ? { category } : {}) },
        orderBy: { createdAt: 'asc' },
    });

    /** Inbox rows about one order (metadata.orderId or orderMongoId). */
    W.inboxFor = async (ownerType, ownerId, orderId) => (await W.inbox(ownerType, ownerId)).filter((n) => {
        const m = n.metadata || {};
        return [m.orderId, m.orderMongoId, m.orderRowId].map(String).includes(String(orderId));
    });

    W.makeCoupon = async (data) => {
        const offer = await prisma.foodOffer.create({
            data: {
                couponCode: uniqueTag('CPN').toUpperCase(), title: 'E2E coupon', discountType: 'percentage', discountValue: 10,
                startDate: new Date(Date.now() - 2 * 86400000), endDate: new Date(Date.now() + 10 * 86400000),
                status: 'active', ...data,
            },
        });
        created.offers.push(offer.id);
        return offer;
    };

    W.close = async () => {
        setIOForTests(null);
        setRazorpayClientForTests(null);
        await sleep(400); // let fire-and-forget pushes and hooks settle
        await resetSettings();
        const orders = await prisma.foodOrder.findMany({ where: { restaurantId: { in: created.restaurants } }, select: { id: true } });
        const ids = orders.map((o) => o.id);
        const soft = (p) => p.catch(() => {});
        await soft(prisma.foodRefundRequest.deleteMany({ where: { orderId: { in: ids } } }));
        await soft(prisma.foodTransactionHistory.deleteMany({ where: { transaction: { orderId: { in: ids } } } }));
        await soft(prisma.foodTransaction.deleteMany({ where: { orderId: { in: ids } } }));
        await soft(prisma.transaction.deleteMany({ where: { entityId: { in: created.users } } }));
        await soft(prisma.wallet.deleteMany({ where: { entityId: { in: created.users } } }));
        await soft(prisma.foodNotification.deleteMany({ where: { ownerId: { in: [...created.users, ...created.restaurants, ...created.partners] } } }));
        await soft(prisma.foodOfferUsage.deleteMany({ where: { offerId: { in: created.offers } } }));
        await soft(prisma.foodOrder.deleteMany({ where: { id: { in: ids } } }));
        await soft(prisma.foodOffer.deleteMany({ where: { id: { in: created.offers } } }));
        await soft(prisma.foodDeliveryPartnerSession.deleteMany({ where: { deliveryPartnerId: { in: created.partners } } }));
        await soft(prisma.foodDeliveryPartner.deleteMany({ where: { id: { in: created.partners } } }));
        await soft(prisma.foodFeeSettings.deleteMany({ where: { id: { in: created.fees } } }));
        await soft(prisma.foodItem.deleteMany({ where: { id: { in: created.foods } } }));
        await soft(prisma.foodCategory.deleteMany({ where: { id: { in: created.categories } } }));
        await soft(prisma.foodUser.deleteMany({ where: { id: { in: created.users } } }));
        await soft(prisma.foodRestaurant.deleteMany({ where: { id: { in: created.restaurants } } }));
        await soft(prisma.foodZone.deleteMany({ where: { id: { in: created.zones } } }));
        await soft(prisma.foodAdmin.deleteMany({ where: { id: { in: created.admins } } }));
        await http.close();
        await prisma.$disconnect();
    };

    return W;
}

export { prisma, rooms, uniqueTag, uniquePhone };
