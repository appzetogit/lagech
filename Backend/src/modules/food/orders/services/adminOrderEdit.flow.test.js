import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * The admin Order Details "Edit" (items) and "Reference Code", over HTTP
 * against the real database, as the admin panel calls them:
 *
 *   GET   /food/admin/orders/:id/details        editable + reason, referenceCode
 *   GET   /food/admin/orders/:id/menu           the restaurant's dishes for "Add item"
 *   PUT   /food/admin/orders/:id/items?preview=1  new amounts, nothing saved
 *   PUT   /food/admin/orders/:id/items          re-priced and saved
 *   PATCH /food/admin/orders/:id/reference-code
 *
 * World (e2eHarness.js): thali 200, lassi 60, 5% GST on items, a 2.2 km trip
 * in the first band (fee 30 + 18% GST 5.4, rider 20), 15% commission.
 */
process.env.RAZORPAY_KEY_ID = 'rzp_test_fake_order_edit';
process.env.RAZORPAY_KEY_SECRET = 'fake-secret-order-edit';

const { createWorld, prisma, money, waitFor } = await import('./e2eHarness.js');

let W;
const extra = { addons: [] };

test.before(async () => {
    W = await createWorld({ patch: 38, prefix: 'OEDT' });
    // A dish with sizes and an add-on, for "Add item".
    extra.pizza = await prisma.foodItem.create({
        data: {
            restaurantId: W.restaurant.id, name: `${W.tag} Pizza`, price: 250, approvalStatus: 'approved', isAvailable: true,
            variants: { create: [{ name: 'Regular', price: 250, sortOrder: 0 }, { name: 'Large', price: 300, sortOrder: 1 }] },
        },
        include: { variants: true },
    });
    W.created.foods.push(extra.pizza.id);
    extra.large = extra.pizza.variants.find((v) => v.name === 'Large');
    const cheese = await prisma.foodAddon.create({
        data: {
            restaurantId: W.restaurant.id, foodIds: [extra.pizza.id], groupName: 'Extras', groupMaxSelect: 2,
            draft: { name: 'Cheese', price: 15 }, published: { name: 'Cheese', price: 15 },
            approvalStatus: 'approved', isAvailable: true,
        },
    });
    extra.addons.push(cheese.id);
    extra.cheese = cheese;
});

test.after(async () => {
    if (!W) return;
    await prisma.foodAddon.deleteMany({ where: { id: { in: extra.addons } } }).catch(() => {});
    await W.close();
});

