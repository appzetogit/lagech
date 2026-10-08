import test from 'node:test';
import assert from 'node:assert/strict';

import { createHeadingStore, normalizeHeading } from './riderHeading.js';

/**
 * The live-tracking heading: a ping without one keeps the order's last known
 * heading instead of snapping the customer's bike icon to north.
 */

test('only a real number of degrees counts as a heading', () => {
    assert.equal(normalizeHeading(90), 90);
    assert.equal(normalizeHeading('45.5'), 45.5);
    assert.equal(normalizeHeading(0), 0, 'north is a heading too');
    assert.equal(normalizeHeading(360), 0);
    assert.equal(normalizeHeading(725), 5);

    for (const missing of [undefined, null, '', '  ', 'abc', NaN, Infinity, -1, true]) {
        assert.equal(normalizeHeading(missing), null, `${String(missing)} is no heading`);
    }
});

test('a missing heading reuses the last one for that order', async () => {
    const store = createHeadingStore();

    assert.deepEqual(await store.resolve('o1', 120), { heading: 120, headingFromDevice: true });
    assert.deepEqual(await store.resolve('o1', undefined), { heading: 120, headingFromDevice: false });
    assert.deepEqual(await store.resolve('o1', null), { heading: 120, headingFromDevice: false });
    assert.deepEqual(await store.resolve('o1', -1), { heading: 120, headingFromDevice: false });

    // A new heading replaces it.
    assert.deepEqual(await store.resolve('o1', 200), { heading: 200, headingFromDevice: true });
    assert.deepEqual(await store.resolve('o1'), { heading: 200, headingFromDevice: false });

    // Orders do not share headings; one with none yet starts at 0.
    assert.deepEqual(await store.resolve('o2'), { heading: 0, headingFromDevice: false });
    assert.equal(store.get('o2'), null, 'a fallback 0 is not remembered as a heading');
});

test('a heading goes stale after the quiet spell', async () => {
    let clock = 1_000;
    const store = createHeadingStore({ now: () => clock, ttlMs: 60_000 });

    await store.resolve('o1', 75);
    clock += 59_000;
    assert.equal((await store.resolve('o1')).heading, 75);
    clock += 61_000;
    assert.equal((await store.resolve('o1')).heading, 0);
});

test('memory is capped, oldest first', async () => {
    const store = createHeadingStore({ maxEntries: 2 });
    await store.resolve('a', 10);
    await store.resolve('b', 20);
    await store.resolve('c', 30);
    assert.equal(store.size(), 2);
    assert.equal(store.get('a'), null);
    assert.equal(store.get('c'), 30);
});

test('Redis backs memory up, e.g. after a restart or on another process', async () => {
    const hash = new Map();
    const redis = {
        hSet: async (_key, field, value) => { hash.set(field, value); },
        hGet: async (_key, field) => hash.get(field) ?? null,
    };

    await createHeadingStore().resolve('o9', 33, { redis });
    assert.equal(hash.get('o9'), '33');

    // A fresh process has nothing in memory, and finds it in Redis.
    const other = createHeadingStore();
    assert.deepEqual(await other.resolve('o9', undefined, { redis }), { heading: 33, headingFromDevice: false });

    // A broken Redis never breaks the ping.
    const broken = { hSet: async () => { throw new Error('down'); }, hGet: async () => { throw new Error('down'); } };
    assert.deepEqual(await createHeadingStore().resolve('o9', undefined, { redis: broken }), { heading: 0, headingFromDevice: false });
    assert.deepEqual(await createHeadingStore().resolve('o9', 10, { redis: broken }), { heading: 10, headingFromDevice: true });
});
