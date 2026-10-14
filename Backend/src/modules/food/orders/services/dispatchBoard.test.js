import test from 'node:test';
import assert from 'node:assert/strict';

import { dispatchBoardOrderQueries } from './dispatchBoardQueries.js';

test('the dispatch board lists both columns newest first, so a new order lands on top', () => {
    const { waiting, onTheWay } = dispatchBoardOrderQueries();
    assert.deepEqual(waiting.orderBy, { createdAt: 'desc' });
    assert.deepEqual(onTheWay.orderBy, { createdAt: 'desc' });
});

test('the waiting column holds back a scheduled order until its release time', () => {
    const now = new Date('2026-10-14T10:00:00Z');
    const { waiting } = dispatchBoardOrderQueries(now);
    assert.deepEqual(waiting.where.OR, [{ releaseAt: null }, { releaseAt: { lte: now } }]);
    assert.deepEqual(waiting.where.orderType, { not: 'takeaway' });
});
