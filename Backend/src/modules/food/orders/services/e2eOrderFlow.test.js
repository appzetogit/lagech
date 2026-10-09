import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * The complete order flow, end to end over HTTP, the way the three apps drive
 * it (USER_APP_API.md, RESTAURANT_API_SPEC.md, DELIVERY_API_SPEC.md):
 *
 *   customer: restaurants for a location -> menu -> /orders/calculate -> POST /orders
 *   restaurant: list + new_order socket -> confirmed -> preparing -> ready_for_pickup
 *   dispatch: the order is offered to an online rider in range
 *   rider: accept -> reached pickup -> picked up -> reached drop -> customer OTP -> collect -> complete
 *   customer: sees every status (GET /orders/:id + socket), invoice, ratings
 *
 * and after each completed scenario the money: total = restaurant net + admin
 * net + rider (incl. tip) + tax, the ledger, the admin Transaction report, the
 * rider's cash in hand, wallets, and who was notified.
 *
 * Happy paths here; cancellations, refunds, expiry and admin assignment are in
 * e2eOrderCancel.test.js. Razorpay is a fake (e2eHarness.js).
 */
process.env.RAZORPAY_KEY_ID = 'rzp_test_fake_e2e_flow';
process.env.RAZORPAY_KEY_SECRET = 'fake-secret-e2e-flow';

const { createWorld, prisma, money, waitFor, sleep } = await import('./e2eHarness.js');
const { releaseScheduledOrders } = await import('./order-scheduling.service.js');
const { getCashInHandMap } = await import('../../delivery/services/riderCash.service.js');

let W;

test.before(async () => {
    W = await createWorld({ patch: 13, prefix: 'E2EF' });
});

test.after(async () => {
    if (W) await W.close();
});

const statusesTo = (room, orderId) => W.events({ room, event: 'order_status_update', orderId }).map((e) => e.payload.orderStatus);

// ─── 1. Cash on delivery, the whole way ─────────────────────────────────────

