import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * The admin Order Details edits besides the items, over HTTP against the real
 * database, as the admin panel calls them:
 *
 *   PATCH /food/admin/orders/:id/delivery-address(?preview=1)
 *   PATCH /food/admin/orders/:id/note
 *   PATCH /food/admin/orders/:id/cutlery
 *   PATCH /food/admin/orders/:id/schedule
 *   PATCH /food/admin/orders/:id/payment-status
 *
 * World (e2eHarness.js): a 1° zone around the restaurant, two fee bands
 * (under 3 km: fee 30, rider 20; from 3 km: fee 50, rider 35), the order's
 * address 2.2 km north, total 518.4 for the default cart.
 */
process.env.RAZORPAY_KEY_ID = 'rzp_test_fake_order_info_edit';
process.env.RAZORPAY_KEY_SECRET = 'fake-secret-order-info-edit';

const { createWorld, prisma, money, waitFor } = await import('./e2eHarness.js');
const { getCashInHandMap } = await import('../../delivery/services/riderCash.service.js');

let W;

test.before(async () => {
    W = await createWorld({ patch: 33, prefix: 'OINF' });
});

test.after(async () => {
    if (W) await W.close();
});

const details = async (id) => {
    const res = await W.admin('GET', `/orders/${id}/details`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.data;
};

const adminIdOf = async () => (await prisma.foodAdmin.findFirst({
    where: { email: `${W.tag.toLowerCase()}@admin.test` }, select: { id: true },
})).id;

const historyNote = async (id, pattern) => {
    const rows = await prisma.orderStatusHistory.findMany({ where: { orderId: id } });
    return rows.find((h) => pattern.test(h.note || ''));
};

/** The address form, `km` north of the restaurant. */
const addressForm = (km, over = {}) => ({
    fullName: 'Ravi Kumar', phone: '9876511111', street: '7 Lake View Road', additionalDetails: 'Flat 3B, 2nd floor, opp. park',
    city: 'Indore', state: 'MP', zipCode: '452010', label: 'Office',
    latitude: W.HERE.lat + km / 111, longitude: W.HERE.lng,
    ...over,
});

test('delivery info: preview warns of another fee band, save keeps the fee and tells the rider and restaurant', async () => {
    const user = await W.makeUser();
    const rider = await W.makeRider({ km: 0.3 });
    const placed = await W.place(user, { paymentMethod: 'cash' });
    const id = placed.id;
    await W.acceptAndAssign(id, rider);

    let d = await details(id);
    assert.equal(d.details.infoEdit.address.editable, true);

    // ~4.4 km: the 50 band, while the order was charged the 30 band.
    const far = addressForm(4.4);
    const preview = await W.admin('PATCH', `/orders/${placed.order.order_id}/delivery-address?preview=1`, far);
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    const p = preview.body.data.change;
    assert.equal(p.preview, true);
    assert.ok(p.distanceKm > 3, `distance ${p.distanceKm}`);
    assert.equal(p.zone.id, W.zone.id);
    assert.match(p.feeWarning, /₹50 delivery-fee band/);
    assert.match(p.feeWarning, /stays ₹30 as charged/);
    let row = await prisma.foodOrder.findUnique({ where: { id } });
    assert.equal(row.addrStreet, '1 Test Street', 'a preview saves nothing');

    // Nearby (same band): no warning.
    const near = await W.admin('PATCH', `/orders/${id}/delivery-address?preview=1`, addressForm(2.5));
    assert.equal(near.status, 200, JSON.stringify(near.body));
    assert.equal(near.body.data.change.feeWarning, null);

    const saved = await W.admin('PATCH', `/orders/${id}/delivery-address`, far);
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.data.order.deliveryAddress.street, '7 Lake View Road', 'fresh details come back');
    assert.equal(saved.body.data.order.deliveryAddress.additionalDetails, 'Flat 3B, 2nd floor, opp. park');
    assert.ok(saved.body.data.details.infoEdit, 'with the edit state');

    row = await prisma.foodOrder.findUnique({ where: { id } });
    assert.equal(row.addrFullName, 'Ravi Kumar');
    assert.equal(row.addrPhone, '9876511111');
    assert.equal(row.addrLabel, 'Office');
    assert.equal(row.addrZipCode, '452010');
    assert.ok(Math.abs(row.addrLat - far.latitude) < 1e-6);
    assert.equal(money(row.deliveryFee), 30, 'the delivery fee stays as charged');
    assert.equal(money(row.total), 518.4);
    assert.equal(money(row.riderEarning), 20, 'and the rider pay');

    const h = await historyNote(id, /Delivery info changed by admin/);
    assert.ok(h, 'history');
    assert.equal(h.byRole, 'ADMIN');
    assert.equal(h.byId, await adminIdOf());
    assert.match(h.note, /receiver/);
    assert.match(h.note, /7 Lake View Road/);

    for (const room of [W.rooms.restaurant(W.restaurant.id), W.rooms.delivery(rider.id), W.rooms.admin()]) {
        assert.ok(W.events({ room, event: 'order_status_update', orderId: id }).some((e) => e.payload.orderUpdated), room);
    }
    const push = await waitFor(async () => (await W.inboxFor('DELIVERY_PARTNER', rider.id, id)).find((n) => n.category === 'order_updated'), 'rider push');
    assert.match(push.body || push.message || '', /7 Lake View Road/);

    // The rider's view has the new drop.
    const riderView = await W.rider(rider, 'GET', `/orders/${id}`);
    assert.equal(riderView.status, 200, JSON.stringify(riderView.body));
    assert.equal(riderView.body.data.order.deliveryAddress.street, '7 Lake View Road');
});

