import test from 'node:test';
import assert from 'node:assert/strict';

import {
    PUSH_MESSAGES,
    PUSH_MESSAGE_CATALOG,
    LEGACY_PUSH_MESSAGE_KEYS,
    normalizePushMessages,
    messageForPush,
    renderPushText,
    applyPushMessageSettings,
    mergeLegacyPushMessages,
} from './pushMessages.js';

/**
 * The 6amMart side of the push messages: the old keys, the old placeholders,
 * and folding the old panel's texts into the stored value. All pure -- no
 * database needed.
 */

// The food module's rows in the old notification_messages table, as the backup has them.
const OLD = [
    { key: 'order_pending_message', message: '{userName}, Your  order {orderId} is successfully placed', status: 1 },
    { key: 'order_confirmation_msg', message: '{userName}, Your order {orderId} is confirmed', status: 1 },
    { key: 'order_processing_message', message: '{userName}, Your food is started for cooking by {storeName}', status: 1 },
    { key: 'order_handover_message', message: 'Delivery man is on the way. For this order {orderId}', status: 1 },
    { key: 'order_refunded_message', message: 'Order {orderId} Refunded successfully', status: 1 },
    { key: 'refund_request_canceled', message: 'Order {orderId}  Refund request is canceled', status: 1 },
    { key: 'out_for_delivery_message', message: '{userName}, Your order {orderId}  is ready for delivery', status: 1 },
    { key: 'order_delivered_message', message: 'Your order {orderId} is delivered', status: 1 },
    { key: 'delivery_boy_assign_message', message: 'Your order {orderId} has been assigned to a delivery man', status: 1 },
    { key: 'delivery_boy_delivered_message', message: 'Order {orderId} delivered successfully', status: 1 },
    { key: 'order_cancled_message', message: 'Order {orderId} is canceled by your request', status: 1 },
];

test('every old 6amMart message key has a message here', () => {
    for (const row of OLD) assert.ok(LEGACY_PUSH_MESSAGE_KEYS[row.key], row.key);
    const keys = new Set(PUSH_MESSAGES.map((m) => m.key));
    for (const key of Object.values(LEGACY_PUSH_MESSAGE_KEYS)) assert.ok(keys.has(key), key);
    assert.equal(LEGACY_PUSH_MESSAGE_KEYS.order_handover_message, 'customer_order_ready');
    assert.equal(LEGACY_PUSH_MESSAGE_KEYS.refund_request_canceled, 'customer_refund_request_rejected');
    assert.equal(LEGACY_PUSH_MESSAGE_KEYS.delivery_boy_delivered_message, 'rider_order_delivered');
});

test('the page gets the code wording as the default and every 6amMart placeholder', () => {
    for (const entry of PUSH_MESSAGE_CATALOG) {
        assert.ok(entry.defaultTitle && entry.defaultBody, entry.key);
        for (const name of ['userName', 'orderId', 'storeName', 'deliveryManName']) assert.ok(entry.placeholders.includes(name), `${entry.key} ${name}`);
    }
    const offer = PUSH_MESSAGE_CATALOG.find((m) => m.key === 'rider_new_order');
    assert.equal(offer.switchable, false);
    assert.equal(PUSH_MESSAGE_CATALOG.filter((m) => !m.switchable).length, 1);
});

test('a declined refund request is its own message, with the reason', () => {
    const data = { type: 'refund_request_rejected', orderId: 'FOD-7', reason: 'Too late' };
    const message = messageForPush(data, 'USER');
    assert.equal(message?.key, 'customer_refund_request_rejected');
    const settings = normalizePushMessages({ messages: { customer_refund_request_rejected: { body: 'Order {orderId} Refund request is canceled ({reason})' } } });
    const out = applyPushMessageSettings({ title: 'code', body: 'code', data }, message, settings, { orderId: 'FOD-7', reason: 'Too late' });
    assert.equal(out.payload.body, 'Order FOD-7 Refund request is canceled (Too late)');
});

test('old texts render with the old placeholders', () => {
    const vars = { userName: 'Asha', orderId: '100045', storeName: 'Spice Hub', deliveryManName: 'Ravi' };
    assert.equal(renderPushText(OLD[2].message, vars), 'Asha, Your food is started for cooking by Spice Hub');
    assert.equal(renderPushText('{deliveryManName} is on the way with {orderId}', vars), 'Ravi is on the way with 100045');
});

test('import: untouched messages take the old text and switch', () => {
    const rows = [...OLD, { key: 'order_delivered_message', message: 'Delivered {orderId}', status: 0 }];
    const { value, outcomes } = mergeLegacyPushMessages({}, rows);
    // Double spaces from the old panel are cleaned.
    assert.deepEqual(value.messages.customer_order_placed, { enabled: true, title: '', body: '{userName}, Your order {orderId} is successfully placed' });
    assert.equal(value.messages.customer_order_ready.body, 'Delivery man is on the way. For this order {orderId}');
    // The last row for a key wins; status 0 is off.
    assert.deepEqual(value.messages.customer_order_delivered, { enabled: false, title: '', body: 'Delivered {orderId}' });
    assert.equal(outcomes.filter((o) => o.outcome === 'created').length, 11);
    // Messages with no old counterpart stay blank.
    assert.deepEqual(value.messages.restaurant_new_order, { enabled: true, title: '', body: '' });
});

test('import: a message edited here is left alone; a re-run changes nothing', () => {
    const edited = { messages: { customer_order_confirmed: { body: 'Ours {orderId}' }, customer_order_ready: { enabled: false } } };
    const first = mergeLegacyPushMessages(edited, OLD);
    const by = (outcomes, key) => outcomes.find((o) => o.key === key)?.outcome;
    assert.equal(by(first.outcomes, 'customer_order_confirmed'), 'protected');
    assert.equal(by(first.outcomes, 'customer_order_ready'), 'protected');
    assert.equal(first.value.messages.customer_order_confirmed.body, 'Ours {orderId}');
    assert.equal(first.value.messages.customer_order_ready.enabled, false);

    const again = mergeLegacyPushMessages(first.value, OLD);
    assert.deepEqual(again.value, first.value);
    assert.ok(again.outcomes.every((o) => o.outcome === 'unchanged' || o.outcome === 'protected'));
});

test('import (sync): an old-side change follows only where this system still holds the imported text', () => {
    const imported = mergeLegacyPushMessages({}, OLD).value;
    // Edited here since the first import.
    imported.messages.customer_order_delivered.body = 'Enjoy {orderId}!';
    const newer = OLD.map((row) =>
        row.key === 'order_pending_message' || row.key === 'order_delivered_message' ? { ...row, message: `NEW ${row.message}` } : row,
    );
    const { value, outcomes } = mergeLegacyPushMessages(imported, newer, { baselineRows: OLD });
    assert.equal(value.messages.customer_order_placed.body, 'NEW {userName}, Your order {orderId} is successfully placed');
    assert.equal(outcomes.find((o) => o.key === 'customer_order_placed').outcome, 'updated');
    assert.equal(value.messages.customer_order_delivered.body, 'Enjoy {orderId}!');
    assert.equal(outcomes.find((o) => o.key === 'customer_order_delivered').outcome, 'protected');
});

test('import: an old key with no message here is reported, not guessed', () => {
    const { outcomes } = mergeLegacyPushMessages({}, [{ key: 'parcel_something', message: 'x', status: 1 }]);
    assert.deepEqual(outcomes, [{ legacyKey: 'parcel_something', key: null, outcome: 'skipped', reason: 'no message here for it' }]);
});
