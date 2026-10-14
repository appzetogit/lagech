import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../../config/prisma.js';
import { uniqueTag } from '../../../../utils/testIds.js';
import { createFaq, updateFaq, deleteFaq, reorderFaqs, listFaqs, getPublicFaqs, invalidateFaqCache } from './faq.service.js';

/**
 * The FAQ manager against the database: add, edit, delete, reorder, the
 * on/off switch, and what GET /food/faqs?audience= hands out.
 */

const tag = uniqueTag('Faq');
const ids = [];

test.after(async () => {
    await prisma.foodFaq.deleteMany({ where: { id: { in: ids } } });
    invalidateFaqCache();
    await prisma.$disconnect();
});

const mine = (faqs) => faqs.filter((faq) => ids.includes(faq.id)).map((faq) => faq.question);

test('add, edit, switch off, reorder and delete', async () => {
    const a = await createFaq({ question: `${tag} How do I pay?`, answer: 'UPI or cash.', audience: 'customer' });
    const b = await createFaq({ question: `${tag} How do I join?`, answer: 'Register as a partner.', audience: 'vendor' });
    const c = await createFaq({ question: `${tag} Opening hours?`, answer: 'Every day.' });
    ids.push(a.id, b.id, c.id);
    assert.equal(b.audience, 'restaurant');
    assert.equal(c.audience, null);
    assert.ok(b.sortOrder > a.sortOrder && c.sortOrder > b.sortOrder, 'new ones go to the end');

    const edited = await updateFaq(a.id, { answer: 'UPI, card or cash.' });
    assert.equal(edited.answer, 'UPI, card or cash.');
    assert.equal(edited.question, `${tag} How do I pay?`);
    await assert.rejects(updateFaq(a.id, { question: ' ' }), /Question is required/);
    await assert.rejects(updateFaq('f'.repeat(24), { answer: 'x' }), /not found/);

    const listed = await reorderFaqs({ ids: [c.id, a.id, b.id] });
    assert.deepEqual(mine(listed.faqs), [`${tag} Opening hours?`, `${tag} How do I pay?`, `${tag} How do I join?`]);

    await updateFaq(c.id, { isActive: false });
    const inactive = await listFaqs({ status: 'inactive', search: tag });
    assert.deepEqual(inactive.faqs.map((f) => f.id), [c.id]);

    await deleteFaq(b.id);
    await assert.rejects(deleteFaq(b.id), /not found/);
    const left = await listFaqs({ search: tag });
    assert.deepEqual(left.faqs.map((f) => f.id).sort(), [a.id, c.id].sort());
});

test('public: active ones for the audience and for everyone, without admin fields', async () => {
    const rider = await createFaq({ question: `${tag} Rider pay?`, answer: 'Weekly.', audience: 'rider' });
    const all = await createFaq({ question: `${tag} Support?`, answer: 'Chat with us.', audience: '' });
    ids.push(rider.id, all.id);

    const customer = await getPublicFaqs({ audience: 'customer' });
    assert.equal(customer.audience, 'customer');
    const questions = mine(customer.faqs);
    assert.ok(questions.includes(`${tag} How do I pay?`));
    assert.ok(questions.includes(`${tag} Support?`));
    assert.ok(!questions.includes(`${tag} Rider pay?`));
    // Switched off in the test above.
    assert.ok(!questions.includes(`${tag} Opening hours?`));
    assert.deepEqual(Object.keys(customer.faqs[0]).sort(), ['answer', 'audience', 'id', 'question']);

    const riders = mine((await getPublicFaqs({ audience: 'deliveryman' })).faqs);
    assert.deepEqual(riders.sort(), [`${tag} Rider pay?`, `${tag} Support?`].sort());
    await assert.rejects(getPublicFaqs({ audience: 'martian' }), /audience/);
});