test('COD: browse, quote, place, restaurant accepts, rider delivers with OTP, money adds up', async () => {
    const user = await W.makeUser();
    const rider = await W.makeRider();

    // Restaurants for the customer's location, then the menu.
    const list = await W.http.get(`/api/v1/food/restaurant/restaurants?lat=${W.HERE.lat + 0.02}&lng=${W.HERE.lng}&search=${W.tag}`);
    assert.equal(list.status, 200, JSON.stringify(list.body));
    const restaurants = list.body.data.restaurants || list.body.data;
    assert.ok(restaurants.some((r) => (r._id || r.id) === W.restaurant.id), 'the restaurant is listed for the location');
    const menu = await W.http.get(`/api/v1/food/restaurant/restaurants/${W.restaurant.id}/menu`);
    assert.equal(menu.status, 200);
    assert.ok(JSON.stringify(menu.body).includes(W.thali.id), 'the dish is on the menu');

    const placed = await W.place(user, { paymentMethod: 'cash' });
    const id = placed.id;
    // 2 x 200 + 60 = 460; 5% GST = 23; 2.2 km = band 1: fee 30 + 18% GST 5.4.
    assert.equal(placed.quote.pricing.subtotal, 460);
    assert.equal(placed.quote.pricing.tax, 23);
    assert.equal(placed.quote.pricing.deliveryFee, 30);
    assert.equal(placed.quote.pricing.deliveryFeeGst, 5.4);
    assert.equal(placed.quote.pricing.total, 518.4);
    assert.equal(placed.order.orderStatus, 'created');
    assert.equal(Number(placed.order.pricing.total), 518.4, 'charged what was quoted');

    // The restaurant: new_order socket once, the order in its list with its own earning.
    assert.equal(W.events({ room: W.rooms.restaurant(W.restaurant.id), event: 'new_order', orderId: id }).length, 1, 'new_order once');
    const listed = (await W.restaurantList()).find((o) => (o._id || o.id) === id);
    assert.ok(listed, 'in the restaurant list');
    assert.equal(listed.finance.netPayout, 391, 'restaurant earns 460 - 15% commission');
    assert.equal(listed.finance.commission, 69);

    await W.acceptAndAssign(id, rider);
    let seen = await W.userOrder(user, id);
    assert.equal(seen.orderStatus, 'ready_for_pickup');
    assert.equal(String(seen.dispatch?.deliveryPartnerId?._id || seen.dispatch?.deliveryPartnerId?.id || seen.dispatch?.deliveryPartnerId), rider.id);

    // The rider sees what to collect.
    const riderView = await W.rider(rider, 'GET', `/orders/${id}`);
    assert.equal(riderView.status, 200);
    assert.equal(riderView.body.data.order.amountToCollect, 518.4);
    assert.equal(riderView.body.data.order.riderEarning, 20);
    assert.equal(riderView.body.data.order.deliveryOtp, undefined, 'the drop OTP is never shown to the rider');

    // The rider's current trip includes the order at every stage of the trip.
    const before = await W.rider(rider, 'GET', '/orders/current');
    assert.equal((before.body.data.activeOrder?._id || before.body.data.activeOrder?.id), id);

    await W.deliver(id, rider, user, {
        collect: async () => {
            const cur = await W.rider(rider, 'GET', '/orders/current');
            assert.equal(cur.status, 200);
            assert.equal(cur.body.data.activeOrder?._id || cur.body.data.activeOrder?.id, id,
                'at the drop the order is still the rider\'s current trip');
            const cash = await W.rider(rider, 'POST', `/orders/${id}/collect/cash`);
            assert.equal(cash.status, 200, JSON.stringify(cash.body));
        },
    });

    seen = await W.userOrder(user, id);
    assert.equal(seen.orderStatus, 'delivered');
    assert.equal(seen.payment.status, 'paid', 'COD is paid once collected');

    await W.assertDeliveredMoney(id, { riderPay: 20, rider, cashCollected: 518.4 });

    // The customer saw each stage over the socket; delivered exactly once.
    const toUser = statusesTo(W.rooms.user(user.id), id);
    for (const s of ['confirmed', 'preparing', 'picked_up', 'delivered']) assert.ok(toUser.includes(s), `user told ${s}: ${toUser}`);
    assert.equal(toUser.filter((s) => s === 'delivered').length, 1, 'delivered is announced once');

    // Notifications: the customer's "placed" once; the restaurant's new-order alert once.
    assert.equal((await W.inboxFor('USER', user.id, id)).filter((n) => n.category === 'order_created').length, 1);
    assert.equal((await W.inboxFor('RESTAURANT', W.restaurant.id, id)).filter((n) => n.category === 'new_order').length, 1,
        'one new-order row in the restaurant\'s notification history, not one per push leg');
    assert.ok((await W.inboxFor('USER', user.id, id)).some((n) => /delivered/i.test(n.title)), 'the customer is told it was delivered');
    assert.ok((await W.inboxFor('DELIVERY_PARTNER', rider.id, id)).length > 0, 'the rider has the order in their history');

    // Invoices: the customer's, the restaurant's and the admin's carry the same numbers.
    const inv = await W.http.get(`/api/v1/food/user/orders/${id}/invoice`, { token: user.token });
    assert.equal(inv.status, 200, JSON.stringify(inv.body));
    const lines = inv.body.data.invoice.lines.filter((l) => l.inTotal);
    assert.equal(money(lines.reduce((s, l) => s + Number(l.amount), 0)), 518.4);
    assert.equal(inv.body.data.invoice.total, 518.4);
    const rInv = await W.http.get(`/api/v1/food/restaurant/orders/${id}/invoice`, { token: W.tokens.restaurant });
    assert.equal(rInv.status, 200);
    assert.equal(rInv.body.data.invoice.total, 518.4);
    assert.equal(rInv.body.data.invoice.restaurantEarning.netPayout, 391);
    const aInv = await W.admin('GET', `/orders/${id}/invoice`);
    assert.equal(aInv.status, 200);
    assert.equal(aInv.body.data.invoice.total, 518.4);
    const html = await W.http.request('GET', `/api/v1/food/user/orders/${id}/invoice?format=html`, { token: user.token });
    assert.equal(html.status, 200);

    // Ratings after delivery: the rider rating is required, once only.
    const noRider = await W.http.request('PATCH', `/api/v1/food/orders/${id}/ratings`, { token: user.token, body: { restaurantRating: 5 } });
    assert.equal(noRider.status, 400);
    const rated = await W.http.request('PATCH', `/api/v1/food/orders/${id}/ratings`, {
        token: user.token,
        body: { restaurantRating: 5, restaurantComment: 'Great', deliveryPartnerRating: 4, itemRatings: [{ itemId: W.thali.id, rating: 5 }] },
    });
    assert.equal(rated.status, 200, JSON.stringify(rated.body));
    const again = await W.http.request('PATCH', `/api/v1/food/orders/${id}/ratings`, {
        token: user.token, body: { restaurantRating: 5, deliveryPartnerRating: 4 },
    });
    assert.equal(again.status, 400);
    const rc = await W.rider(rider, 'PATCH', `/orders/${id}/rate-customer`, { rating: 5 });
    assert.equal(rc.status, 200, JSON.stringify(rc.body));
    assert.equal(Number((await prisma.foodDeliveryPartner.findUnique({ where: { id: rider.id } })).totalDeliveries), 1);
});

