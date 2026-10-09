import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * The unhappy paths of the order flow, end to end over HTTP (see
 * e2eOrderFlow.test.js for the happy ones):
 *
 *   - cancellations at each stage by the customer, the restaurant and the
 *     admin, with the right refund: online -> a Razorpay refund (fake client),
 *     wallet -> back to the wallet, cash -> nothing owed; the rider and the
 *     restaurant are not paid for a cancelled order;
 *   - the restaurant rejecting a new order, and not answering in time;
 *   - no rider found: the stalled-order expiry;
 *   - a refund request after delivery, approved by the admin;
 *   - the admin assigning and reassigning a rider by hand.
 */
process.env.RAZORPAY_KEY_ID = 'rzp_test_fake_e2e_cancel';
process.env.RAZORPAY_KEY_SECRET = 'fake-secret-e2e-cancel';

const { createWorld, prisma, money, waitFor, sleep } = await import('./e2eHarness.js');
const { expireStalledOrders } = await import('./order-expiry.service.js');
const { countPartnerActiveDeliveries } = await import('./order.helpers.js');
const { getCashInHandMap } = await import('../../delivery/services/riderCash.service.js');

let W;

test.before(async () => {
    W = await createWorld({ patch: 14, prefix: 'E2EC' });
});

test.after(async () => {
    if (W) await W.close();
});

const refundsFor = (paymentId) => W.fake.refunds.filter((r) => r.paymentId === paymentId);
const rowOf = (id) => prisma.foodOrder.findUnique({ where: { id } });

/** A paid online order, as the customer leaves checkout. */
async function paidOnline(user) {
    const placed = await W.place(user, { paymentMethod: 'razorpay' });
    const proof = await W.payOnline(user, placed);
    return { ...placed, paymentId: proof.razorpayPaymentId };
}

// ─── Customer ───────────────────────────────────────────────────────────────

