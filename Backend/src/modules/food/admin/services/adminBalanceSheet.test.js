import test from 'node:test';
import assert from 'node:assert/strict';

import { payoutEntity } from './adminBalanceSheet.service.js';

/**
 * A restaurant paid from the balance sheet kept the same amount in its own
 * balance, so it could be paid again through a withdrawal or the daily payout.
 * Restaurants are paid there instead; this refuses before touching anything.
 */
test('restaurants cannot be paid from the balance sheet', async () => {
    await assert.rejects(
        () => payoutEntity('restaurant', 'a'.repeat(24), { from: '2026-09-01', to: '2026-09-07' }),
        /Restaurant Disbursement/,
    );
});
