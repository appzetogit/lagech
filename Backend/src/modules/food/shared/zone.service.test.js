import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveListingZone } from './zone.service.js';

test('an explicit zone id is used as-is, without a lookup', async () => {
    const zone = await resolveListingZone({ zoneId: '7d010b473ebe55298d87df38', lat: '0', lng: '0' });
    assert.deepEqual(zone, { zoneId: '7d010b473ebe55298d87df38', outOfService: false });
});

test('no zone and no coordinates filters nothing', async () => {
    assert.deepEqual(await resolveListingZone({}), { zoneId: null, outOfService: false });
    assert.deepEqual(await resolveListingZone({ lat: '', lng: '' }), { zoneId: null, outOfService: false });
    assert.deepEqual(await resolveListingZone({ lat: 'abc', lng: '75' }), { zoneId: null, outOfService: false });
});
