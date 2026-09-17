import test from 'node:test';
import assert from 'node:assert/strict';

import { applyFeeSwitches, isFeeSwitchOn } from './feeSwitches.js';

const rates = { gstRate: 5, deliveryFeeGstRate: 18, platformFee: 10, deliveryFee: 30 };

test('every charge is off until the admin switches it on', () => {
    // The previous system charged none of these; a saved rate alone must not start charging.
    const priced = applyFeeSwitches({ ...rates });
    assert.equal(priced.gstRate, 0);
    assert.equal(priced.deliveryFeeGstRate, 0);
    assert.equal(priced.platformFee, 0);
    assert.equal(priced.gstEnabled, false);
});

test('a switched-on charge keeps its rate, and other fields are untouched', () => {
    const priced = applyFeeSwitches({ ...rates, gstEnabled: true, platformFeeEnabled: false });
    assert.equal(priced.gstRate, 5);
    assert.equal(priced.platformFee, 0);
    assert.equal(priced.deliveryFee, 30, 'the delivery fee has no switch');
});

test("a zone's unset switch follows the default row; its own setting wins", () => {
    const fallback = { gstEnabled: true, platformFeeEnabled: true };
    const zone = { ...rates, gstEnabled: null, platformFeeEnabled: false };
    const priced = applyFeeSwitches(zone, fallback);
    assert.equal(priced.gstRate, 5, 'inherited on');
    assert.equal(priced.platformFee, 0, 'zone switched it off');
    assert.equal(priced.deliveryFeeGstRate, 0, 'off on both');
});

test('only a real true counts as on', () => {
    assert.equal(isFeeSwitchOn({ gstEnabled: 'true' }, 'gstEnabled'), false);
    assert.equal(isFeeSwitchOn({}, 'gstEnabled', { gstEnabled: 1 }), false);
    assert.equal(applyFeeSwitches(null), null);
});