// ─── 2. Online (Razorpay) with a tip ────────────────────────────────────────

test('online Razorpay + tip: hidden until paid, verified, delivered, tip all the rider\'s', async () => {
    await W.set('business_deliveryman', { tipsEnabled: true });
    try {
        const user = await W.makeUser();
        const rider = await W.makeRider();
        const placed = await W.place(user, { paymentMethod: 'razorpay', calc: { riderTip: 25 } });
        const id = placed.id;
        assert.equal(placed.order.orderStatus, 'pending_payment');
        assert.equal(placed.quote.pricing.riderTip, 25);
        assert.equal(placed.razorpay.amount, Math.round((518.4 + 25) * 100), 'the gateway is asked for the total incl. tip');
        assert.ok(!(await W.restaurantList()).some((o) => (o._id || o.id) === id), 'unpaid orders never reach the restaurant');
        assert.equal(W.events({ room: W.rooms.restaurant(W.restaurant.id), event: 'new_order', orderId: id }).length, 0);

        const paid = await W.payOnline(user, placed);
        assert.equal(paid.order.orderStatus, 'created');
        assert.equal(paid.order.payment.status, 'paid');
        await waitFor(() => W.events({ room: W.rooms.restaurant(W.restaurant.id), event: 'new_order', orderId: id }).length, 'new_order after payment');
        // A second verify (app retry) or the webhook changes nothing.
        const again = await W.http.post('/api/v1/food/orders/verify-payment', { token: user.token, body: { orderId: id, ...paid, order: undefined } });
        assert.equal(again.status, 200);
        assert.equal(W.events({ room: W.rooms.restaurant(W.restaurant.id), event: 'new_order', orderId: id }).length, 1, 'new_order once');
        assert.equal((await prisma.foodTransaction.count({ where: { orderId: id } })), 1, 'one ledger row');

        await W.acceptAndAssign(id, rider);
        const riderView = await W.rider(rider, 'GET', `/orders/${id}`);
        assert.equal(riderView.body.data.order.amountToCollect, 0, 'nothing to collect on a prepaid order');
        assert.equal(riderView.body.data.order.riderTip, 25);
        await W.deliver(id, rider, user, { collect: 'none' });
        await W.assertDeliveredMoney(id, { riderPay: 20, tip: 25, rider, cashCollected: 0 });
        // The customer is told the order was placed once the payment went through, once.
        await waitFor(async () => (await W.inboxFor('USER', user.id, id)).some((n) => n.category === 'order_created'), 'placed push');
        assert.equal((await W.inboxFor('USER', user.id, id)).filter((n) => n.category === 'order_created').length, 1);
    } finally {
        await W.set('business_deliveryman', {});
    }
});

