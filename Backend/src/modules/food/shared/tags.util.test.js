import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeTag, normalizeTags } from './tags.util.js';

test('tags are tidied into one searchable form', () => {
    assert.deepEqual(
        normalizeTags(['  HealthyFood', 'DietFood', 'Tandoori paneer pizza 🍕', '  momos', 'Momos']),
        ['healthy food', 'diet food', 'tandoori paneer pizza', 'momos'],
    );
    assert.deepEqual(normalizeTags('burger, Burger ,  shake,,'), ['burger', 'shake']);
    assert.equal(normalizeTag('  Healthy   Food '), 'healthy food', 'a search term normalises the same way');
    assert.equal(normalizeTags(Array.from({ length: 20 }, (_, i) => `t${i}`)).length, 10);
});
