import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../../config/prisma.js';
import { uniquePhone, uniqueTag } from '../../../../utils/testIds.js';
import {
    getAllOffers,
    createAdminOffer,
    updateAdminOfferCartVisibility,
    deleteAdminOffer,
    expireExpiredOffers,
} from './adminOffer.service.js';

/**
 * Admin coupons.
 *
 * A coupon names its restaurants either singly or as a list, and both forms
 * exist in the data — so both are exercised here.
 */
const live = Boolean(process.env.DATABASE_URL);

const created = { offers: [], restaurants: [], users: [] };
const DAY = 86400000;

const makeRestaurant = async () => {
    const r = await prisma.foodRestaurant.create({
        data: {
            restaurantName: `Offer Rest ${uniqueTag('R')}`,
            ownerName: 'Owner',
            ownerPhone: uniquePhone('9'),
            status: 'approved',
        },
    });
    created.restaurants.push(r.id);
    return r;
};

const makeOffer = async (body = {}) => {
    const offer = await createAdminOffer({
        couponCode: uniqueTag('SAVE').toUpperCase(),
        discountType: 'percentage',
        discountValue: 20,
        customerScope: 'all',
        restaurantScope: 'all',
        ...body,
    });
    created.offers.push(offer.id);
    return offer;
};

test.after(async () => {
    if (!live) return;
    await prisma.foodOfferUsage.deleteMany({ where: { offerId: { in: created.offers } } });
    await prisma.foodOffer.deleteMany({ where: { id: { in: created.offers } } });
    await prisma.foodUser.deleteMany({ where: { id: { in: created.users } } });
    await prisma.foodRestaurant.deleteMany({ where: { id: { in: created.restaurants } } });
    await prisma.$disconnect();
});

test('an admin coupon is platform-funded by default', { skip: !live }, async () => {
    const offer = await makeOffer();

    assert.equal(offer.createdByRole, 'ADMIN');
    assert.equal(Number(offer.adminBearPercentage), 100);
    assert.equal(Number(offer.restaurantBearPercentage), 0);
    assert.equal(offer.status, 'active');
});

test('a duplicate coupon code is refused', { skip: !live }, async () => {
    const code = uniqueTag('DUP').toUpperCase();
    await makeOffer({ couponCode: code });

    // The unique index settles it, not a lookup two admins could both pass.
    await assert.rejects(() => makeOffer({ couponCode: code }), /already exists/);
});

test('a coupon created already expired starts inactive', { skip: !live }, async () => {
    const offer = await makeOffer({ endDate: new Date(Date.now() - DAY) });
    // Otherwise it reads live until a sweep happens to notice.
    assert.equal(offer.status, 'inactive');

    const future = await makeOffer({ endDate: new Date(Date.now() + DAY) });
    assert.equal(future.status, 'active');
});

test('the list names every restaurant a coupon covers', { skip: !live }, async () => {
    const a = await makeRestaurant();
    const b = await makeRestaurant();

    const listed = await makeOffer({
        restaurantScope: 'selected',
        restaurantIds: [a.id, b.id],
    });
    const single = await makeOffer({
        restaurantScope: 'selected',
        restaurantId: a.id,
    });
    const global = await makeOffer();

    const { offers } = await getAllOffers();

    // The array form: two .populate() calls became one lookup.
    const listedRow = offers.find((o) => o.offerId === listed.id);
    assert.ok(listedRow.restaurantName.includes(a.restaurantName));
    assert.ok(listedRow.restaurantName.includes(b.restaurantName));

    // The single form is still supported; both exist in the data.
    const singleRow = offers.find((o) => o.offerId === single.id);
    assert.equal(singleRow.restaurantName, a.restaurantName);

    assert.equal(offers.find((o) => o.offerId === global.id).restaurantName, 'All Restaurants');
});

test('the list derives expiry rather than trusting the status', { skip: !live }, async () => {
    // Written straight to the table so the status column still says active
    // while the end date has passed.
    const stale = await prisma.foodOffer.create({
        data: {
            couponCode: uniqueTag('STALE').toUpperCase(),
            discountType: 'percentage',
            discountValue: 10,
            status: 'active',
            endDate: new Date(Date.now() - DAY),
        },
    });
    created.offers.push(stale.id);

    const { offers } = await getAllOffers();
    assert.equal(offers.find((o) => o.offerId === stale.id).status, 'inactive');

    // And the sweep brings the column into line.
    await expireExpiredOffers();
    const row = await prisma.foodOffer.findUnique({ where: { id: stale.id } });
    assert.equal(row.status, 'inactive');
});

test('enum names are translated for the admin UI', { skip: !live }, async () => {
    const firstTime = await makeOffer({ customerScope: 'first_time' });
    const flat = await makeOffer({ discountType: 'flat_price', discountValue: 75 });

    const { offers } = await getAllOffers();

    // The column is first_time (mapped to 'first-time'); the UI says 'new'.
    assert.equal(offers.find((o) => o.offerId === firstTime.id).customerGroup, 'new');
    assert.equal(offers.find((o) => o.offerId === flat.id).customerGroup, 'all');

    const flatRow = offers.find((o) => o.offerId === flat.id);
    assert.equal(flatRow.originalPrice, 75, 'a flat coupon reports its amount');
    assert.equal(flatRow.discountPercentage, 0);

    const pctRow = offers.find((o) => o.offerId === firstTime.id);
    assert.equal(pctRow.discountPercentage, 20);
});

test('cart visibility toggles', { skip: !live }, async () => {
    const offer = await makeOffer();
    assert.equal(offer.showInCart, true);

    const hidden = await updateAdminOfferCartVisibility(offer.id, 'all', false);
    assert.equal(hidden.showInCart, false);

    assert.equal(await updateAdminOfferCartVisibility('a'.repeat(24), 'all', false), null);
    // itemId is required by the signature, so a missing one is a no-op.
    assert.equal(await updateAdminOfferCartVisibility(offer.id, '', false), null);
});

test('deleting a coupon takes its usage records with it', { skip: !live }, async () => {
    const offer = await makeOffer();

    const user = await prisma.foodUser.create({ data: { phone: uniquePhone('5') } });
    created.users.push(user.id);

    const usage = await prisma.foodOfferUsage.create({
        data: { offerId: offer.id, userId: user.id, count: 2 },
    });

    assert.deepEqual(await deleteAdminOffer(offer.id), { id: offer.id });

    // ON DELETE CASCADE, so the second delete Mongo needed is gone — and there
    // is no window where a usage row outlives its offer.
    assert.equal(await prisma.foodOfferUsage.findUnique({ where: { id: usage.id } }), null);

    assert.equal(await deleteAdminOffer(offer.id), null);
    assert.equal(await deleteAdminOffer('not-an-id'), null);

    created.offers = created.offers.filter((id) => id !== offer.id);
});

test('a campaign invitation does not block creation if push fails', { skip: !live }, async () => {
    const restaurant = await makeRestaurant();

    // notifyOwnersSafely is best-effort; the coupon must exist regardless.
    const offer = await makeOffer({
        restaurantScope: 'selected',
        restaurantIds: [restaurant.id],
    });

    const row = await prisma.foodOffer.findUnique({ where: { id: offer.id } });
    assert.ok(row);
    assert.deepEqual(row.restaurantIds, [restaurant.id]);
});
