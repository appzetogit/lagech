import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeFacts, nutritionFields, serializeNutrition, MAX_FACTS } from './nutrition.util.js';

test('nutrition facts keep their wording but lose stray spaces and repeats', () => {
    assert.deepEqual(normalizeFacts('  Calories  250 kcal, high protein,High Protein ,, '), ['Calories 250 kcal', 'high protein']);
    assert.deepEqual(normalizeFacts(['Vitamin B12', '', null, 'vitamin b12']), ['Vitamin B12']);
    assert.deepEqual(normalizeFacts(null), []);
    assert.equal(normalizeFacts(Array.from({ length: 50 }, (_, i) => `fact ${i}`)).length, MAX_FACTS);
    assert.equal(normalizeFacts(['x'.repeat(100)])[0].length, 60);
});

test('only the fields a body mentions are written, and both always read as arrays', () => {
    assert.deepEqual(nutritionFields({ name: 'Dal' }), {});
    assert.deepEqual(nutritionFields({ allergens: 'Peanuts, Gluten' }), { allergens: ['Peanuts', 'Gluten'] });
    assert.deepEqual(nutritionFields({ nutrition: [] }), { nutrition: [] });
    assert.deepEqual(serializeNutrition({ nutrition: null }), { nutrition: [], allergens: [] });
});