test('delivery info: refused outside the zone, invalid, for a delivered order; db or display id', async () => {
    const user = await W.makeUser();
    const { id, order } = await W.place(user, { paymentMethod: 'cash' });

    // 0.6° north is outside the 1° patch.
    const outside = await W.admin('PATCH', `/orders/${id}/delivery-address`, addressForm(0, { latitude: W.HERE.lat + 0.6 }));
    assert.equal(outside.status, 400);
    assert.match(outside.body.message, /outside every delivery zone/);

    assert.equal((await W.admin('PATCH', `/orders/${id}/delivery-address`, addressForm(1, { phone: 'abc' }))).status, 400);
    assert.equal((await W.admin('PATCH', `/orders/${id}/delivery-address`, addressForm(1, { latitude: undefined }))).status, 400);
    assert.equal((await W.admin('PATCH', `/orders/${id}/delivery-address`, addressForm(1, { street: '' }))).status, 400);
    assert.equal((await W.admin('PATCH', '/orders/FOD-000000nope/delivery-address', addressForm(1))).status, 404);
    const row = await prisma.foodOrder.findUnique({ where: { id } });
    assert.equal(row.addrStreet, '1 Test Street', 'refused changes save nothing');

    const ok = await W.admin('PATCH', `/orders/${order.order_id}/delivery-address`, addressForm(1));
    assert.equal(ok.status, 200, JSON.stringify(ok.body));

    await prisma.foodOrder.update({ where: { id }, data: { orderStatus: 'delivered' } });
    const done = await W.admin('PATCH', `/orders/${id}/delivery-address`, addressForm(1.2));
    assert.equal(done.status, 400);
    assert.match(done.body.message, /delivered/);
    assert.equal((await details(id)).details.infoEdit.address.editable, false);
});

