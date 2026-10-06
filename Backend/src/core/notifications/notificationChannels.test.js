import test from 'node:test';
import assert from 'node:assert/strict';

import {
    NOTIFICATION_EVENTS,
    normalizeChannelSettings,
    eventForPush,
    channelAllowed,
} from './notificationChannels.js';

test('every event gets push on and SMS/email off unless saved otherwise', () => {
    const settings = normalizeChannelSettings({ events: { refund: { push: false, email: true }, bogus: { push: false } } });
    assert.deepEqual(Object.keys(settings.events), NOTIFICATION_EVENTS.map((e) => e.key));
    assert.deepEqual(settings.events.refund, { push: false, sms: false, email: true });
    assert.deepEqual(settings.events.chat_message, { push: true, sms: false, email: false });
    assert.deepEqual(normalizeChannelSettings(null).events.wallet, { push: true, sms: false, email: false });
});

test('a push is recognised by its type and who receives it', () => {
    assert.equal(eventForPush('new_order', 'RESTAURANT'), 'restaurant_new_order');
    // The same type to a rider is a delivery offer, which is never switchable.
    assert.equal(eventForPush('new_order', 'DELIVERY_PARTNER'), null);
    assert.equal(eventForPush('order_status_update', 'USER'), 'order_status');
    assert.equal(eventForPush('chat_message', 'ADMIN'), 'chat_message');
    assert.equal(eventForPush('something_else', 'USER'), null);
    assert.equal(eventForPush('', 'USER'), null);
});

test('only a switched-off event is held back', () => {
    const settings = normalizeChannelSettings({ events: { order_status: { push: false } } });
    assert.equal(channelAllowed(settings, 'order_status', 'push'), false);
    assert.equal(channelAllowed(settings, 'refund', 'push'), true);
    assert.equal(channelAllowed(settings, null, 'push'), true);
    assert.equal(channelAllowed(null, 'order_status', 'push'), true);
});
