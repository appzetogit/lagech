import test from 'node:test';
import assert from 'node:assert/strict';

import {
    computeRestaurantCommissionAmount,
    sumItemCommissions,
} from './foodTransaction.service.js';

/**
 * Dish-based commission arithmetic.
 *
 * These stay pure on purpose: the lookups around them need a database, but the
 * sum is what decides how much a restaurant is billed on every order, so it
 * should be checkable without one.
 */

const pct = (value) => ({ commissionType: 'percentage', commissionValue: value });
const flat = (value) => ({ commissionType: 'amount', commissionValue: value });

const rules = (entries) => new Map(entries);

test('each line is charged at its own rate', () => {
    const lines = [
        { itemId: 'a', price: 100, quantity: 2 }, // 200 @ 10% = 20
        { itemId: 'b', price: 50, quantity: 1 }, //  50 @ 20% = 10
    ];
    const perItem = rules([['a', pct(10)], ['b', pct(20)]]);

    assert.equal(sumItemCommissions(lines, perItem, null), 30);
});

test('a dish with no rate of its own falls back to the restaurant rate', () => {
    const lines = [
        { itemId: 'a', price: 100, quantity: 1 }, // own rate 10% = 10
        { itemId: 'b', price: 100, quantity: 1 }, // fallback 5%  =  5
    ];
    const perItem = rules([['a', pct(10)]]);

    assert.equal(sumItemCommissions(lines, perItem, pct(5)), 15);
});

test('a dish with no rate and no restaurant fallback earns nothing', () => {
    // Not the restaurant's other dishes' rate, and not an error either: the
    // line simply carries no commission.
    const lines = [{ itemId: 'unpriced', price: 100, quantity: 1 }];

    assert.equal(sumItemCommissions(lines, rules([]), null), 0);
});

test('flat per-dish amounts are charged once per line, not per unit', () => {
    // A flat rate is a fee on the line, so quantity does not multiply it --
    // computeRestaurantCommissionAmount returns the value as-is for 'amount'.
    const lines = [{ itemId: 'a', price: 100, quantity: 3 }];

    assert.equal(sumItemCommissions(lines, rules([['a', flat(15)]]), null), 15);
});

test('commission never exceeds the order it is charged against', () => {
    // A misconfigured 200% rate must not bill more than the order was worth.
    const lines = [{ itemId: 'a', price: 100, quantity: 1 }];

    assert.equal(sumItemCommissions(lines, rules([['a', pct(200)]]), null, 100), 100);
});

test('rounds to paise, not to a floating point tail', () => {
    // 33.33% of 100 twice is 66.66, not 66.66000000000001.
    const lines = [
        { itemId: 'a', price: 100, quantity: 1 },
        { itemId: 'b', price: 100, quantity: 1 },
    ];
    const perItem = rules([['a', pct(33.33)], ['b', pct(33.33)]]);

    assert.equal(sumItemCommissions(lines, perItem, null), 66.66);
});

test('an empty order carries no commission', () => {
    assert.equal(sumItemCommissions([], rules([]), pct(10)), 0);
});

test('a single rate against the subtotal is unchanged', () => {
    // The overall mode is the pre-existing behaviour and must stay exact.
    const { commissionAmount } = computeRestaurantCommissionAmount(180, pct(20));
    assert.equal(commissionAmount, 36);
});