test('note, delivery instructions and cutlery', async () => {
    const user = await W.makeUser();
    const { id } = await W.place(user, { paymentMethod: 'cash' });

    let res = await W.admin('PATCH', `/orders/${id}/note`, { note: 'No onions', deliveryInstructions: 'Ring twice, leave at gate' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.order.note, 'No onions');
    assert.equal(res.body.data.order.deliveryInstructions, 'Ring twice, leave at gate');
    let row = await prisma.foodOrder.findUnique({ where: { id } });
    assert.equal(row.note, 'No onions');
    assert.ok(await historyNote(id, /order note "No onions".*delivery instructions "Ring twice/));

    res = await W.admin('PATCH', `/orders/${id}/note`, { deliveryInstructions: '' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    row = await prisma.foodOrder.findUnique({ where: { id } });
    assert.equal(row.deliveryInstructions, '');
    assert.equal(row.note, 'No onions', 'the other field is left alone');

    assert.equal((await W.admin('PATCH', `/orders/${id}/note`, {})).status, 400);
    assert.equal((await W.admin('PATCH', `/orders/${id}/note`, { note: 'x'.repeat(501) })).status, 400);
    assert.equal((await W.admin('PATCH', `/orders/${id}/note`, { note: 'No onions' })).status, 400, 'nothing changed');

    assert.equal(row.sendCutlery, true);
    res = await W.admin('PATCH', `/orders/${id}/cutlery`, { sendCutlery: false });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.order.sendCutlery, false);
    assert.equal((await prisma.foodOrder.findUnique({ where: { id } })).sendCutlery, false);
    assert.ok(await historyNote(id, /Cutlery changed by admin: no cutlery/));
    assert.ok(W.events({ room: W.rooms.restaurant(W.restaurant.id), event: 'order_status_update', orderId: id }).some((e) => e.payload.orderUpdated));
    assert.equal((await W.admin('PATCH', `/orders/${id}/cutlery`, { sendCutlery: 'maybe' })).status, 400);

    await prisma.foodOrder.update({ where: { id }, data: { orderStatus: 'picked_up', pickedUpAt: new Date() } });
    const late = await W.admin('PATCH', `/orders/${id}/cutlery`, { sendCutlery: true });
    assert.equal(late.status, 400);
    assert.match(late.body.message, /picked up/);
    assert.equal((await W.admin('PATCH', `/orders/${id}/note`, { note: 'Extra napkins' })).status, 200, 'the note still can');
});

test('schedule: a scheduled order not released yet moves, checked like checkout', async () => {
    await W.set('business_order', { scheduledOrder: true, scheduleSlotMinutes: 30 });
    try {
        const user = await W.makeUser();
        const at = new Date(Date.now() + 3 * 3600 * 1000);
        const { id } = await W.place(user, { paymentMethod: 'cash', calc: { scheduledAt: at.toISOString() } });
        let row = await prisma.foodOrder.findUnique({ where: { id } });
        assert.ok(row.releaseAt, 'held for its time');

        let d = await details(id);
        assert.equal(d.details.infoEdit.schedule.editable, true, d.details.infoEdit.schedule.reason);

        const next = new Date(Date.now() + 5 * 3600 * 1000);
        const res = await W.admin('PATCH', `/orders/${id}/schedule`, { scheduledAt: next.toISOString() });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        row = await prisma.foodOrder.findUnique({ where: { id } });
        assert.equal(row.scheduledAt.getTime(), next.getTime());
        assert.equal(row.releaseAt.getTime(), next.getTime() - 40 * 60 * 1000, 'released 40 minutes before');
        assert.equal(row.acceptanceDeadlineAt.getTime(), row.releaseAt.getTime() + row.acceptanceWindowSeconds * 1000);
        const h = await historyNote(id, /Scheduled time changed by admin/);
        assert.ok(h);
        assert.match(h.note, /\d{2} [A-Z][a-z]{2} \d{4}, \d{2}:\d{2} (AM|PM)/, '12-hour time');
        await waitFor(async () => (await W.inboxFor('USER', user.id, id)).some((n) => n.category === 'order_updated'), 'customer push');

        const soon = await W.admin('PATCH', `/orders/${id}/schedule`, { scheduledAt: new Date(Date.now() + 10 * 60 * 1000).toISOString() });
        assert.equal(soon.status, 400);
        assert.match(soon.body.message, /at least/);
        assert.equal((await W.admin('PATCH', `/orders/${id}/schedule`, { scheduledAt: new Date(Date.now() + 4 * 86400000).toISOString() })).status, 400);
        assert.equal((await W.admin('PATCH', `/orders/${id}/schedule`, { scheduledAt: 'tomorrow' })).status, 400);

        // An order for now is not scheduled.
        const now = await W.place(user, { paymentMethod: 'cash' });
        const refused = await W.admin('PATCH', `/orders/${now.id}/schedule`, { scheduledAt: next.toISOString() });
        assert.equal(refused.status, 400);
        assert.match(refused.body.message, /placed for now/);
    } finally {
        await W.set('business_order', {});
    }
});

test('payment: COD marked paid before pickup is not collected or counted as the rider\'s cash; unpaid undoes it', async () => {
    const user = await W.makeUser();
    const rider = await W.makeRider({ km: 0.4 });
    const { id, order } = await W.place(user, { paymentMethod: 'cash' });
    await W.admin('PATCH', `/orders/${id}/reference-code`, { referenceCode: 'UTR-778899' });

    let d = await details(id);
    assert.equal(d.details.infoEdit.payment.applies, true);
    assert.equal(d.details.infoEdit.payment.canMarkPaid, true);

    let res = await W.admin('PATCH', `/orders/${order.order_id}/payment-status`, { paid: true });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.bill.payment.statusLabel, 'Paid');
    assert.equal(res.body.data.details.infoEdit.payment.markedPaidByAdmin, true);
    assert.equal(res.body.data.details.editable, false, 'a paid order\'s items no longer change');
    let row = await prisma.foodOrder.findUnique({ where: { id } });
    assert.equal(row.paymentMethod, 'offline');
    assert.equal(row.paymentStatus, 'paid');
    assert.equal(row.offlinePayment.convertedFrom, 'cash');
    assert.equal(row.offlinePayment.fields[0].value, 'UTR-778899');
    let tx = await prisma.foodTransaction.findUnique({ where: { orderId: id }, include: { history: true } });
    assert.equal(tx.status, 'captured');
    assert.equal(tx.paymentMethod, 'offline');
    assert.equal(tx.paymentStatusLabel, 'paid');
    const adminId = await adminIdOf();
    assert.ok(tx.history.some((x) => x.kind === 'admin_marked_paid' && x.recordedById === adminId));
    assert.ok(await historyNote(id, /marked as paid by admin/));

    // Undo, then mark paid again.
    res = await W.admin('PATCH', `/orders/${id}/payment-status`, { paid: false });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    row = await prisma.foodOrder.findUnique({ where: { id } });
    assert.equal(row.paymentMethod, 'cash');
    assert.equal(row.paymentStatus, 'cod_pending');
    assert.equal(row.offlinePayment, null);
    tx = await prisma.foodTransaction.findUnique({ where: { orderId: id } });
    assert.equal(tx.status, 'pending');
    assert.equal(tx.paymentMethod, 'cash');
    assert.equal((await W.admin('PATCH', `/orders/${id}/payment-status`, { paid: false })).status, 400, 'not paid');
    assert.equal((await W.admin('PATCH', `/orders/${id}/payment-status`, { paid: 'yes' })).status, 400);
    res = await W.admin('PATCH', `/orders/${id}/payment-status`, { paid: true });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    // The rider collects nothing and holds nothing for it.
    await W.acceptAndAssign(id, rider);
    const riderView = await W.rider(rider, 'GET', `/orders/${id}`);
    assert.equal(riderView.body.data.order.amountToCollect, 0);
    await W.deliver(id, rider, user, { collect: 'none' });
    await W.assertDeliveredMoney(id, { riderPay: 20, rider, cashCollected: 0 });
    assert.equal((await getCashInHandMap([rider.id])).get(rider.id), 0);
    const after = await W.admin('PATCH', `/orders/${id}/payment-status`, { paid: false });
    assert.equal(after.status, 400, 'a delivered order stays paid');
});

test('payment: refused once the rider has the food, for a delivered COD and for online orders', async () => {
    const user = await W.makeUser();
    const rider = await W.makeRider({ km: 0.45 });

    const cod = await W.place(user, { paymentMethod: 'cash' });
    await W.acceptAndAssign(cod.id, rider);
    let r = await W.rider(rider, 'PATCH', `/orders/${cod.id}/reached-pickup`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    r = await W.rider(rider, 'PATCH', `/orders/${cod.id}/confirm-pickup`, {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    let res = await W.admin('PATCH', `/orders/${cod.id}/payment-status`, { paid: true });
    assert.equal(res.status, 400);
    assert.match(res.body.message, /twice/);
    assert.equal((await details(cod.id)).details.infoEdit.payment.canMarkPaid, false);

    // The rider collects and delivers: paid by the collection, never "unpaid".
    await W.rider(rider, 'PATCH', `/orders/${cod.id}/reached-drop`);
    const otp = (await W.http.get(`/api/v1/food/orders/${cod.id}/drop-otp`, { token: user.token })).body.data.otp;
    assert.equal((await W.rider(rider, 'POST', `/orders/${cod.id}/verify-drop-otp`, { otp })).status, 200);
    assert.equal((await W.rider(rider, 'POST', `/orders/${cod.id}/collect/cash`)).status, 200);
    assert.equal((await W.rider(rider, 'PATCH', `/orders/${cod.id}/complete`, {})).status, 200);
    res = await W.admin('PATCH', `/orders/${cod.id}/payment-status`, { paid: false });
    assert.equal(res.status, 400);
    assert.match(res.body.message, /rider collected/);
    assert.equal((await getCashInHandMap([rider.id])).get(rider.id), 518.4, 'the rider holds the collected cash, once');

    const online = await W.place(user, { paymentMethod: 'razorpay' });
    await W.payOnline(user, online);
    res = await W.admin('PATCH', `/orders/${online.id}/payment-status`, { paid: false });
    assert.equal(res.status, 400);
    assert.equal((await details(online.id)).details.infoEdit.payment.applies, false);
    assert.equal((await prisma.foodOrder.findUnique({ where: { id: online.id } })).paymentStatus, 'paid');
});
