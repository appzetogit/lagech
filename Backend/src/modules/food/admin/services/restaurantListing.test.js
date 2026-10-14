import test from 'node:test';
import assert from 'node:assert/strict';

import {
    DISABLED_BY_ADMIN,
    LISTED_RESTAURANT_WHERE,
    LISTED_STATUS,
    restaurantStatusWhere,
    isDisabledByAdmin,
} from './restaurantListing.js';

/**
 * The admin Restaurants list, as the old panel had it: every trading store,
 * whether its switch is on or off, but never a join request.
 */

test('the Restaurants list holds the approved and the ones an admin switched off', () => {
    assert.equal(LISTED_STATUS, 'listed');
    assert.deepEqual(restaurantStatusWhere('listed'), LISTED_RESTAURANT_WHERE);
    assert.deepEqual(LISTED_RESTAURANT_WHERE.OR, [
        { status: 'approved' },
        { status: 'rejected', rejectionReason: DISABLED_BY_ADMIN },
    ]);
});

test('the reason matches what the on/off switch and the legacy importer write', () => {
    assert.equal(DISABLED_BY_ADMIN, 'Disabled by admin');
});

test('the plain statuses still filter on their own, and anything else is no filter', () => {
    assert.deepEqual(restaurantStatusWhere('approved'), { status: 'approved' });
    assert.deepEqual(restaurantStatusWhere('pending'), { status: 'pending' });
    assert.deepEqual(restaurantStatusWhere('rejected'), { status: 'rejected' });
    assert.equal(restaurantStatusWhere(undefined), null);
    assert.equal(restaurantStatusWhere('all'), null);
});

test('a rejected join request is not a restaurant switched off', () => {
    assert.equal(isDisabledByAdmin({ status: 'rejected', rejectionReason: DISABLED_BY_ADMIN }), true);
    assert.equal(isDisabledByAdmin({ status: 'rejected', rejectionReason: 'FSSAI licence missing' }), false);
    assert.equal(isDisabledByAdmin({ status: 'rejected', rejectionReason: null }), false);
    assert.equal(isDisabledByAdmin({ status: 'approved', rejectionReason: DISABLED_BY_ADMIN }), false);
    assert.equal(isDisabledByAdmin(null), false);
});
