import test from 'node:test';
import assert from 'node:assert/strict';

import { nestable, prisma, realPrisma, setActive } from './prisma.mjs';

/**
 * The --dry-run client, against a real (throwaway) database: everything done
 * through it inside the dry-run transaction -- nested transactions included --
 * is gone after the rollback, and outside the transaction it cannot write.
 */
test.after(() => realPrisma.$disconnect());

const email = (tag) => `dryrun-${tag}-${process.pid}@example.com`;
class Rollback extends Error {}

test('writes inside the dry-run transaction, nested ones too, are rolled back', async () => {
    const before = await realPrisma.foodNewsletterSubscriber.count();
    let inside;
    await assert.rejects(realPrisma.$transaction(async (tx) => {
        setActive(nestable(tx));
        try {
            await prisma.foodNewsletterSubscriber.create({ data: { email: email('plain') } });
            // The interactive form, as the order step and the restaurant service use it.
            await prisma.$transaction(async (inner) => {
                await inner.foodNewsletterSubscriber.create({ data: { email: email('interactive') } });
                await inner.$transaction(async (deeper) => deeper.foodNewsletterSubscriber.create({ data: { email: email('deeper') } }));
            });
            // The array form, as the restaurant step uses it.
            await prisma.$transaction([
                prisma.foodNewsletterSubscriber.create({ data: { email: email('array-1') } }),
                prisma.foodNewsletterSubscriber.create({ data: { email: email('array-2') } }),
            ]);
            await prisma.$executeRaw`UPDATE food_newsletter_subscribers SET email = email WHERE false`;
            inside = await prisma.foodNewsletterSubscriber.count();
        } finally {
            setActive(null);
        }
        throw new Rollback('rolled back');
    }, { timeout: 60000 }), Rollback);

    assert.equal(inside, before + 5, 'the writes were visible inside the transaction');
    assert.equal(await realPrisma.foodNewsletterSubscriber.count(), before, 'and none survived it');
    assert.equal(await realPrisma.foodNewsletterSubscriber.count({ where: { email: { startsWith: 'dryrun-' } } }), 0);
});

test('outside the transaction the dry-run client reads but refuses every write', async () => {
    assert.equal(typeof (await prisma.foodNewsletterSubscriber.count()), 'number');
    assert.ok(Array.isArray(await prisma.$queryRaw`SELECT 1 AS one`));
    assert.throws(() => prisma.foodNewsletterSubscriber.create({ data: { email: email('outside') } }), /dry run: refused/);
    assert.throws(() => prisma.foodNewsletterSubscriber.updateMany({ data: {} }), /dry run: refused/);
    assert.throws(() => prisma.foodNewsletterSubscriber.deleteMany({}), /dry run: refused/);
    assert.throws(() => prisma.$executeRawUnsafe('DELETE FROM food_newsletter_subscribers'), /dry run: refused/);
    assert.throws(() => prisma.$transaction([]), /dry run: refused/);
    assert.equal(await realPrisma.foodNewsletterSubscriber.count({ where: { email: email('outside') } }), 0);
});
