import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../../config/prisma.js';
import { uniquePhone, uniqueTag } from '../../../../utils/testIds.js';
import {
    getAllOffers,
    getAdminOffer,
    createAdminOffer,
    updateAdminOffer,
    setAdminOfferStatus,
} from './adminOffer.service.js';
import { validateCreateOfferDto, validateUpdateOfferDto, validateOfferStatusDto } from '../validators/offer.validator.js';

/**
 * The admin Coupons page, shaped like the old panel's: the form's fields go
 * through the validator into the service, the list carries the old columns.
 */
const created = { offers: [], restaurants: [], zones: [], users: [] };
const DAY = 86400000;
const ymd = (ms) => new Date(Date.now() + ms + 5.5 * 3600000).toISOString().slice(0, 10);

const form = (over = {}) => ({
    title: 'Weekend treat',
    couponType: 'default',
    couponCode: uniqueTag('wk'),
    discountType: 'percent',
    discountValue: '15',
    maxDiscount: '120',
    minOrderValue: '199',
    perUserLimit: '2',
    startDate: ymd(0),
    endDate: ymd(7 * DAY),
    ...over,
});

const create = async (over) => {
    const offer = await createAdminOffer(validateCreateOfferDto(form(over)));
    created.offers.push(offer.id);
    return offer;
};

test.after(async () => {
    await prisma.foodOffer.deleteMany({ where: { id: { in: created.offers } } });
    await prisma.foodUser.deleteMany({ where: { id: { in: created.users } } });
    await prisma.foodRestaurant.deleteMany({ where: { id: { in: created.restaurants } } });
    await prisma.foodZone.deleteMany({ where: { id: { in: created.zones } } });
    await prisma.$disconnect();
});

test('the form saves every old-panel field', async () => {
    const offer = await create();
    assert.equal(offer.title, 'Weekend treat');
    assert.equal(offer.couponType, 'default');
    assert.match(offer.couponCode, /^WK[0-9A-F]+$/, 'codes are upper-cased');
    assert.equal(offer.discountType, 'percentage');
    assert.equal(Number(offer.discountValue), 15);
    assert.equal(Number(offer.maxDiscount), 120);
    assert.equal(Number(offer.minOrderValue), 199);
    assert.equal(offer.perUserLimit, 2);
    assert.equal(offer.customerScope, 'all');
    // Whole days in India: 00:00 IST start, 23:59:59.999 IST expiry.
    assert.equal(offer.startDate.toISOString(), new Date(`${ymd(0)}T00:00:00.000+05:30`).toISOString());
    assert.equal(offer.endDate.toISOString(), new Date(`${ymd(7 * DAY)}T23:59:59.999+05:30`).toISOString());
});

test('an amount discount drops the max discount; a percent one may leave it empty', async () => {
    const amount = await create({ discountType: 'amount', discountValue: '50', maxDiscount: '20' });
    assert.equal(amount.discountType, 'flat_price');
    assert.equal(amount.maxDiscount, null);

    const uncapped = await create({ maxDiscount: '' });
    assert.equal(uncapped.maxDiscount, null);
});

test('each coupon type stores what checkout reads', async () => {
    const restaurant = await prisma.foodRestaurant.create({
        data: { restaurantName: `Cpn ${uniqueTag('R')}`, ownerName: 'O', ownerPhone: uniquePhone('9'), status: 'approved' },
    });
    created.restaurants.push(restaurant.id);
    const zone = await prisma.foodZone.create({
        data: {
            name: `Cpn ${uniqueTag('Z')}`, isActive: true,
            coordinates: [{ latitude: 1, longitude: 1 }, { latitude: 1, longitude: 2 }, { latitude: 2, longitude: 2 }],
        },
    });
    created.zones.push(zone.id);

    const store = await create({ couponType: 'store_wise', restaurantId: restaurant.id });
    assert.equal(store.restaurantScope, 'selected');
    assert.deepEqual(store.restaurantIds, [restaurant.id]);

    const zoned = await create({ couponType: 'zone_wise', zoneIds: [zone.id] });
    assert.equal(zoned.restaurantScope, 'all');
    assert.deepEqual(zoned.zoneIds, [zone.id]);

    const free = await create({ couponType: 'free_delivery', discountType: '', discountValue: '', maxDiscount: '' });
    assert.equal(Number(free.discountValue), 0);
    assert.equal(Number(free.adminBearPercentage), 100, 'the platform funds a waived delivery fee');

    const first = await create({ couponType: 'first_order' });
    assert.equal(first.isFirstOrderOnly, true);

    const { offers } = await getAllOffers();
    const byId = new Map(offers.map((o) => [o.id, o]));
    assert.equal(byId.get(store.id).couponTypeLabel, 'Store wise');
    assert.equal(byId.get(store.id).restaurants[0].name, restaurant.restaurantName);
    assert.equal(byId.get(zoned.id).zones[0].name, zone.name);
    assert.equal(byId.get(free.id).couponTypeLabel, 'Free delivery');
    assert.equal(byId.get(first.id).couponTypeLabel, 'First order');
    assert.equal(byId.get(store.id).totalUses, 0);
});

