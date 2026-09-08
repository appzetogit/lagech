import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * Who may redeem a customer-specific coupon.
 *
 * Mirrors the audience check in order-pricing.service.js. Kept pure here so the
 * rule can be checked without a database: getting it wrong either hands a
 * targeted discount to everyone who learns the code, or refuses it to the
 * customer it was issued to.
 */
const canRedeem = (offer, userId) => {
    if (offer?.customerScope !== 'specific') return true;
    const allowList = Array.isArray(offer.customerIds) ? offer.customerIds.map(String) : [];
    const isId = (v) => typeof v === 'string' && /^[0-9a-f]{24}$/i.test(v);
    return isId(userId) && allowList.includes(String(userId));
};

const ALICE = 'a'.repeat(24);
const BOB = 'b'.repeat(24);

test('a targeted coupon works for a customer on the list', () => {
    const offer = { customerScope: 'specific', customerIds: [ALICE, BOB] };
    assert.equal(canRedeem(offer, ALICE), true);
});

test('and is refused to everyone else, code or no code', () => {
    // The whole point: knowing the code is not the same as being entitled to it.
    const offer = { customerScope: 'specific', customerIds: [ALICE] };
    assert.equal(canRedeem(offer, BOB), false);
});

test('an anonymous cart cannot redeem a targeted coupon', () => {
    // With no signed-in user there is nobody to match against the list, so the
    // safe answer is no rather than "the list is empty, allow it".
    const offer = { customerScope: 'specific', customerIds: [ALICE] };
    assert.equal(canRedeem(offer, undefined), false);
    assert.equal(canRedeem(offer, null), false);
    assert.equal(canRedeem(offer, ''), false);
});

test('an empty allow-list lets nobody in', () => {
    // The validator refuses to create one of these, but a coupon predating the
    // feature has customerIds [] -- it must not fall open.
    const offer = { customerScope: 'specific', customerIds: [] };
    assert.equal(canRedeem(offer, ALICE), false);
});

test('a missing customerIds field lets nobody in either', () => {
    const offer = { customerScope: 'specific' };
    assert.equal(canRedeem(offer, ALICE), false);
});

test('ordinary coupons are unaffected', () => {
    // Every coupon that existed before this feature has scope 'all', and must
    // keep working for everyone including anonymous carts.
    assert.equal(canRedeem({ customerScope: 'all', customerIds: [] }, ALICE), true);
    assert.equal(canRedeem({ customerScope: 'all' }, undefined), true);
    assert.equal(canRedeem({ customerScope: 'first_time' }, BOB), true);
});

test('a malformed user id is not accepted as a match', () => {
    // Guards against a caller passing something that stringifies into the list
    // by accident.
    const offer = { customerScope: 'specific', customerIds: ['not-an-id'] };
    assert.equal(canRedeem(offer, 'not-an-id'), false);
});
