import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * Appending the coupon code to a campaign message.
 *
 * Mirrors withCouponCode in notificationBroadcast.service.js. A campaign that
 * attaches a coupon but never names it leaves the customer with a discount they
 * cannot find; repeating a code the admin already wrote reads as a mistake.
 */
const withCouponCode = (message, code) => {
    const trimmed = String(message || '').trim();
    const couponCode = String(code || '').trim();
    if (!couponCode) return trimmed;

    const simple = /^[A-Z0-9_-]+$/i.test(couponCode);
    const mentioned = simple
        ? new RegExp(`\\b${couponCode}\\b`, 'i').test(trimmed)
        : trimmed.toUpperCase().includes(couponCode.toUpperCase());
    if (mentioned) return trimmed;

    return `${trimmed}\n\nUse code ${couponCode}`;
};

test('the code is appended when the message does not mention it', () => {
    assert.equal(
        withCouponCode('We miss you! Here is 25% off.', 'WINBACK25'),
        'We miss you! Here is 25% off.\n\nUse code WINBACK25',
    );
});

test('a code the admin already wrote is not repeated', () => {
    const message = 'We miss you! Use WINBACK25 for 25% off.';
    assert.equal(withCouponCode(message, 'WINBACK25'), message);
});

test('the check is case-insensitive', () => {
    // An admin typing the code in lowercase still counts as having mentioned it.
    const message = 'Come back and use winback25 today.';
    assert.equal(withCouponCode(message, 'WINBACK25'), message);
});

test('no coupon leaves the message untouched', () => {
    assert.equal(withCouponCode('Just a message.', ''), 'Just a message.');
    assert.equal(withCouponCode('Just a message.', null), 'Just a message.');
    assert.equal(withCouponCode('Just a message.', undefined), 'Just a message.');
});

test('a code inside a longer word does not count as mentioned', () => {
    // "SAVE10" appearing inside "SAVE100" is a different code, so SAVE10 still
    // needs appending.
    const out = withCouponCode('Use SAVE100 on groceries.', 'SAVE10');
    assert.ok(out.endsWith('Use code SAVE10'));
});

test('a numeric code is matched on a word boundary, not anywhere', () => {
    // 499 is a real coupon code here, and "₹499" in the text is the same token,
    // so it counts as mentioned.
    assert.equal(withCouponCode('Orders over 499 ship free.', '499'), 'Orders over 499 ship free.');
    // But not when it is part of a larger number.
    assert.ok(withCouponCode('Save on 4990 items.', '499').endsWith('Use code 499'));
});

test('surrounding whitespace is trimmed before appending', () => {
    assert.equal(
        withCouponCode('   Hello there.   ', 'CODE1'),
        'Hello there.\n\nUse code CODE1',
    );
});

test('a code with regex characters does not blow up the match', () => {
    // The validator uppercases and should not produce these, but building a
    // pattern out of unchecked input is how a crash gets in.
    const out = withCouponCode('Nothing here.', 'A+B(C)');
    assert.ok(out.endsWith('Use code A+B(C)'));
});
