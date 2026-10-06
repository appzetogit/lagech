import test from 'node:test';
import assert from 'node:assert/strict';

import { campaignPrice, campaignState, discountErrors, scheduleErrors } from './campaignSchedule.js';

const now = new Date('2026-10-06T12:00:00Z');
const hour = 60 * 60 * 1000;

test('a campaign runs only while switched on and between its start and end', () => {
    const base = { isActive: true, startsAt: new Date(+now - hour), endsAt: new Date(+now + hour) };
    assert.equal(campaignState(base, now), 'running');
    assert.equal(campaignState({ ...base, startsAt: new Date(+now + 1) }, now), 'scheduled');
    assert.equal(campaignState({ ...base, endsAt: new Date(+now - 1) }, now), 'expired');
    assert.equal(campaignState({ ...base, isActive: false }, now), 'off');
    assert.equal(campaignState({ ...base, endsAt: now }, now), 'running', 'the last moment still counts');
});

test('the schedule needs both ends, in order', () => {
    assert.deepEqual(scheduleErrors('2026-10-06T10:00', '2026-10-07T10:00'), []);
    assert.deepEqual(scheduleErrors('', 'nonsense'), ['Start date and time are required', 'End date and time are required']);
    assert.deepEqual(scheduleErrors('2026-10-07T10:00', '2026-10-07T10:00'), ['The campaign must end after it starts']);
});

test('food campaign discounts stay within the price', () => {
    assert.deepEqual(discountErrors(200, 'percent', 20), []);
    assert.deepEqual(discountErrors(200, 'amount', 0), []);
    assert.deepEqual(discountErrors(0, 'percent', 0), ['Price must be more than 0']);
    assert.deepEqual(discountErrors(200, 'percent', 120), ['A percentage discount cannot be more than 100']);
    assert.deepEqual(discountErrors(200, 'amount', 250), ['The discount cannot be more than the price']);
    assert.deepEqual(discountErrors(200, 'flat', 5), ['Discount type must be percent or amount']);
    assert.equal(campaignPrice(199, 'percent', 15), 169.15);
    assert.equal(campaignPrice(199, 'amount', 50), 149);
    assert.equal(campaignPrice('120.50', 'percent', 0), 120.5);
});
