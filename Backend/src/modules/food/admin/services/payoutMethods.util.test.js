import test from 'node:test';
import assert from 'node:assert/strict';

import {
    normalizeMethodFields,
    validatePayoutValues,
    payoutSnapshot,
    fieldFromLegacy,
    fieldKeyFrom,
} from './payoutMethods.util.js';

test('fields get a key from their label, and keep a key they already have', () => {
    const fields = normalizeMethodFields([
        { label: 'Account holder name', required: true },
        { label: 'IFSC', key: 'ifsc_code', type: 'text', placeholder: ' e.g. bank code ' },
        { label: 'Account number', type: 'number', required: 'true' },
    ]);
    assert.deepEqual(fields.map((f) => f.key), ['account_holder_name', 'ifsc_code', 'account_number']);
    assert.equal(fields[0].required, true);
    assert.equal(fields[1].required, false);
    assert.equal(fields[1].placeholder, 'e.g. bank code');
    assert.equal(fields[2].required, true);
});

test('a method needs at least one field, each with a label and a known type', () => {
    assert.throws(() => normalizeMethodFields([]), /at least one field/);
    assert.throws(() => normalizeMethodFields([{ label: '' }]), /needs a label/);
    assert.throws(() => normalizeMethodFields([{ label: 'A', type: 'date' }]), /unknown type/);
});

test('two fields that would share a storage key are refused', () => {
    assert.throws(
        () => normalizeMethodFields([{ label: 'UPI id' }, { label: 'UPI-id' }]),
        /both be stored as "upi_id"/,
    );
});

test('payee values: required, number and email rules, all problems at once', () => {
    const fields = normalizeMethodFields([
        { label: 'Account number', type: 'number', required: true },
        { label: 'Email', type: 'email' },
        { label: 'Holder', required: true },
    ]);
    assert.throws(
        () => validatePayoutValues(fields, { account_number: '12a', email: 'nope' }),
        (error) => /must be a number/.test(error.message)
            && /must be an email address/.test(error.message)
            && /Holder is required/.test(error.message),
    );
});

test('payee values keep leading zeros, drop blanks and unknown keys', () => {
    const fields = normalizeMethodFields([
        { label: 'Account number', type: 'number', required: true },
        { label: 'Branch' },
    ]);
    const clean = validatePayoutValues(fields, { account_number: ' 00123 ', branch: '  ', other: 'x' });
    assert.deepEqual(clean, { account_number: '00123' });
});

test('a snapshot lists only the filled fields, with their labels', () => {
    const method = {
        id: 'm1',
        name: 'Bank transfer',
        fields: normalizeMethodFields([{ label: 'Account number' }, { label: 'Branch' }]),
    };
    assert.deepEqual(payoutSnapshot(method, { account_number: '42' }), {
        methodId: 'm1',
        methodName: 'Bank transfer',
        fields: [{ key: 'account_number', label: 'Account number', value: '42' }],
    });
    assert.equal(payoutSnapshot(null, {}), null);
});

test('legacy method fields map onto ours', () => {
    assert.deepEqual(
        fieldFromLegacy({ input_type: 'number', input_name: 'account_number', placeholder: 'Account no', is_required: 1 }),
        { key: 'account_number', label: 'Account number', type: 'number', required: true, placeholder: 'Account no' },
    );
    assert.equal(fieldFromLegacy({ input_type: 'phone', input_name: 'phone' }).type, 'text');
    assert.equal(fieldFromLegacy({ input_type: 'email', input_name: 'mail', is_required: 0 }).required, false);
    assert.equal(fieldKeyFrom('IFSC Code'), 'ifsc_code');
});