// ─── 3. Wallet ──────────────────────────────────────────────────────────────

test('wallet: paid from the wallet at once, nothing collected, balance down by the total', async () => {
    const user = await W.makeUser(1000);
    const rider = await W.makeRider();
    const placed = await W.place(user, { paymentMethod: 'wallet' });
    assert.equal(placed.order.payment.status, 'paid');
    assert.equal(await W.balance(user.id), money(1000 - 518.4));
    const wallet = await W.http.get('/api/v1/food/user/wallet', { token: user.token });
    assert.equal(wallet.status, 200);
    assert.equal(money(wallet.body.data.wallet.balance), money(1000 - 518.4));

    await W.acceptAndAssign(placed.id, rider);
    await W.deliver(placed.id, rider, user, { collect: 'none' });
    const { row } = await W.assertDeliveredMoney(placed.id, { riderPay: 20, rider, cashCollected: 0 });
    assert.equal(row.walletPaidAmount, 518.4);
    assert.equal(row.amountReceivedBy, 'Admin');
});

// ─── 4. Partial: wallet + cash ──────────────────────────────────────────────

test('partial payment: wallet part taken at placement, rider collects only the rest', async () => {
    const user = await W.makeUser(100);
    const rider = await W.makeRider();
    const placed = await W.place(user, { paymentMethod: 'cash', body: { useWallet: true, walletAmount: 100 } });
    assert.equal(placed.order.payment.isPartial, true);
    assert.equal(placed.order.payment.walletAmount, 100);
    assert.equal(money(placed.order.payment.amountDue), money(518.4 - 100));
    assert.equal(await W.balance(user.id), 0);

    await W.acceptAndAssign(placed.id, rider);
    const riderView = await W.rider(rider, 'GET', `/orders/${placed.id}`);
    assert.equal(riderView.body.data.order.amountToCollect, money(518.4 - 100));
    await W.deliver(placed.id, rider, user);
    const { row } = await W.assertDeliveredMoney(placed.id, { riderPay: 20, rider, cashCollected: money(518.4 - 100) });
    assert.equal(row.walletPaidAmount, 100);
    assert.equal(row.partialPayment, true);
});

// ─── 5. Coupons ─────────────────────────────────────────────────────────────

