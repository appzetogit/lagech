import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../src/config/prisma.js';
import { payoutBatchData, payoutLineData } from './balances.mjs';

/**
 * The old store disbursements, on rows shaped like the backup's: a run keeps
 * its number, and a line scheduled but not paid comes over PENDING -- never as
 * paid -- with where it was to be paid.
 */
const R = 'a'.repeat(24);
const B = 'b'.repeat(24);

test.after(() => prisma.$disconnect());

test('a run keeps its old number and status, and never claims a day here', () => {
    const data = payoutBatchData({
        id: 1112, title: 'Disbursement # 1112', total_amount: '6674.200', status: 'pending',
        created_for: 'store', created_at: new Date('2026-10-09T00:56:24Z'),
    }, 15);
    assert.equal(data.legacyNumber, 1112);
    assert.equal(data.runDate, 'L1112', 'not a YYYY-MM-DD, so the run here on that day still happens');
    assert.equal(data.status, 'pending');
    assert.equal(data.totalAmount, 6674.2);
    assert.equal(data.restaurantCount, 15);
    assert.equal(data.triggeredBy, 'legacy');
    assert.equal(payoutBatchData({ id: 1, status: 'weird', total_amount: 0 }, 0).status, 'pending');
});

test('a pending line is a pending payout line, paid to the old method', () => {
    const line = payoutLineData({
        id: 1421, disbursement_id: 1112, store_id: 62, disbursement_amount: '270.300', payment_method: 70,
        status: 'pending', method_name: 'upi payment', method_fields: '{"name":"Owner","upi_id":"owner@upi"}',
        created_at: new Date('2026-10-09T00:56:24Z'), updated_at: new Date('2026-10-09T00:56:24Z'),
    }, R, B);
    assert.equal(line.status, 'pending');
    assert.equal(line.processedAt, null);
    assert.equal(line.source, 'disbursement');
    assert.equal(line.batchId, B);
    assert.equal(line.amount, 270.3);
    assert.equal(line.paymentMethod, 'upi');
    assert.equal(line.bankDetails.upiId, 'owner@upi');
    assert.equal(line.bankDetails.payoutMethod.methodName, 'upi payment');
    assert.match(line.adminNote, /disbursement #1112, line #1421/);
});

test('a cancelled bank line keeps the misspelt IFSC key the old form used', () => {
    const line = payoutLineData({
        id: 1392, disbursement_id: 1110, store_id: 50, disbursement_amount: '619.650', status: 'canceled',
        method_name: 'Bank', method_fields: '{"account_holder_name":"A","account_number":"123","ifsc_cod":"SBIN0001","branch":"X"}',
        created_at: new Date('2026-10-07T00:50:15Z'), updated_at: new Date('2026-10-07T17:06:34Z'),
    }, R, B);
    assert.equal(line.status, 'rejected');
    assert.equal(line.paymentMethod, 'bank_transfer');
    assert.equal(line.bankDetails.ifscCode, 'SBIN0001');
    assert.ok(line.bankDetails.payoutMethod.fields.some((f) => f.label === 'IFSC code'));
    assert.deepEqual(line.processedAt, new Date('2026-10-07T17:06:34Z'));
});
