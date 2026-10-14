import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../src/config/prisma.js';
import {
    PHOTO_NOT_CARRIED, attachmentsOf, mapLegacyMessage, partyOf, planMessageFill, threadKey,
} from './chat.mjs';

/**
 * The chat mapping, on rows shaped like the backup's: conversation and message
 * ids are user_infos ids; admin conversations have receiver_id 0.
 */
test.after(() => prisma.$disconnect());

const U = 'u'.repeat(24);
const R = 'r'.repeat(24);
const D = 'd'.repeat(24);
const A = 'a'.repeat(24);
const O = 'o'.repeat(24);
const maps = {
    user: new Map([['6', U]]),
    restaurant: new Map([['7', R]]),
    delivery_partner: new Map([['3', D]]),
    vendorStores: new Map([['5', ['7']]]),
};
const infos = new Map([
    ['10', { id: 10, user_id: 6 }],
    ['20', { id: 20, vendor_id: 5 }],
    ['30', { id: 30, deliveryman_id: 3 }],
    ['8', { id: 8, admin_id: 1 }],
    ['40', { id: 40, user_id: 404 }],
]);
const noFiles = () => null;
const opts = (over = {}) => ({ infos, adminIdOf: () => A, orderIdOf: (id) => (id === '104732' ? O : null), stat: noFiles, ...over });

test('participants resolve through user_infos and the id maps', () => {
    assert.deepEqual(partyOf('customer', 10, infos.get('10'), maps), { role: 'USER', id: U });
    assert.deepEqual(partyOf('vendor', 20, infos.get('20'), maps), { role: 'RESTAURANT', id: R }, 'vendor -> its store');
    assert.deepEqual(partyOf('delivery_man', 30, infos.get('30'), maps), { role: 'DELIVERY_PARTNER', id: D });
    assert.deepEqual(partyOf('admin', 0, undefined, maps), { role: 'ADMIN', id: null });
    assert.match(partyOf('delivery_man', 16, undefined, maps).missing, /no longer exists/);
    assert.match(partyOf('customer', 40, infos.get('40'), maps).missing, /customer 404 not imported/);
    assert.match(partyOf('martian', 1, infos.get('10'), maps).missing, /unknown participant type/);
});

test('thread ids are the ones the chat service derives', () => {
    assert.equal(threadKey('USER:u', 'ADMIN', null), 'direct::ADMIN|USER:u');
    assert.equal(threadKey('ADMIN', 'USER:u', 'o1'), 'o1::ADMIN|USER:u');
    assert.equal(threadKey('USER:u', 'DELIVERY_PARTNER:d', 'o1'), 'o1', 'customer and rider: the order id itself');
    assert.equal(threadKey('USER:u', 'RESTAURANT:r', null), 'direct::RESTAURANT:r|USER:u');
});

const adminConv = { id: 1, sender_id: 10, sender_type: 'customer', receiver_id: 0, receiver_type: 'admin', created_at: new Date('2026-05-01T00:00:00Z') };
const sides = { a: { role: 'USER', id: U }, b: { role: 'ADMIN', id: null } };
const msg = (over = {}) => ({
    id: 1, conversation_id: 1, sender_id: 10, message: 'Where is my order?', file: null, is_seen: 1, order_id: null,
    created_at: new Date('2026-05-02T10:00:00Z'), updated_at: new Date('2026-05-02T10:05:00Z'), ...over,
});

test("a customer's support question, about an order, goes to that order's support thread", () => {
    const { data } = mapLegacyMessage(msg({ order_id: 104732 }), adminConv, sides, opts());
    assert.equal(data.conversationId, `${O}::ADMIN|USER:${U}`);
    assert.equal(data.orderId, O);
    assert.equal(data.senderRole, 'USER');
    assert.equal(data.senderId, U);
    assert.equal(data.recipientRole, 'ADMIN');
    assert.equal(data.recipientId, null);
    assert.deepEqual(data.participants, [`USER:${U}`, 'ADMIN']);
    assert.equal(data.readAt.toISOString(), '2026-05-02T10:05:00.000Z', 'seen: read when it was marked so');
    assert.equal(data.createdAt.toISOString(), '2026-05-02T10:00:00.000Z');
});