test('coupons: each type priced at /calculate; a split coupon delivered and settled', async () => {
    const user = await W.makeUser();
    const quote = async (code, u = user) => {
        const res = await W.http.post('/api/v1/food/orders/calculate', {
            token: u.token, body: W.cart({ deliveryAddress: W.address(), couponCode: code }),
        });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        return res.body.data.pricing;
    };

    const plain = await W.makeCoupon({ couponType: 'default', discountType: 'percentage', discountValue: 10, adminBearPercentage: 50, restaurantBearPercentage: 50 });
    let p = await quote(plain.couponCode);
    assert.equal(p.discount, 46, '10% of 460');
    assert.equal(p.appliedCoupon.couponType, 'default');

    const store = await W.makeCoupon({ couponType: 'store_wise', restaurantScope: 'selected', restaurantIds: [W.restaurant.id], discountType: 'flat_price', discountValue: 50 });
    p = await quote(store.couponCode);
    assert.equal(p.discount, 50);
    const otherStore = await W.makeCoupon({ couponType: 'store_wise', restaurantScope: 'selected', restaurantIds: ['a'.repeat(24)], discountType: 'flat_price', discountValue: 50 });
    p = await quote(otherStore.couponCode);
    assert.equal(p.discount, 0);
    assert.equal(p.couponErrorReason, 'wrong_restaurant');

    const zone = await W.makeCoupon({ couponType: 'zone_wise', zoneIds: [W.zone.id], discountType: 'flat_price', discountValue: 40 });
    p = await quote(zone.couponCode);
    assert.equal(p.discount, 40);
    const otherZone = await W.makeCoupon({ couponType: 'zone_wise', zoneIds: ['b'.repeat(24)], discountType: 'flat_price', discountValue: 40 });
    p = await quote(otherZone.couponCode);
    assert.equal(p.couponErrorReason, 'wrong_zone');

    const free = await W.makeCoupon({ couponType: 'free_delivery', discountType: 'flat_price', discountValue: 0 });
    p = await quote(free.couponCode);
    assert.equal(p.deliveryFee, 0);
    assert.equal(p.deliveryFeeWaived, 35.4, 'fee 30 + its GST 5.4');
    assert.equal(p.total, 483);

    const first = await W.makeCoupon({ couponType: 'first_order', isFirstOrderOnly: true, discountType: 'flat_price', discountValue: 30 });
    p = await quote(first.couponCode);
    assert.equal(p.discount, 30, 'a new customer gets the first-order coupon');

    // The 10% coupon, half funded by the restaurant, all the way to settlement.
    const rider = await W.makeRider();
    const placed = await W.place(user, { paymentMethod: 'cash', calc: { couponCode: plain.couponCode } });
    assert.equal(Number(placed.order.pricing.discount), 46);
    await W.acceptAndAssign(placed.id, rider);
    await W.deliver(placed.id, rider, user);
    const total = money(460 - 46 + Math.round(414 * 0.05) + 35.4);
    assert.equal(money((await prisma.foodOrder.findUnique({ where: { id: placed.id } })).total), total);
    await W.assertDeliveredMoney(placed.id, { riderPay: 20, restaurantDiscount: 23, rider, cashCollected: total });

    // Now the customer has an order: the first-order coupon no longer applies.
    p = await quote(first.couponCode);
    assert.equal(p.couponErrorReason, 'not_first_order');

    // A free-delivery coupon order: the platform absorbs the fee, the rider is still paid.
    const rider2 = await W.makeRider();
    const freeOrder = await W.place(user, { paymentMethod: 'cash', calc: { couponCode: free.couponCode } });
    assert.equal(Number(freeOrder.order.pricing.deliveryFee), 0);
    await W.acceptAndAssign(freeOrder.id, rider2);
    await W.deliver(freeOrder.id, rider2, user);
    const { tx } = await W.assertDeliveredMoney(freeOrder.id, { riderPay: 20, rider: rider2, cashCollected: 483 });
    assert.equal(money(tx.platformNetProfit), money(69 - 20), 'admin keeps the commission less the rider pay');
});

// ─── 6. Free delivery over ──────────────────────────────────────────────────

test('free delivery over an item total: fee waived, rider still paid by the band', async () => {
    await W.set('business_order', { freeDelivery: { enabled: true, minSubtotal: 300 } });
    try {
        const user = await W.makeUser();
        const rider = await W.makeRider();
        const placed = await W.place(user, { paymentMethod: 'cash' });
        assert.equal(placed.quote.pricing.deliveryFee, 0);
        assert.equal(placed.quote.pricing.freeDeliveryWaived, 35.4);
        assert.equal(placed.quote.pricing.total, 483);
        await W.acceptAndAssign(placed.id, rider);
        await W.deliver(placed.id, rider, user);
        await W.assertDeliveredMoney(placed.id, { riderPay: 20, rider, cashCollected: 483 });

        // Below the threshold the fee is charged.
        const small = await W.http.post('/api/v1/food/orders/calculate', {
            token: user.token, body: W.cart({ deliveryAddress: W.address(), items: [W.line(W.lassi, 1)] }),
        });
        assert.equal(small.body.data.pricing.deliveryFee, 30);
    } finally {
        await W.set('business_order', {});
    }
});

// ─── 7. Takeaway ────────────────────────────────────────────────────────────