test('the form refuses what cannot work', () => {
    assert.throws(() => validateCreateOfferDto(form({ couponType: 'store_wise' })), /Select a restaurant/);
    assert.throws(() => validateCreateOfferDto(form({ couponType: 'zone_wise' })), /Select a zone/);
    assert.throws(() => validateCreateOfferDto(form({ customerScope: 'specific', customerIds: [] })), /at least one customer/);
    assert.throws(() => validateCreateOfferDto(form({ discountValue: '0' })), /greater than 0/);
    assert.throws(() => validateCreateOfferDto(form({ discountValue: '120' })), /more than 100/);
    assert.throws(() => validateCreateOfferDto(form({ startDate: ymd(3 * DAY), endDate: ymd(DAY) })), /on or after the start date/);
    assert.throws(() => validateCreateOfferDto(form({ endDate: ymd(-2 * DAY), startDate: ymd(-3 * DAY) })), /today or later/);
    assert.throws(() => validateCreateOfferDto(form({ couponType: 'weekly' })), /coupon type/);
    // The same start and expire day is a one-day coupon, which is fine.
    assert.doesNotThrow(() => validateCreateOfferDto(form({ startDate: ymd(0), endDate: ymd(0) })));
});

test('customers: all, or a list', async () => {
    const user = await prisma.foodUser.create({ data: { name: 'Picked', phone: uniquePhone('5') } });
    created.users.push(user.id);

    const listed = await create({ customerIds: [user.id] });
    assert.equal(listed.customerScope, 'specific');
    assert.deepEqual(listed.customerIds, [user.id]);

    // The old panel's ["all"].
    const everyone = await create({ customerIds: ['all'] });
    assert.equal(everyone.customerScope, 'all');

    const detail = await getAdminOffer(listed.id);
    assert.equal(detail.customers[0].name, 'Picked');
});

test('edit, switch off and search', async () => {
    const offer = await create({ title: 'Before' });

    const updated = await updateAdminOffer(offer.id, validateUpdateOfferDto(form({
        title: 'After',
        couponCode: offer.couponCode,
        discountType: 'amount',
        discountValue: '40',
        // An expired coupon can be edited without being forced onto a new date.
        startDate: ymd(-5 * DAY),
        endDate: ymd(-2 * DAY),
    })));
    assert.equal(updated.title, 'After');
    assert.equal(updated.discountType, 'flat_price');
    assert.equal(Number(updated.adminBearPercentage), 100, 'funding split untouched when not sent');

    const off = await setAdminOfferStatus(offer.id, validateOfferStatusDto({ status: 'inactive' }).status);
    assert.equal(off.status, 'inactive');
    assert.throws(() => validateOfferStatusDto({ status: 'paused-ish' }), /active or inactive/);

    const { offers } = await getAllOffers({ search: 'after' });
    const row = offers.find((o) => o.id === offer.id);
    assert.ok(row, 'found by title, case-insensitively');
    assert.equal(row.isActive, false);
    assert.equal(row.isExpired, true);

    // A code already taken is refused on edit too.
    const other = await create();
    await assert.rejects(
        () => updateAdminOffer(offer.id, validateUpdateOfferDto(form({ couponCode: other.couponCode }))),
        /already exists/,
    );
    assert.equal(await updateAdminOffer('f'.repeat(24), validateUpdateOfferDto(form())), null);
});