const details = async (id) => {
    const res = await W.admin('GET', `/orders/${id}/details`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.data;
};
const editItems = (id, items, { preview = false } = {}) =>
    W.admin('PUT', `/orders/${id}/items${preview ? '?preview=1' : ''}`, { items });


/** The harness's admin (W.admin is its request helper, so the row is looked up). */
const adminIdOf = async () => (await prisma.foodAdmin.findFirst({
    where: { email: `${W.tag.toLowerCase()}@admin.test` }, select: { id: true },
})).id;

test('COD order: preview changes nothing, save re-prices and re-splits the order', async () => {
    const user = await W.makeUser();
    const placed = await W.place(user, { paymentMethod: 'cash' });
    const id = placed.id;
    assert.equal(Number(placed.order.pricing.total), 518.4);

    const d = await details(id);
    assert.equal(d.details.editable, true, d.details.editReason);
    assert.equal(d.details.editReason, null);

    // Thali x1 + lassi x2 = 320; GST 16; delivery 30 + 5.4 as charged.
    const items = [{ itemId: W.thali.id, quantity: 1 }, { foodId: W.lassi.id, quantity: 2 }];
    const preview = await editItems(id, items, { preview: true });
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    const p = preview.body.data.edit;
    assert.equal(p.preview, true);
    assert.equal(p.before.total, 518.4);
    assert.equal(p.after.subtotal, 320);
    assert.equal(p.after.tax, 16);
    assert.equal(p.after.deliveryFee, 30);
    assert.equal(p.after.total, 371.4);
    assert.equal(p.difference, money(371.4 - 518.4));
    assert.equal(p.restaurantCommission, 48, '15% of 320');
    let row = await prisma.foodOrder.findUnique({ where: { id }, include: { items: true } });
    assert.equal(money(row.total), 518.4, 'a preview saves nothing');
    assert.equal(row.items.length, 2);

    const saved = await editItems(id, items);
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.data.order.pricing.total, 371.4, 'the details payload comes back');
    assert.equal(saved.body.data.edit.after.total, 371.4);

    row = await prisma.foodOrder.findUnique({ where: { id }, include: { items: true, statusHistory: true } });
    assert.equal(money(row.subtotal), 320);
    assert.equal(money(row.total), 371.4);
    assert.equal(money(row.paymentAmountDue), 371.4, 'the rider collects the new total');
    assert.equal(money(row.restaurantCommission), 48);
    assert.equal(money(row.riderEarning), 20, 'rider pay is the trip\'s, unchanged');
    // 30 + 5.4 delivery + 48 commission - 20 rider.
    assert.equal(money(row.platformProfit), 63.4);
    assert.equal(row.orderStatus, placed.order.orderStatus, 'the status does not move');
    const byItem = new Map(row.items.map((it) => [it.itemId, it]));
    assert.equal(byItem.get(W.thali.id).quantity, 1);
    assert.equal(byItem.get(W.lassi.id).quantity, 2);

    const tx = await prisma.foodTransaction.findUnique({ where: { orderId: id }, include: { history: true } });
    assert.equal(money(tx.totalCustomerPaid), 371.4);
    assert.equal(money(tx.commissionAmount), 48);
    assert.equal(money(tx.restaurantShare), 272, 'restaurant earns 320 - 48');
    assert.equal(money(tx.platformNetProfit), 63.4);
    assert.equal(money(tx.amountDue), 371.4);
    const adminId = await adminIdOf();
    assert.ok(tx.history.some((h) => h.kind === 'order_edited' && h.recordedById === adminId));
    assert.equal(
        money(Number(tx.restaurantShare) + Number(tx.platformNetProfit) + Number(tx.riderShare) + Number(row.tax)),
        money(row.total),
        'total = restaurant net + admin net + rider + tax, still',
    );

    const edit = row.statusHistory.find((h) => /Items edited by admin/.test(h.note));
    assert.ok(edit, 'the edit is in the history');
    assert.equal(edit.byRole, 'ADMIN');
    assert.equal(edit.byId, await adminIdOf());
    assert.match(edit.note, /518\.4.*371\.4/);

    assert.ok(W.events({ room: W.rooms.user(user.id), event: 'order_status_update', orderId: id }).some((e) => e.payload.orderUpdated));
    assert.ok(W.events({ room: W.rooms.restaurant(W.restaurant.id), event: 'order_status_update', orderId: id }).some((e) => e.payload.orderUpdated));
    assert.ok(W.events({ room: W.rooms.admin(), event: 'order_status_update', orderId: id }).some((e) => e.payload.orderUpdated));
    const push = await waitFor(async () => (await W.inboxFor('USER', user.id, id)).find((n) => n.category === 'order_updated'), 'customer push');
    assert.match(push.body || push.message || '', /371\.4/);
});

test('add a dish from the menu with its size and add-on; bad requests are refused', async () => {
    const user = await W.makeUser();
    const { id } = await W.place(user, { paymentMethod: 'cash' });

    const menu = await W.admin('GET', `/orders/${id}/menu`);
    assert.equal(menu.status, 200, JSON.stringify(menu.body));
    const pizza = menu.body.data.items.find((it) => it.id === extra.pizza.id);
    assert.ok(pizza, 'the restaurant\'s dish is offered');
    assert.deepEqual(pizza.variants.map((v) => v.name), ['Regular', 'Large']);
    assert.ok(pizza.addonGroups.some((g) => g.options.some((o) => o.id === extra.cheese.id)));
    assert.ok(!menu.body.data.items.find((it) => it.id === W.thali.id).addonGroups.length, 'the add-on is the pizza\'s only');

    const res = await editItems(id, [
        { itemId: W.thali.id, quantity: 2 },
        { itemId: extra.pizza.id, variantId: extra.large.id, quantity: 1, addons: [extra.cheese.id] },
    ]);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const line = res.body.data.edit.items.find((it) => it.itemId === extra.pizza.id);
    assert.equal(line.variantName, 'Large');
    assert.equal(line.unitPrice, 315, 'Large 300 + cheese 15');
    assert.equal(res.body.data.edit.after.subtotal, 715);

    assert.equal((await editItems(id, [])).status, 400, 'at least one item stays');
    assert.equal((await editItems(id, [{ itemId: extra.pizza.id, quantity: 1 }])).status, 400, 'a sized dish needs its size');
    assert.equal((await editItems(id, [{ itemId: '0123456789abcdef01234567', quantity: 1 }])).status, 400, 'not on this menu');
    assert.equal((await editItems(id, [{ itemId: W.thali.id, quantity: 0 }])).status, 400);
    assert.equal((await editItems('FOD-000000nope', [{ itemId: W.thali.id, quantity: 1 }])).status, 404);
});