test('takeaway: pickup code, no rider, handed over at the counter', async () => {
    await W.set('business_order', { takeaway: true });
    try {
        const user = await W.makeUser(1000);
        const placed = await W.place(user, { paymentMethod: 'wallet', calc: { orderType: 'takeaway' }, body: { address: null } });
        const id = placed.id;
        assert.equal(placed.order.orderType, 'takeaway');
        assert.match(String(placed.order.pickupCode), /^\d{4}$/);
        assert.equal(Number(placed.order.pricing.deliveryFee), 0);
        assert.equal(Number(placed.order.pricing.total), 483, '460 + 23 GST, no delivery');
        // Cash is refused for a takeaway.
        const cash = await W.place(user, { paymentMethod: 'cash', calc: { orderType: 'takeaway' }, body: { address: null }, expectStatus: 400 });
        assert.match(cash.res.body.message, /Takeaway/i);

        await W.restaurantStatus(id, 'confirmed');
        await W.restaurantStatus(id, 'ready_for_pickup');
        await sleep(300);
        assert.equal(await prisma.orderDispatchOffer.count({ where: { orderId: id } }), 0, 'no rider is looked for');
        const restaurantCopy = (await W.restaurantList()).find((o) => (o._id || o.id) === id);
        assert.equal(restaurantCopy.pickupCode, undefined, 'the code is never sent to the restaurant');
        assert.equal(restaurantCopy.deliveryOtp, undefined);

        const wrong = await W.http.post(`/api/v1/food/restaurant/orders/${id}/handover`, { token: W.tokens.restaurant, body: { code: '0000' === placed.order.pickupCode ? '1111' : '0000' } });
        assert.equal(wrong.status, 400);
        const ok = await W.http.post(`/api/v1/food/restaurant/orders/${id}/handover`, { token: W.tokens.restaurant, body: { code: placed.order.pickupCode } });
        assert.equal(ok.status, 200, JSON.stringify(ok.body));
        assert.equal((await W.userOrder(user, id)).orderStatus, 'delivered');
        await W.assertDeliveredMoney(id, { riderPay: 0 });
    } finally {
        await W.set('business_order', {});
    }
});

// ─── 8. Scheduled ───────────────────────────────────────────────────────────

test('scheduled: placed now, silent until release, then rings the restaurant and is dispatched', async () => {
    await W.set('business_order', { scheduledOrder: true });
    try {
        const user = await W.makeUser();
        const rider = await W.makeRider();
        const opts = await W.http.get(`/api/v1/food/public/restaurants/${W.restaurant.id}/order-options`);
        assert.equal(opts.status, 200);
        const slot = opts.body.data.schedule.days.flatMap((d) => d.slots)[0];
        assert.ok(slot, 'a slot is offered');

        const placed = await W.place(user, { paymentMethod: 'cash', calc: { scheduledAt: slot.scheduledAt } });
        const id = placed.id;
        const row = await prisma.foodOrder.findUnique({ where: { id } });
        assert.ok(row.releaseAt && row.releaseAt > new Date(), 'released later');
        assert.equal(W.events({ room: W.rooms.restaurant(W.restaurant.id), event: 'new_order', orderId: id }).length, 0, 'does not ring yet');
        assert.ok(row.acceptanceDeadlineAt > row.releaseAt, 'the acceptance timer starts at release');

        // Time passes to the release time (as the scheduler's clock would).
        await prisma.$executeRaw`UPDATE food_orders SET "releaseAt" = now() - interval '1 minute', "updatedAt" = now() - interval '2 minutes' WHERE id = ${id}`;
        const released = await releaseScheduledOrders(new Date());
        assert.ok(released.alerted >= 1);
        await waitFor(() => W.events({ room: W.rooms.restaurant(W.restaurant.id), event: 'new_order', orderId: id }).length, 'release alert');

        await W.acceptAndAssign(id, rider);
        await W.deliver(id, rider, user);
        await W.assertDeliveredMoney(id, { riderPay: 20, rider, cashCollected: 518.4 });
    } finally {
        await W.set('business_order', {});
    }
});

// ─── 9. A rider holding two deliveries ──────────────────────────────────────

