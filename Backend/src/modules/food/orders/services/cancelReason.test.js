import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../../config/prisma.js';
import {
    createCancelReason,
    deleteCancelReason,
    listActiveCancelReasons,
    updateCancelReason,
} from './cancelReason.service.js';

const created = [];
test.after(async () => {
    await prisma.foodCancelReason.deleteMany({ where: { id: { in: created } } });
    await prisma.$disconnect();
});

test('reasons are kept per who cancels, in order, and only active ones are offered', async () => {
    const tag = `T${Date.now()}`;
    const a = await createCancelReason({ reason: `${tag} shop closed`, userType: 'restaurant' });
    const b = await createCancelReason({ reason: `  ${tag}   item   unavailable `, userType: 'restaurant' });
    const c = await createCancelReason({ reason: `${tag} changed my mind`, userType: 'customer' });
    created.push(a.id, b.id, c.id);

    assert.equal(b.reason, `${tag} item unavailable`, 'whitespace tidied');
    assert.ok(b.sortOrder > a.sortOrder, 'added to the end of its list');

    const forRestaurant = (await listActiveCancelReasons('restaurant')).filter((r) => r.reason.startsWith(tag));
    assert.deepEqual(forRestaurant.map((r) => r.id), [a.id, b.id]);

    await updateCancelReason(a.id, { isActive: false });
    const after = (await listActiveCancelReasons('restaurant')).filter((r) => r.reason.startsWith(tag));
    assert.deepEqual(after.map((r) => r.id), [b.id], 'a switched-off reason is not offered');

    await assert.rejects(() => createCancelReason({ reason: '  ', userType: 'admin' }), /required/);
    await assert.rejects(() => createCancelReason({ reason: 'x', userType: 'owner' }), /Who cancels/);
    await deleteCancelReason(c.id);
    await assert.rejects(() => deleteCancelReason(c.id), /not found/);
});