test('an admin reply (sender is the admin profile, not a side of the row) is from support, by the admin here', () => {
    const { data } = mapLegacyMessage(msg({ sender_id: 8, is_seen: 0, order_id: 999 }), adminConv, sides, opts());
    assert.equal(data.senderRole, 'ADMIN');
    assert.equal(data.senderId, A);
    assert.equal(data.senderToken, 'ADMIN');
    assert.equal(data.recipientId, U);
    assert.equal(data.readAt, null, 'unseen stays unread');
    assert.equal(data.orderId, null, 'an order not imported leaves it in the general thread');
    assert.equal(data.conversationId, `direct::ADMIN|USER:${U}`);
});

test('a message from someone outside the conversation, or with no admin to attribute, is skipped', () => {
    assert.match(mapLegacyMessage(msg({ sender_id: 20 }), adminConv, sides, opts()).skip, /neither side/);
    assert.match(mapLegacyMessage(msg({ sender_id: 8 }), adminConv, sides, opts({ adminIdOf: () => null })).skip, /no admin/);
    const pair = { id: 2, sender_id: 10, receiver_id: 20, created_at: null };
    const pairSides = { a: { role: 'USER', id: U }, b: { role: 'RESTAURANT', id: R } };
    assert.match(mapLegacyMessage(msg({ sender_id: 8 }), pair, pairSides, opts()).skip, /neither side/);
    const reply = mapLegacyMessage(msg({ sender_id: 20 }), pair, pairSides, opts()).data;
    assert.equal(reply.senderRole, 'RESTAURANT');
    assert.equal(reply.recipientId, U);
});

test('pictures: referenced when on disk, otherwise the text stays and a picture-only message says so', () => {
    const file = '[{"img":"2026-05-12-6a033a4622025.jpg","storage":"public"},{"img":"../../etc/passwd","storage":"public"}]';
    const stat = (p) => (p === 'legacy/conversation/2026-05-12-6a033a4622025.jpg' ? { size: 1234 } : null);
    const { attachments, missing } = attachmentsOf(file, stat);
    assert.equal(attachments.length, 1);
    assert.equal(attachments[0].path, 'legacy/conversation/2026-05-12-6a033a4622025.jpg');
    assert.match(attachments[0].url, /\/legacy\/conversation\/2026-05-12-6a033a4622025\.jpg$/);
    assert.equal(attachments[0].mimeType, 'image/jpeg');
    assert.equal(attachments[0].size, 1234);
    assert.deepEqual(missing, ['../../etc/passwd'], 'never a path outside the folder');

    const withText = mapLegacyMessage(msg({ file }), adminConv, sides, opts());
    assert.equal(withText.data.text, 'Where is my order?');
    assert.equal(withText.data.attachments.length, 0);
    assert.equal(withText.missing.length, 2);

    const photoOnly = mapLegacyMessage(msg({ message: null, file }), adminConv, sides, opts());
    assert.equal(photoOnly.data.text, PHOTO_NOT_CARRIED);
    assert.match(mapLegacyMessage(msg({ message: ' ', file: '[]' }), adminConv, sides, opts()).skip, /empty/);
    assert.deepEqual(attachmentsOf('not json', stat), { attachments: [], missing: [] });
});

test('a re-run only fills blanks: never un-reads, attaches a picture copied since', () => {
    const readHere = new Date('2026-10-01T00:00:00Z');
    assert.deepEqual(planMessageFill({ readAt: readHere, attachments: [], text: 'x' }, { readAt: null, attachments: [], text: 'x' }), {});
    const seen = new Date('2026-05-02T10:05:00Z');
    assert.deepEqual(planMessageFill({ readAt: null, attachments: [], text: 'x' }, { readAt: seen, attachments: [], text: 'x' }), { readAt: seen });
    const pic = [{ path: 'legacy/conversation/a.jpg' }];
    assert.deepEqual(
        planMessageFill({ readAt: seen, attachments: [], text: PHOTO_NOT_CARRIED }, { readAt: seen, attachments: pic, text: '' }),
        { attachments: pic, text: '' },
    );
    assert.deepEqual(planMessageFill({ readAt: seen, attachments: pic, text: '' }, { readAt: seen, attachments: [{ path: 'b' }], text: '' }), {});
});