test('customer cancels a new order: COD owes nothing, online is refunded, wallet goes back', async () => {
    const user = await W.makeUser(1000);

    const cod = await W.place(user, { paymentMethod: 'cash' });
    let res = await W.http.request('PATCH', `/api/v1/food/orders/${cod.id}/cancel`, { token: user.token, body: { reason: 'Changed my mind' } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    let row = await rowOf(cod.id);
    assert.equal(row.orderStatus, 'cancelled_by_user');
    assert.equal(Number(row.refundAmount), 0);
    assert.equal(row.refundStatus, 'none');
    // The restaurant is told, over the socket and in its notifications.
    assert.ok(W.events({ room: W.rooms.restaurant(W.restaurant.id), event: 'order_status_update', orderId: cod.id })
        .some((e) => e.payload.orderStatus === 'cancelled_by_user'));
    assert.ok((await W.inboxFor('RESTAURANT', W.restaurant.id, cod.id)).some((n) => n.category === 'order_cancelled'));
    await W.assertCancelledMoney(cod.id);
    // A second cancel does nothing.
    res = await W.http.request('PATCH', `/api/v1/food/orders/${cod.id}/cancel`, { token: user.token, body: {} });
    assert.equal(res.status, 400);

    const online = await paidOnline(user);
    res = await W.http.request('PATCH', `/api/v1/food/orders/${online.id}/cancel`, { token: user.token, body: { reason: 'Late' } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    row = await rowOf(online.id);
    assert.equal(row.paymentStatus, 'refunded');
    assert.equal(row.refundStatus, 'processed');
    assert.deepEqual(refundsFor(online.paymentId).map((r) => r.amount), [51840], 'the whole amount, once, to the original payment');
    const tx = await prisma.foodTransaction.findUnique({ where: { orderId: online.id } });
    assert.equal(tx.status, 'refunded');

    const before = await W.balance(user.id);
    const wallet = await W.place(user, { paymentMethod: 'wallet' });
    assert.equal(await W.balance(user.id), money(before - 518.4));
    res = await W.http.request('PATCH', `/api/v1/food/orders/${wallet.id}/cancel`, { token: user.token, body: {} });
    assert.equal(res.status, 200);
    assert.equal(await W.balance(user.id), before, 'the wallet is made whole');
    row = await rowOf(wallet.id);
    assert.equal(row.paymentStatus, 'refunded');
    const wtx = await prisma.foodTransaction.findUnique({ where: { orderId: wallet.id } });
    assert.equal(wtx.status, 'refunded', 'the ledger says refunded for a wallet refund too');
});

test('customer cancel of a wallet + cash order returns the wallet part only', async () => {
    const user = await W.makeUser(100);
    const placed = await W.place(user, { paymentMethod: 'cash', body: { useWallet: true, walletAmount: 100 } });
    assert.equal(await W.balance(user.id), 0);
    const res = await W.http.request('PATCH', `/api/v1/food/orders/${placed.id}/cancel`, { token: user.token, body: {} });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(await W.balance(user.id), 100);
    const order = await W.userOrder(user, placed.id);
    assert.equal(order.payment.refund.status, 'processed');
    assert.equal(Number(order.payment.refund.amount), 100);
});

test('customer cannot cancel once the restaurant has accepted (as in the old panel)', async () => {
    const user = await W.makeUser();
    const placed = await W.place(user, { paymentMethod: 'cash' });
    await W.restaurantStatus(placed.id, 'confirmed');
    const res = await W.http.request('PATCH', `/api/v1/food/orders/${placed.id}/cancel`, { token: user.token, body: {} });
    assert.equal(res.status, 400);
    assert.equal((await rowOf(placed.id)).orderStatus, 'confirmed');
    await W.admin('PATCH', `/orders/${placed.id}/reject`, { reason: 'test cleanup' });
});

test('a customer cancel and a restaurant reject at the same moment refund a wallet order once', async () => {
    const user = await W.makeUser(1000);
    const placed = await W.place(user, { paymentMethod: 'wallet' });
    const before = await W.balance(user.id);
    const results = await Promise.all([
        W.http.request('PATCH', `/api/v1/food/orders/${placed.id}/cancel`, { token: user.token, body: {} }),
        W.http.request('PATCH', `/api/v1/food/restaurant/orders/${placed.id}/status`, { token: W.tokens.restaurant, body: { orderStatus: 'cancelled_by_restaurant' } }),
        W.admin('PATCH', `/orders/${placed.id}/reject`, { reason: 'duplicate' }),
    ]);
    assert.equal(results.filter((r) => r.status === 200).length, 1, `exactly one cancel wins: ${results.map((r) => r.status)}`);
    await sleep(200);
    assert.equal(await W.balance(user.id), money(before + 518.4), 'refunded exactly once');
});

// ─── Restaurant ─────────────────────────────────────────────────────────────

test('restaurant rejects a new online order: refunded, customer told', async () => {
    const user = await W.makeUser();
    const online = await paidOnline(user);
    await W.restaurantStatus(online.id, 'cancelled_by_restaurant', { note: 'Shop is closed' });
    const row = await rowOf(online.id);
    assert.equal(row.orderStatus, 'cancelled_by_restaurant');
    assert.equal(row.paymentStatus, 'refunded');
    assert.deepEqual(refundsFor(online.paymentId).map((r) => r.amount), [51840]);
    assert.ok(W.events({ room: W.rooms.user(user.id), event: 'order_status_update', orderId: online.id })
        .some((e) => e.payload.orderStatus === 'cancelled_by_restaurant'));
    await waitFor(async () => (await W.inboxFor('USER', user.id, online.id)).some((n) => /cancel/i.test(n.title)), 'customer push');
    await W.assertCancelledMoney(online.id);
});

test('restaurant cancelling an accepted order: refused when off; allowed when on, wallet refunded, rider freed and told', async () => {
    const user = await W.makeUser(1000);
    const rider = await W.makeRider();
    const placed = await W.place(user, { paymentMethod: 'wallet' });
    await W.acceptAndAssign(placed.id, rider);
    await W.restaurantStatus(placed.id, 'cancelled_by_restaurant', { expect: 400 });

    await W.set('business_vendor', { restaurantCanCancelOrder: true });
    try {
        const before = await W.balance(user.id);
        await W.restaurantStatus(placed.id, 'cancelled_by_restaurant', { note: 'Out of stock' });
        assert.equal(await W.balance(user.id), money(before + 518.4));
        assert.equal(await countPartnerActiveDeliveries(rider.id), 0, 'the rider no longer holds it');
        assert.ok(W.events({ room: W.rooms.delivery(rider.id), event: 'order_status_update', orderId: placed.id })
            .some((e) => e.payload.orderStatus === 'cancelled_by_restaurant'), 'the rider is told');
        const pick = await W.rider(rider, 'PATCH', `/orders/${placed.id}/confirm-pickup`, {});
        assert.equal(pick.status, 400, 'a cancelled order cannot be picked up');
        await W.assertCancelledMoney(placed.id, rider);
    } finally {
        await W.set('business_vendor', {});
    }
});

test('not accepted in time: cancelled, online refunded, customer told', async () => {
    const user = await W.makeUser();
    const online = await paidOnline(user);
    await prisma.foodOrder.update({ where: { id: online.id }, data: { acceptanceDeadlineAt: new Date(Date.now() - 1000) } });
    await W.restaurantList(); // the list read sweeps expired orders
    const row = await rowOf(online.id);
    assert.equal(row.orderStatus, 'cancelled_by_restaurant');
    assert.equal(row.paymentStatus, 'refunded');
    assert.deepEqual(refundsFor(online.paymentId).map((r) => r.amount), [51840]);
    await waitFor(async () => (await W.inboxFor('USER', user.id, online.id)).some((n) => /cancel|not accepted/i.test(`${n.title} ${n.message}`)),
        'the customer is pushed about the auto-cancel');
    const tx = await prisma.foodTransaction.findUnique({ where: { orderId: online.id } });
    assert.equal(tx.status, 'refunded');
    // Accepting after the deadline is refused.
    await W.restaurantStatus(online.id, 'confirmed', { expect: 400 });
});

// ─── Admin ──────────────────────────────────────────────────────────────────

test('admin cancels while cooking (online): refunded; rider and restaurant earn nothing', async () => {
    const user = await W.makeUser();
    const rider = await W.makeRider();
    const online = await paidOnline(user);
    await W.acceptAndAssign(online.id, rider);
    const res = await W.admin('PATCH', `/orders/${online.id}/reject`, { reason: 'Customer called support' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const row = await rowOf(online.id);
    assert.equal(row.orderStatus, 'cancelled_by_admin');
    assert.equal(row.paymentStatus, 'refunded');
    assert.deepEqual(refundsFor(online.paymentId).map((r) => r.amount), [51840]);
    const tx = await prisma.foodTransaction.findUnique({ where: { orderId: online.id } });
    assert.equal(tx.status, 'refunded', 'the ledger records the refund');
    assert.ok(W.events({ room: W.rooms.delivery(rider.id), event: 'order_status_update', orderId: online.id }).length > 0);
    await W.assertCancelledMoney(online.id, rider);
});

test('admin cancels a COD order after pickup: nothing owed, no cash counted against the rider', async () => {
    const user = await W.makeUser();
    const rider = await W.makeRider();
    const cod = await W.place(user, { paymentMethod: 'cash' });
    await W.acceptAndAssign(cod.id, rider);
    await W.rider(rider, 'PATCH', `/orders/${cod.id}/reached-pickup`);
    await W.rider(rider, 'PATCH', `/orders/${cod.id}/confirm-pickup`, {});
    const res = await W.admin('PATCH', `/orders/${cod.id}/reject`, { reason: 'Customer unreachable' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const row = await rowOf(cod.id);
    assert.equal(row.orderStatus, 'cancelled_by_admin');
    assert.equal(Number(row.refundAmount), 0);
    assert.equal(money((await getCashInHandMap([rider.id])).get(rider.id)), 0);
    const done = await W.rider(rider, 'PATCH', `/orders/${cod.id}/complete`, {});
    assert.equal(done.status, 400, 'a cancelled order cannot be completed');
    await W.assertCancelledMoney(cod.id, rider);
});

test('no rider found: the stalled order expires, refunded, customer told', async () => {
    const user = await W.makeUser();
    const online = await paidOnline(user);
    await W.restaurantStatus(online.id, 'confirmed');
    await sleep(300);
    // Three hours pass with nobody accepting.
    await prisma.$executeRaw`UPDATE food_orders SET "createdAt" = now() - interval '3 hours', "dispatchStatus" = 'unassigned', "dispatchDeliveryPartnerId" = NULL WHERE id = ${online.id}`;
    const result = await expireStalledOrders();
    assert.ok(result.expired >= 1);
    const row = await rowOf(online.id);
    assert.equal(row.orderStatus, 'cancelled_by_admin');
    assert.equal(row.paymentStatus, 'refunded');
    assert.deepEqual(refundsFor(online.paymentId).map((r) => r.amount), [51840]);
    assert.ok((await W.inboxFor('USER', user.id, online.id)).some((n) => /cancel/i.test(n.title)));
});

// ─── Refund request after delivery ──────────────────────────────────────────

test('refund request after delivery: online goes back to the card, COD to the wallet', async () => {
    const user = await W.makeUser();
    const rider = await W.makeRider();
    const online = await paidOnline(user);
    await W.acceptAndAssign(online.id, rider);
    await W.deliver(online.id, rider, user, { collect: 'none' });

    const early = await W.http.get(`/api/v1/food/user/orders/${online.id}/refund-request`, { token: user.token });
    assert.equal(early.status, 200, JSON.stringify(early.body));
    let res = await W.http.post(`/api/v1/food/user/orders/${online.id}/refund-request`, {
        token: user.token, body: { reason: 'Food was cold', note: 'Very late' },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const requestId = res.body.data.request?.id || res.body.data.id || res.body.data.request?._id;
    assert.ok(requestId, JSON.stringify(res.body.data));
    res = await W.admin('PATCH', `/orders/refund-requests/${requestId}/approve`, { amount: 100, note: 'Partial' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(refundsFor(online.paymentId).map((r) => r.amount), [10000]);
    let row = await rowOf(online.id);
    assert.equal(row.refundStatus, 'processed');
    assert.equal(Number(row.refundAmount), 100);
    assert.ok((await W.inboxFor('USER', user.id, online.id)).some((n) => n.category === 'refund_processed'));

    const cod = await W.place(user, { paymentMethod: 'cash' });
    await W.acceptAndAssign(cod.id, rider);
    await W.deliver(cod.id, rider, user);
    res = await W.http.post(`/api/v1/food/user/orders/${cod.id}/refund-request`, { token: user.token, body: { reason: 'Missing item' } });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const codRequest = res.body.data.request?.id || res.body.data.id;
    const before = await W.balance(user.id);
    res = await W.admin('PATCH', `/orders/refund-requests/${codRequest}/approve`, {});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(await W.balance(user.id), money(before + 518.4), 'a COD refund is paid into the wallet');
    row = await rowOf(cod.id);
    assert.equal(row.paymentStatus, 'refunded');
});

// ─── Admin assigns / reassigns a rider ──────────────────────────────────────

test('admin assigns a rider by hand, then reassigns to another; only the one who delivers is paid', async () => {
    const user = await W.makeUser();
    const first = await W.makeRider({ km: 30, online: true }); // too far to be offered it
    const second = await W.makeRider({ km: 31, online: true });
    const placed = await W.place(user, { paymentMethod: 'cash' });
    const id = placed.id;

    // Not before the restaurant has the order confirmed? The admin may assign any live order.
    await W.restaurantStatus(id, 'confirmed');
    await sleep(500); // let the automatic hunt round finish first
    let res = await W.admin('PATCH', `/orders/${id}/assign-rider`, { deliveryPartnerId: first.id });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    // The rider is told and sees it.
    await waitFor(() => W.events({ room: W.rooms.delivery(first.id), orderId: id })
        .some((e) => ['new_order', 'new_order_available', 'order_assigned'].includes(e.event)), 'the assigned rider is told');
    assert.ok((await W.inboxFor('DELIVERY_PARTNER', first.id, id)).length > 0, 'and pushed');
    let avail = await W.rider(first, 'GET', '/orders/available');
    assert.ok(avail.body.data.data.some((o) => (o._id || o.id) === id));
    res = await W.rider(first, 'PATCH', `/orders/${id}/accept`);
    assert.equal(res.status, 200, JSON.stringify(res.body));

    // Reassign: take it off the first rider, give it to the second.
    res = await W.admin('PATCH', `/orders/${id}/deassign-resend`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(await countPartnerActiveDeliveries(first.id), 0);
    assert.equal(W.events({ room: W.rooms.delivery(first.id), event: 'order_deassigned', orderId: id }).length, 1, 'the first rider is told once');
    res = await W.admin('PATCH', `/orders/${id}/assign-rider`, { deliveryPartnerId: second.id });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    res = await W.rider(first, 'PATCH', `/orders/${id}/confirm-pickup`, {});
    assert.equal(res.status, 403, 'the first rider can no longer act on it');
    res = await W.rider(second, 'PATCH', `/orders/${id}/accept`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    await W.restaurantStatus(id, 'ready_for_pickup');
    await W.deliver(id, second, user);
    await W.assertDeliveredMoney(id, { riderPay: 20, rider: second, cashCollected: 518.4 });
    assert.equal(money((await getCashInHandMap([first.id])).get(first.id)), 0);

    // A finished or cancelled order cannot be handed to a rider.
    res = await W.admin('PATCH', `/orders/${id}/assign-rider`, { deliveryPartnerId: first.id });
    assert.equal(res.status, 400);
    const cancelled = await W.place(user, { paymentMethod: 'cash' });
    await W.http.request('PATCH', `/api/v1/food/orders/${cancelled.id}/cancel`, { token: user.token, body: {} });
    res = await W.admin('PATCH', `/orders/${cancelled.id}/assign-rider`, { deliveryPartnerId: first.id });
    assert.equal(res.status, 400);
});

test('a rider cannot give back an accepted order while the admin has that switched off', async () => {
    const user = await W.makeUser();
    const rider = await W.makeRider();
    const placed = await W.place(user, { paymentMethod: 'cash' });
    await W.acceptAndAssign(placed.id, rider);
    const res = await W.rider(rider, 'PATCH', `/orders/${placed.id}/reject`, { reason: 'Bike broke down' });
    assert.equal(res.status, 400);
    await W.admin('PATCH', `/orders/${placed.id}/reject`, { reason: 'cleanup' });
});
