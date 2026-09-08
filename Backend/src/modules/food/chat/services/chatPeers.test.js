import test from 'node:test';
import assert from 'node:assert/strict';

import { partyToken } from './chat.service.js';

/**
 * The token a party is known by inside a conversation.
 *
 * The admin inbox splits threads into customer, delivery and restaurant tabs by
 * parsing these, so the shape is load-bearing in two places now rather than one.
 */

test('a party token is role and id, joined by a colon', () => {
    assert.equal(partyToken('USER', 'abc123'), 'USER:abc123');
    assert.equal(partyToken('DELIVERY_PARTNER', 'r1'), 'DELIVERY_PARTNER:r1');
    assert.equal(partyToken('RESTAURANT', 'x9'), 'RESTAURANT:x9');
});

test('every admin shares one token', () => {
    // Support is one desk, not a person. This is also why a thread cannot yet
    // say which admin replied -- see phase 3.
    assert.equal(partyToken('ADMIN', 'someAdminId'), 'ADMIN');
    assert.equal(partyToken('ADMIN', null), 'ADMIN');
});

test('splitting a token back apart gives the role the inbox tabs on', () => {
    // Mirrors what the admin screen does with peerToken.
    for (const [role, id] of [['USER', 'u1'], ['DELIVERY_PARTNER', 'd1'], ['RESTAURANT', 'r1']]) {
        const [parsedRole, parsedId] = partyToken(role, id).split(':');
        assert.equal(parsedRole, role);
        assert.equal(parsedId, id);
    }
});

test('an id containing a colon does not corrupt the role', () => {
    // Ids are hex, so this cannot happen today -- but the parse takes the first
    // segment as the role, which is what keeps it true if that ever changes.
    const [role] = partyToken('USER', 'a:b').split(':');
    assert.equal(role, 'USER');
});
