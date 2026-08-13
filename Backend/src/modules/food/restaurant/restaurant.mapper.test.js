import test from 'node:test';
import assert from 'node:assert/strict';

import {
    toRestaurant,
    toRestaurantLocation,
    fromRestaurantLocation,
    deriveRestaurantFields,
} from './restaurant.mapper.js';

/**
 * The flat row ⇄ nested `location` translation, checked without a database.
 * Every public restaurant payload and the finance header read location by path,
 * so a wrong shape here is invisible until a client renders a blank address.
 */

const row = {
    id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
    restaurantName: 'Test Kitchen',
    latitude: 22.7196,
    longitude: 75.8577,
    formattedAddress: '12 MG Road, Indore',
    addressLine1: '12 MG Road',
    addressLine2: 'Near Tower',
    area: 'Vijay Nagar',
    city: 'Indore',
    state: 'MP',
    pincode: '452010',
    landmark: 'Opposite park',
};

test('a flat row rebuilds the nested location clients read', () => {
    const loc = toRestaurantLocation(row);
    assert.equal(loc.city, 'Indore');
    assert.equal(loc.formattedAddress, '12 MG Road, Indore');
    // Mongo carried address and formattedAddress as separate keys always written
    // together; both must still resolve.
    assert.equal(loc.address, '12 MG Road, Indore');
    assert.equal(loc.latitude, 22.7196);
    assert.equal(loc.longitude, 75.8577);
});

test('coordinates come back as GeoJSON [lng, lat]', () => {
    const { coordinates } = toRestaurantLocation(row);
    assert.deepEqual(coordinates, [75.8577, 22.7196]);
});

test('a row with no address at all has no location, not an empty one', () => {
    assert.equal(toRestaurantLocation({ id: 'x' }), null);
    assert.equal(toRestaurant({ id: 'x' }).location, null);
});

test('an address without coordinates still produces a location', () => {
    const loc = toRestaurantLocation({ city: 'Indore' });
    assert.equal(loc.city, 'Indore');
    assert.equal(loc.latitude, null);
});

test('pendingLocation only appears once coordinates are proposed', () => {
    assert.equal(toRestaurant(row).pendingLocation, null);
    const withPending = toRestaurant({ ...row, pendingLatitude: 1.5, pendingLongitude: 2.5 });
    assert.deepEqual(withPending.pendingLocation.coordinates, [2.5, 1.5]);
});

test('writing a location flattens it back to columns', () => {
    const data = fromRestaurantLocation({
        latitude: 10, longitude: 20, address: ' 5 Main St ', city: ' Indore ',
    });
    assert.equal(data.latitude, 10);
    assert.equal(data.longitude, 20);
    assert.equal(data.formattedAddress, '5 Main St');
    assert.equal(data.city, 'Indore');
});

test('coordinates win over latitude/longitude, as the Mongoose hook required', () => {
    // The hook treated coordinates as the source of truth and overwrote stale
    // lat/lng from them; the same precedence has to survive the move.
    const data = fromRestaurantLocation({ coordinates: [99, 88], latitude: 1, longitude: 2 });
    assert.equal(data.latitude, 88);
    assert.equal(data.longitude, 99);
});

test('a round trip preserves the address', () => {
    const flattened = fromRestaurantLocation(toRestaurantLocation(row));
    assert.equal(flattened.city, row.city);
    assert.equal(flattened.formattedAddress, row.formattedAddress);
    assert.equal(flattened.latitude, row.latitude);
    assert.equal(flattened.longitude, row.longitude);
});

test('derived fields back the uniqueness constraint', () => {
    const d = deriveRestaurantFields({ restaurantName: '  Test   Kitchen ', ownerPhone: '+91 98765-43210' });
    assert.equal(d.restaurantNameNormalized, 'test kitchen');
    assert.equal(d.ownerPhoneLast10, '9876543210');
    assert.equal(d.ownerPhoneDigits, '919876543210');
});

test('delivery minutes are derived from the human string', () => {
    assert.equal(deriveRestaurantFields({ estimatedDeliveryTime: '25-30 mins' }).estimatedDeliveryTimeMinutes, 25);
    assert.equal(deriveRestaurantFields({ estimatedDeliveryTime: '45' }).estimatedDeliveryTimeMinutes, 45);
    // Nothing numeric means the column is left alone rather than zeroed.
    assert.equal(
        'estimatedDeliveryTimeMinutes' in deriveRestaurantFields({ estimatedDeliveryTime: 'soon' }),
        false,
    );
});