test('rider limit 2: holds two orders, the third is refused until one is delivered', async () => {
    await W.set('business_deliveryman', { maxAssignedOrders: 2 });
    try {
        const user = await W.makeUser();
        const rider = await W.makeRider();
        const a = await W.place(user, { paymentMethod: 'cash' });
        const b = await W.place(user, { paymentMethod: 'cash' });
        const c = await W.place(user, { paymentMethod: 'cash' });
        await W.acceptAndAssign(a.id, rider);
        await W.acceptAndAssign(b.id, rider);

        const current = await W.rider(rider, 'GET', '/orders/current');
        assert.equal(current.body.data.activeOrders.length, 2);
        assert.equal(current.body.data.canAcceptMore, false);

        await W.restaurantStatus(c.id, 'confirmed');
        await sleep(500);
        const avail = await W.rider(rider, 'GET', '/orders/available');
        assert.ok(!avail.body.data.data.some((o) => (o._id || o.id) === c.id), 'no new offers at the limit');
        const refused = await W.rider(rider, 'PATCH', `/orders/${c.id}/accept`);
        assert.equal(refused.status, 400);
        assert.match(refused.body.message, /2 active deliveries/);

        await W.deliver(a.id, rider, user);
        const ok = await W.rider(rider, 'PATCH', `/orders/${c.id}/accept`);
        assert.equal(ok.status, 200, JSON.stringify(ok.body));
        await W.restaurantStatus(c.id, 'ready_for_pickup');
        await W.deliver(b.id, rider, user);
        await W.deliver(c.id, rider, user);
        for (const o of [a, b, c]) await W.assertDeliveredMoney(o.id, { riderPay: 20 });
        assert.equal(money((await getCashInHandMap([rider.id])).get(rider.id)), money(3 * 518.4));
    } finally {
        await W.set('business_deliveryman', {});
    }
});

// ─── 10. Door QR ────────────────────────────────────────────────────────────

test('COD collected by Razorpay QR at the door: paid to the platform, not cash in hand', async () => {
    const user = await W.makeUser();
    const rider = await W.makeRider();
    const placed = await W.place(user, { paymentMethod: 'cash' });
    const id = placed.id;
    await W.acceptAndAssign(id, rider);
    await W.deliver(id, rider, user, {
        collect: async () => {
            const qr = await W.rider(rider, 'POST', `/orders/${id}/collect/qr`, {});
            assert.equal(qr.status, 200, JSON.stringify(qr.body));
            assert.equal(qr.body.data.kind, 'qr');
            assert.equal(qr.body.data.amount, 518.4);
            W.fake.payQr(qr.body.data.qrId);
            const status = await W.rider(rider, 'GET', `/orders/${id}/payment-status`);
            assert.equal(status.status, 200);
            assert.equal(status.body.data.paid, true, JSON.stringify(status.body.data));
            const cash = await W.rider(rider, 'POST', `/orders/${id}/collect/cash`);
            assert.equal(cash.status, 400, 'no cash after the QR is paid');
        },
    });
    let row;
    row = await prisma.foodOrder.findUnique({ where: { id } });
    assert.equal(row.paymentMethod, 'razorpay_qr');
    assert.equal(row.paymentStatus, 'paid');
    const { row: rep } = await W.assertDeliveredMoney(id, { riderPay: 20, rider, cashCollected: 0 });
    assert.equal(rep.amountReceivedBy, 'Admin');
    assert.ok(W.events({ room: W.rooms.user(user.id), event: 'payment_received', orderId: id }).length >= 1);
});

// ─── 11. The address shape USER_APP_API.md documents ────────────────────────

test('an address sent as location { lat, lng } (as documented) keeps its coordinates: banded fee and rider pay', async () => {
    const user = await W.makeUser();
    const address = W.address({ location: { lat: W.HERE.lat + 0.02, lng: W.HERE.lng } });
    const placed = await W.place(user, { paymentMethod: 'cash', body: { address } });
    const row = await prisma.foodOrder.findUnique({ where: { id: placed.id } });
    assert.ok(Number(row.addrLat) > 0, 'the drop point is stored');
    assert.equal(Number(row.deliveryFee), 30);
    assert.equal(Number(row.riderEarning), 20, 'the rider is paid by the band, not 0');
    assert.equal(money(row.total), 518.4);
});
