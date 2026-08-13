import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../config/prisma.js';
import { recordTransaction, getBalance } from './transaction.service.js';

/**
 * Money-path checks. Needs a real Postgres — the behaviour being verified (atomic
 * conditional updates, unique-constraint replay, Decimal arithmetic) lives in the
 * database, so an in-memory fake would assert nothing.
 *
 *   DATABASE_URL=postgresql://... npm test
 */
const live = Boolean(process.env.DATABASE_URL);

/** A fresh 24-hex id per case, so runs never collide. */
let seq = 0;
const newUserId = () => (Date.now().toString(16) + (seq++).toString(16).padStart(8, '0')).slice(-24).padStart(24, '0');

const credit = (entityId, amount, extra = {}) =>
    recordTransaction({ entityType: 'user', entityId, type: 'credit', amount, ...extra });
const debit = (entityId, amount, extra = {}) =>
    recordTransaction({ entityType: 'user', entityId, type: 'debit', amount, ...extra });

test('rupees add up exactly — no float drift', { skip: !live }, async () => {
    const user = newUserId();
    await credit(user, 0.1);
    await credit(user, 0.2);

    const { balance } = await getBalance('user', user);
    // 0.1 + 0.2 === 0.30000000000000004 in float64; Decimal(14,2) is why this holds.
    assert.equal(balance, 0.3);
});

test('a debit past the balance is rejected and moves nothing', { skip: !live }, async () => {
    const user = newUserId();
    await credit(user, 100);

    await assert.rejects(() => debit(user, 150), /Insufficient balance/);

    const { balance } = await getBalance('user', user);
    assert.equal(balance, 100);
});

test('replaying an idempotency key returns the original, credits once', { skip: !live }, async () => {
    const user = newUserId();
    const key = `test:${user}`;

    const first = await credit(user, 250, { idempotencyKey: key });
    const replay = await credit(user, 250, { idempotencyKey: key });

    assert.equal(replay.transaction.id, first.transaction.id);
    const { balance } = await getBalance('user', user);
    assert.equal(balance, 250);
});

test('concurrent credits do not lose updates', { skip: !live }, async () => {
    const user = newUserId();
    await Promise.all(Array.from({ length: 20 }, () => credit(user, 5)));

    const { balance } = await getBalance('user', user);
    // Read-modify-write (what Mongo did) loses writes here and lands under 100.
    assert.equal(balance, 100);
});

test('concurrent debits cannot overdraw', { skip: !live }, async () => {
    const user = newUserId();
    await credit(user, 100);

    // Ten racing debits of 20 against a balance of 100: exactly five may win.
    const results = await Promise.allSettled(
        Array.from({ length: 10 }, () => debit(user, 20))
    );
    const settled = results.filter((r) => r.status === 'fulfilled').length;

    assert.equal(settled, 5);
    const { balance } = await getBalance('user', user);
    assert.equal(balance, 0);
});

test('the ledger balance matches the wallet balance', { skip: !live }, async () => {
    const user = newUserId();
    await credit(user, 500);
    await debit(user, 125.5);
    await credit(user, 30.25);

    const rows = await prisma.transaction.findMany({ where: { entityType: 'user', entityId: user } });
    const summed = rows.reduce(
        (acc, r) => acc + (r.type === 'credit' ? Number(r.amount) : -Number(r.amount)),
        0
    );

    const { balance } = await getBalance('user', user);
    assert.equal(balance, summed);
    assert.equal(balance, 404.75);
});

test.after(async () => {
    if (live) await prisma.$disconnect();
});
