import test from 'node:test';
import assert from 'node:assert/strict';
import { displayName } from './restaurantReviews.service.js';

test('reviewer names show first name and last initial only', () => {
    assert.equal(displayName('akshat kaushal'), 'Akshat K.');
    assert.equal(displayName('  Neha  '), 'Neha');
    assert.equal(displayName('Ravi Kumar Sharma'), 'Ravi S.');
    assert.equal(displayName(''), 'Customer');
    assert.equal(displayName(null), 'Customer');
});
