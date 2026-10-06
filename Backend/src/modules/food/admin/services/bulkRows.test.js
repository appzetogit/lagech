import test from 'node:test';
import assert from 'node:assert/strict';

import {
    CATEGORY_COLUMNS,
    ADDON_COLUMNS,
    RESTAURANT_COLUMNS,
    RESTAURANT_EXPORT_COLUMNS,
    validateCategoryRow,
    validateAddonRow,
    validateRestaurantRow,
    categoryExportRow,
    addonExportRow,
    restaurantExportRow,
    phoneKey,
} from './bulkRows.js';
import { parseCsv, rowsToRecords, toCsv, missingHeaders, headerKey } from '../../shared/sheet.util.js';

/** A record as the sheet reader produces it, from header -> value pairs. */
const rec = (pairs) => Object.fromEntries(Object.entries(pairs).map(([k, v]) => [headerKey(k), v]));

test('CSV parsing handles quotes, commas, newlines and the Excel BOM', () => {
    const rows = parseCsv('﻿Name*,Note\r\n"Rolls, wraps","He said ""hi""\nthen left"\r\nDal,\n');
    assert.deepEqual(rows, [['Name*', 'Note'], ['Rolls, wraps', 'He said "hi"\nthen left'], ['Dal', '']]);
    const { headers, records } = rowsToRecords([...rows, ['', ''], ["'+919876543210", 'x']]);
    assert.deepEqual(headers, ['name', 'note']);
    assert.equal(records.length, 3, 'blank rows are dropped');
    assert.equal(records[2].row, 5, 'row numbers count the header and blank rows');
    assert.equal(records[2].data.name, '+919876543210', 'the leading apostrophe Excel adds is not data');
    assert.deepEqual(missingHeaders(headers, ['Name*', 'Price*']), ['Price*']);
});

test('CSV writing quotes what needs it and defuses formulas but not phone numbers', () => {
    const csv = toCsv(['A', 'B'], [['x,y', '=SUM(A1)'], ['+91 98765 43210', -5]]);
    assert.ok(csv.startsWith('﻿A,B\r\n'));
    assert.ok(csv.includes('"x,y",\'=SUM(A1)'));
    assert.ok(csv.includes('+91 98765 43210,-5'));
    // What is written reads back the same.
    const [, first] = parseCsv(csv);
    assert.deepEqual(first, ['x,y', "'=SUM(A1)"]);
});

test('category rows: name required, food type and yes/no checked, every error reported', () => {
    const ok = validateCategoryRow(rec({ 'Name*': 'Starters', 'Food Type (Veg/Non-Veg/Both)': 'non-veg', 'Sort Order': '3', 'Active (Yes/No)': 'no' }));
    assert.deepEqual(ok.value, {
        id: null, name: 'Starters', parentName: '', zoneName: '', image: '', foodTypeScope: 'Non-Veg', sortOrder: 3, isActive: false,
    });
    const bad = validateCategoryRow(rec({ Id: '123', 'Food Type (Veg/Non-Veg/Both)': 'fish', 'Sort Order': '1.5', 'Active (Yes/No)': 'maybe', 'Image URL': 'ftp://x' }));
    assert.equal(bad.errors.length, 6);
    assert.ok(bad.errors.includes('Name is required'));
    assert.equal(categoryExportRow({ id: 'a', name: 'N', foodTypeScope: 'NonVeg', isActive: true, sortOrder: 2 }).length, CATEGORY_COLUMNS.length);
});

test('add-on rows need a restaurant id, a name and a price', () => {
    const rid = 'a'.repeat(24);
    const ok = validateAddonRow(rec({ 'Restaurant Id*': rid, 'Name*': 'Extra cheese', 'Price*': '30', 'Food Type (Veg/Non-Veg)': 'Non Veg' }));
    assert.equal(ok.value.price, 30);
    assert.equal(ok.value.foodType, 'non-veg');
    assert.equal(ok.value.isAvailable, true);
    const bad = validateAddonRow(rec({ 'Restaurant Id*': 'nope', 'Price*': '-1' }));
    assert.deepEqual(bad.errors, ['Restaurant Id is not a valid id', 'Name is required', 'Price must be a number of 0 or more']);
    const zero = validateAddonRow(rec({ 'Restaurant Id*': rid, 'Name*': 'Free dip', 'Price*': '0' }));
    assert.equal(zero.value.price, 0, 'a free add-on is allowed');
    assert.equal(addonExportRow({ id: 'x', restaurantId: rid, draft: { name: 'n', price: '5' } }).length, ADDON_COLUMNS.length);
});

test('restaurant rows need the same fields as adding a restaurant by hand', () => {
    const ok = validateRestaurantRow(rec({
        'Restaurant Name*': 'Spice Hub', 'Owner Name*': 'Asha', 'Owner Phone*': '+91 98765-43210',
        Latitude: '28.6', Longitude: '77.2', Cuisines: 'North Indian, Chinese,',
        'Opening Time (HH:MM)': '10:00', 'Pure Veg (Yes/No)': 'yes',
    }));
    assert.deepEqual(ok.value.location.latitude, 28.6);
    assert.deepEqual(ok.value.cuisines, ['North Indian', 'Chinese']);
    assert.equal(ok.value.openingTime, '10:00');
    assert.equal(ok.value.closingTime, undefined, 'blank closing time falls back to the default on create');
    assert.equal(ok.value.pureVegRestaurant, true);

    const bad = validateRestaurantRow(rec({ 'Owner Phone*': '12345', Latitude: '95', 'Closing Time (HH:MM)': '25:00', 'Owner Email': 'x@' }));
    assert.ok(bad.errors.includes('Restaurant Name is required'));
    assert.ok(bad.errors.includes('Owner Name is required'));
    assert.ok(bad.errors.includes('Owner Phone must be a phone number of at least 10 digits'));
    assert.ok(bad.errors.includes('Latitude must be between -90 and 90'));
    assert.ok(bad.errors.includes('Closing Time must be HH:MM (24-hour)'));
    assert.ok(bad.errors.includes('Owner Email is not an email address'));

    const half = validateRestaurantRow(rec({ 'Restaurant Name*': 'A', 'Owner Name*': 'B', 'Owner Phone*': '9876543210', Latitude: '28.6' }));
    assert.deepEqual(half.errors, ['Give both Latitude and Longitude, or neither']);

    assert.equal(phoneKey('+91 98765-43210'), '9876543210');
    assert.equal(restaurantExportRow({ id: 'r', cuisines: [] }).length, RESTAURANT_EXPORT_COLUMNS.length);
    assert.equal(RESTAURANT_EXPORT_COLUMNS.length, RESTAURANT_COLUMNS.length + 5);
});
