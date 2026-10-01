import test from 'node:test';
import assert from 'node:assert/strict';
import { priceCapFor } from './publicFoods.service.js';

test('the ₹99 store means ₹99 or less, not prices containing "99"', () => {
    assert.equal(priceCapFor({ promo: 'switch99' }), 99);
    assert.equal(priceCapFor({ promo: 'under-250' }), 250);
    assert.equal(priceCapFor({ maxPrice: '149' }), 149);
    assert.equal(priceCapFor({ maxPrice: '149', promo: 'switch99' }), 149);
    assert.equal(priceCapFor({}), null);
    assert.equal(priceCapFor({ maxPrice: 'abc' }), null);
    assert.equal(priceCapFor({ maxPrice: '0' }), null);
});
