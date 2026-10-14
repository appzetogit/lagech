import test from 'node:test';
import assert from 'node:assert/strict';

import { readFaqInput, readFaqOrder, normalizeAudience, faqsForAudience } from './faq.helpers.js';

/** FAQ input and the public filter, without a database. */

test('audiences: the three here, old spellings, blank or all for everyone', () => {
    assert.equal(normalizeAudience('Customer'), 'customer');
    assert.equal(normalizeAudience('vendor'), 'restaurant');
    assert.equal(normalizeAudience('deliveryman'), 'rider');
    assert.equal(normalizeAudience(''), null);
    assert.equal(normalizeAudience('all'), null);
    assert.equal(normalizeAudience(null), null);
    assert.equal(normalizeAudience('martian'), undefined);
});

test('input: question and answer required and trimmed; edits take only what is sent', () => {
    assert.deepEqual(readFaqInput({ question: '  How   do I pay? ', answer: ' UPI or cash. ', audience: 'customer' }), {
        question: 'How do I pay?', answer: 'UPI or cash.', audience: 'customer', isActive: true,
    });
    assert.throws(() => readFaqInput({ question: '', answer: 'x' }), /Question is required/);
    assert.throws(() => readFaqInput({ question: 'q', answer: ' ' }), /Answer is required/);
    assert.throws(() => readFaqInput({ question: 'q'.repeat(256), answer: 'x' }), /at most 255/);
    assert.throws(() => readFaqInput({ question: 'q', answer: 'a', audience: 'martian' }), /Audience/);
    assert.deepEqual(readFaqInput({ isActive: 'false' }, { partial: true }), { isActive: false });
    assert.deepEqual(readFaqInput({ audience: '' }, { partial: true }), { audience: null });
    assert.deepEqual(readFaqInput({ sortOrder: '-4' }, { partial: true }), { sortOrder: 0 });
});

test('reorder: every id once', () => {
    const a = 'a'.repeat(24);
    const b = 'b'.repeat(24);
    assert.deepEqual(readFaqOrder({ ids: [b, a] }), [b, a]);
    assert.throws(() => readFaqOrder({ ids: [] }), /new order/);
    assert.throws(() => readFaqOrder({ ids: [a, a] }), /twice/);
    assert.throws(() => readFaqOrder({ ids: ['x'] }), /Invalid/);
});

test('public filter: active only, the audience plus everyone, in order', () => {
    const rows = [
        { id: '1', audience: 'customer', isActive: true, sortOrder: 2 },
        { id: '2', audience: null, isActive: true, sortOrder: 1 },
        { id: '3', audience: 'restaurant', isActive: true, sortOrder: 0 },
        { id: '4', audience: 'customer', isActive: false, sortOrder: 0 },
    ];
    assert.deepEqual(faqsForAudience(rows, 'customer').map((r) => r.id), ['2', '1']);
    assert.deepEqual(faqsForAudience(rows, 'restaurant').map((r) => r.id), ['3', '2']);
    assert.deepEqual(faqsForAudience(rows, 'rider').map((r) => r.id), ['2']);
    assert.deepEqual(faqsForAudience(rows, null).map((r) => r.id), ['3', '2', '1']);
});
