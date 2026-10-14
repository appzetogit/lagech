import test from 'node:test';
import assert from 'node:assert/strict';

import {
    isRestaurantOpenForListing,
    sortOpenRestaurantsFirst,
} from './restaurantAvailability.helper.js';

/**
 * Closed restaurants sink to the bottom of the customer's lists (the 6amMart
 * behaviour). Pure: no database, a fixed clock.
 */

// Wednesday 12:00 in Asia/Kolkata (the default restaurant timezone).
const NOON = new Date('2026-10-14T06:30:00Z');

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const everyDay = (timing) => Object.fromEntries(DAYS.map((day) => [day, { ...timing }]));

const restaurant = (id, overrides = {}) => ({
    id,
    isAcceptingOrders: true,
    outletTimings: everyDay({ isOpen: true, openingTime: '09:00', closingTime: '22:00' }),
    ...overrides,
});

test('open means taking orders and inside outlet timings', () => {
    assert.equal(isRestaurantOpenForListing(restaurant('a'), NOON), true);

    assert.equal(
        isRestaurantOpenForListing(restaurant('b', { isAcceptingOrders: false }), NOON),
        false,
        'the offline toggle closes it even inside its hours',
    );

    assert.equal(
        isRestaurantOpenForListing(
            restaurant('c', { outletTimings: everyDay({ isOpen: true, openingTime: '18:00', closingTime: '23:00' }) }),
            NOON,
        ),
        false,
        'outside its hours it is closed',
    );

    assert.equal(
        isRestaurantOpenForListing(restaurant('d', { outletTimings: everyDay({ isOpen: false }) }), NOON),
        false,
        'a day marked closed is closed',
    );

    assert.equal(
        isRestaurantOpenForListing(
            restaurant('e', { outletTimings: everyDay({ isOpen: true, openingTime: '20:00', closingTime: '13:00' }) }),
            NOON,
        ),
        true,
        'a window across midnight still covers the morning after',
    );
});

test('closed restaurants go last, and each group keeps its order', () => {
    const late = { outletTimings: everyDay({ isOpen: true, openingTime: '18:00', closingTime: '23:00' }) };
    const list = [
        restaurant('closed-1', { isAcceptingOrders: false }),
        restaurant('open-1'),
        restaurant('closed-2', late),
        restaurant('open-2'),
        restaurant('open-3'),
    ];

    const ids = sortOpenRestaurantsFirst(list, NOON).map((r) => r.id);
    assert.deepEqual(ids, ['open-1', 'open-2', 'open-3', 'closed-1', 'closed-2']);
});

test('nothing to sort is not an error', () => {
    assert.deepEqual(sortOpenRestaurantsFirst([], NOON), []);
    assert.deepEqual(sortOpenRestaurantsFirst(undefined, NOON), []);
    assert.deepEqual(sortOpenRestaurantsFirst(null, NOON), []);
});
