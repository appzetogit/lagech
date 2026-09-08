import test from 'node:test';
import assert from 'node:assert/strict';

import { validateFeeSettingsUpsertDto } from './feeSettings.validator.js';

/**
 * Bounds on the fee settings.
 *
 * These numbers are multiplied into the price of every order, so a value that
 * gets through here is not a cosmetic problem: a GST rate of thirteen billion
 * percent prices the whole catalogue out of reach until somebody notices.
 */

const rejects = (body) => {
    try {
        validateFeeSettingsUpsertDto(body);
        return null;
    } catch (err) {
        return err.message;
    }
};

test('a percentage above 100 is refused', () => {
    for (const field of ['gstRate', 'deliveryFeeGstRate']) {
        assert.match(rejects({ [field]: '13123123123' }) || '', /more than 100%/, field);
        assert.match(rejects({ [field]: '101' }) || '', /more than 100%/, field);
    }
});

test('exponent notation is refused rather than becoming Infinity', () => {
    // A number input accepts "e", so this is what the box actually produced.
    // Number() turns it into Infinity, which passes a bare min(0) -- on the
    // money fields, which had no ceiling, it was being stored.
    assert.ok(rejects({ gstRate: '102020202020e233' }));
    assert.ok(rejects({ platformFee: '102020202020e233' }));
    assert.ok(rejects({ quickDeliveryFee: '1e400' }));
    assert.ok(rejects({ deliveryFee: '-1e400' }));
});

test('the money fields have a ceiling at all', () => {
    // They were min(0) and nothing else.
    assert.match(rejects({ platformFee: '13123123123' }) || '', /Platform fee/);
    assert.match(rejects({ quickDeliveryFee: '13123123123' }) || '', /Quick delivery extra/);
});

test('a negative fee is refused', () => {
    assert.match(rejects({ platformFee: '-1' }) || '', /cannot be negative/);
    assert.match(rejects({ gstRate: '-0.5' }) || '', /cannot be negative/);
});

test('text that is not a number is refused', () => {
    assert.ok(rejects({ gstRate: 'eighteen' }));
    assert.ok(rejects({ platformFee: 'abc' }));
});

test('the message names the field the admin has to go and fix', () => {
    // The panel shows the first error verbatim, so "Number must be less than or
    // equal to 100" would leave four boxes to guess between.
    assert.match(rejects({ gstRate: '200' }) || '', /GST rate/);
    assert.match(rejects({ deliveryFeeGstRate: '200' }) || '', /Delivery fee GST rate/);
    assert.match(rejects({ platformFee: '1e9' }) || '', /Platform fee/);
});

test('ordinary settings still go through', () => {
    const out = validateFeeSettingsUpsertDto({
        platformFee: '8',
        quickDeliveryFee: '15',
        gstRate: '18',
        deliveryFeeGstRate: '5',
    });
    assert.deepEqual(out.platformFee, 8);
    assert.deepEqual(out.gstRate, 18);
});

test('the ends of the allowed range are allowed', () => {
    const out = validateFeeSettingsUpsertDto({ gstRate: '100', deliveryFeeGstRate: '0' });
    assert.equal(out.gstRate, 100);
    assert.equal(out.deliveryFeeGstRate, 0);
});

test('an omitted or cleared field is left alone', () => {
    // Blank means "do not change this", not zero.
    assert.equal(validateFeeSettingsUpsertDto({}).gstRate, undefined);
    assert.equal(validateFeeSettingsUpsertDto({ gstRate: null }).gstRate, null);
});

test('a range carrying a runaway number is refused', () => {
    assert.ok(rejects({ deliveryFeeRanges: [{ min: '0', max: '1e400', fee: '20' }] }));
    assert.match(
        rejects({ deliveryFeeRanges: [{ min: '0', max: '5', fee: '13123123123' }] }) || '',
        /Range delivery fee/,
    );
});

test('the range rules that already existed still hold', () => {
    assert.match(
        rejects({ deliveryFeeRanges: [{ min: '5', max: '5', fee: '20' }] }) || '',
        /min less than max/,
    );
    assert.match(
        rejects({
            deliveryFeeRanges: [
                { min: '0', max: '5', fee: '20' },
                { min: '3', max: '8', fee: '30' },
            ],
        }) || '',
        /must not overlap/,
    );
});