test('refused once ready for pickup, and for an order paid online', async () => {
    const user = await W.makeUser();
    const { id } = await W.place(user, { paymentMethod: 'cash' });
    await W.restaurantStatus(id, 'confirmed');
    assert.equal((await details(id)).details.editable, true, 'still editable once accepted');
    // The kitchen's later steps, set directly (no rider in this world).
    await prisma.foodOrder.update({ where: { id }, data: { orderStatus: 'preparing' } });
    assert.equal((await details(id)).details.editable, true, 'still editable while cooking');
    await prisma.foodOrder.update({ where: { id }, data: { orderStatus: 'ready_for_pickup' } });
    const d = await details(id);
    assert.equal(d.details.editable, false);
    assert.match(d.details.editReason, /ready for pickup/);
    const res = await editItems(id, [{ itemId: W.thali.id, quantity: 1 }]);
    assert.equal(res.status, 400);
    assert.match(res.body.message, /ready for pickup/);

    const online = await W.place(user, { paymentMethod: 'razorpay' });
    await W.payOnline(user, online);
    const od = await details(online.id);
    assert.equal(od.details.editable, false);
    const refused = await editItems(online.id, [{ itemId: W.thali.id, quantity: 1 }]);
    assert.equal(refused.status, 400);
    assert.match(refused.body.message, /paid online/);
    const row = await prisma.foodOrder.findUnique({ where: { id: online.id } });
    assert.equal(money(row.total), 518.4, 'untouched');
});

test('coupon: kept while it still applies, dropped (and given back) when it does not', async () => {
    const coupon = await W.makeCoupon({ discountType: 'percentage', discountValue: 10, minOrderValue: 400, usageLimit: 1 });
    const user = await W.makeUser();
    const { id, order } = await W.place(user, { paymentMethod: 'cash', calc: { couponCode: coupon.couponCode } });
    // 460 - 46 = 414; GST round(20.7) = 21; + 35.4.
    assert.equal(Number(order.pricing.discount), 46);
    assert.equal(Number(order.pricing.total), 470.4);
    assert.equal((await prisma.foodOffer.findUnique({ where: { id: coupon.id } })).usedCount, 1, 'its one use is this order');

    // Thali x2 = 400: still over the minimum, and the use limit of 1 is this order's own.
    let res = await editItems(id, [{ itemId: W.thali.id, quantity: 2 }]);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.edit.couponNote, '');
    assert.equal(res.body.data.edit.after.discount, 40);
    assert.equal(res.body.data.edit.after.couponCode, coupon.couponCode);
    let row = await prisma.foodOrder.findUnique({ where: { id } });
    assert.equal(row.couponId, coupon.id);
    assert.equal(money(row.discount), 40);
    // 400 - 40 = 360; GST 18; + 35.4.
    assert.equal(money(row.total), 413.4);

    // Lassi x1 = 60: under the minimum, so the coupon goes and says why.
    res = await editItems(id, [{ itemId: W.lassi.id, quantity: 1 }]);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.match(res.body.data.edit.couponNote, new RegExp(`Coupon ${coupon.couponCode} removed`));
    row = await prisma.foodOrder.findUnique({ where: { id }, include: { statusHistory: true } });
    assert.equal(row.couponId, null);
    assert.equal(row.couponCode, null);
    assert.equal(money(row.discount), 0);
    // 60 + GST 3 + 35.4.
    assert.equal(money(row.total), 98.4);
    assert.ok(row.statusHistory.some((h) => /removed/.test(h.note)), 'the history says the coupon went');
    assert.equal((await prisma.foodOffer.findUnique({ where: { id: coupon.id } })).usedCount, 0, 'its use is given back');
    const tx = await prisma.foodTransaction.findUnique({ where: { orderId: id } });
    assert.equal(money(tx.discount), 0);
    assert.equal(money(tx.restaurantDiscountShare), 0);
});

test('reference code: set by db or display id, shown on the details, validated, cleared', async () => {
    const user = await W.makeUser();
    const { id, order } = await W.place(user, { paymentMethod: 'cash' });

    let res = await W.admin('PATCH', `/orders/${order.order_id}/reference-code`, { referenceCode: '  UTR 4417-AB  ' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.referenceCode, 'UTR 4417-AB');
    let d = await details(id);
    assert.equal(d.details.referenceCode, 'UTR 4417-AB');
    assert.equal(d.order.referenceCode, 'UTR 4417-AB');
    assert.equal(d.bill.payment.referenceCode, 'UTR 4417-AB');

    res = await W.admin('PATCH', `/orders/${id}/reference-code`, { referenceCode: 'x'.repeat(101) });
    assert.equal(res.status, 400);
    res = await W.admin('PATCH', `/orders/${id}/reference-code`, {});
    assert.equal(res.status, 400, 'the field is required');
    assert.equal((await prisma.foodOrder.findUnique({ where: { id } })).referenceCode, 'UTR 4417-AB', 'a refused change keeps the code');

    res = await W.admin('PATCH', `/orders/${id}/reference-code`, { referenceCode: '' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.referenceCode, null);
    d = await details(id);
    assert.equal(d.details.referenceCode, null);

    assert.equal((await W.admin('PATCH', '/orders/FOD-000000nope/reference-code', { referenceCode: 'A' })).status, 404);
});
