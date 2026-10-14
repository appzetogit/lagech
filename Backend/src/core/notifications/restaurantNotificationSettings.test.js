import test from 'node:test';
import assert from 'node:assert/strict';

import {
    RESTAURANT_NOTIFICATION_EVENTS,
    resolveRestaurantSettings,
    channelOn,
    eventForRestaurantPush,
    readSettingChange,
    statusFor,
    isRestaurantNotificationOn,
} from './restaurantNotificationSettings.js';

/**
 * A restaurant's Notification Setup (old store_notification_settings): which
 * channels each event offers, what a stored row means, and which pushes it
 * gates. All pure -- the gate's database read is covered in
 * restaurantNotificationGate.test.js.
 */

// The 20 keys of the old store_notification_settings table.
const OLD_KEYS = [
    'store_account_block', 'store_account_unblock', 'store_advertisement_approval', 'store_advertisement_create_by_admin',
    'store_advertisement_deny', 'store_advertisement_pause', 'store_advertisement_resume', 'store_campaign_join_approval',
    'store_campaign_join_rejaction', 'store_campaign_join_request', 'store_order_notification', 'store_product_approve',
    'store_product_reject', 'store_subscription_cancel', 'store_subscription_plan_update', 'store_subscription_renew',
    'store_subscription_shift', 'store_subscription_success', 'store_withdraw_approve', 'store_withdraw_rejaction',
];

test('every old event is here, with the old panel’s channels', () => {
    assert.deepEqual(RESTAURANT_NOTIFICATION_EVENTS.map((e) => e.key).sort(), [...OLD_KEYS].sort());
    const defaults = Object.fromEntries(resolveRestaurantSettings([]).map((e) => [e.key, [e.mail.status, e.sms.status, e.push.status]]));
    assert.deepEqual(defaults.store_order_notification, ['disable', 'disable', 'active']);
    assert.deepEqual(defaults.store_campaign_join_request, ['active', 'disable', 'disable']);
    assert.deepEqual(defaults.store_withdraw_approve, ['active', 'disable', 'active']);
});

test('a stored row: inactive is off, anything else on, a channel not offered stays disable', () => {
    const rows = [
        { key: 'store_order_notification', mailStatus: 'active', smsStatus: 'active', pushStatus: 'inactive' },
        { key: 'store_withdraw_approve', mailStatus: 'inactive', smsStatus: 'disable', pushStatus: 'garbage' },
    ];
    const byKey = Object.fromEntries(resolveRestaurantSettings(rows).map((e) => [e.key, e]));
    assert.equal(byKey.store_order_notification.push.status, 'inactive');
    // Mail and SMS are not offered for orders, whatever the row says.
    assert.equal(byKey.store_order_notification.mail.status, 'disable');
    assert.equal(byKey.store_order_notification.sms.status, 'disable');
    assert.equal(byKey.store_withdraw_approve.mail.status, 'inactive');
    assert.equal(byKey.store_withdraw_approve.push.status, 'active');
    // The page is told what this system actually sends.
    assert.equal(byKey.store_order_notification.push.wired, true);
    assert.equal(byKey.store_withdraw_approve.mail.wired, true);
    assert.equal(byKey.store_withdraw_approve.push.wired, false);
    assert.equal(statusFor('store_order_notification', 'push', undefined), 'active');
});

test('the gate: only an offered channel switched to inactive stops a send', () => {
    const rows = [
        { key: 'store_order_notification', pushStatus: 'inactive' },
        { key: 'store_product_approve', mailStatus: 'inactive', pushStatus: 'active' },
    ];
    assert.equal(channelOn(rows, 'store_order_notification', 'push'), false);
    assert.equal(channelOn(rows, 'store_product_approve', 'push'), true);
    assert.equal(channelOn(rows, 'store_product_approve', 'mail'), false);
    // No row: defaults, on.
    assert.equal(channelOn(rows, 'store_withdraw_rejaction', 'mail'), true);
    // Not the restaurant's to switch: unknown events, channels not offered.
    assert.equal(channelOn(rows, 'nope', 'push'), true);
    assert.equal(channelOn(rows, null, 'push'), true);
    assert.equal(channelOn([{ key: 'store_campaign_join_request', pushStatus: 'inactive' }], 'store_campaign_join_request', 'push'), true);
});

test('pushes to a restaurant are matched to their event by type', () => {
    for (const type of ['new_order', 'order_created', 'order_status_update', 'order_cancelled', 'delivery_accepted', 'rider_arrived', 'order_updated']) {
        assert.equal(eventForRestaurantPush({ type }), 'store_order_notification', type);
    }
    assert.equal(eventForRestaurantPush({ type: 'food_approved' }), 'store_product_approve');
    assert.equal(eventForRestaurantPush({ type: 'addon_rejected' }), 'store_product_reject');
    // Not a Notification Setup event: always sent.
    assert.equal(eventForRestaurantPush({ type: 'chat_message' }), null);
    assert.equal(eventForRestaurantPush({ type: 'restaurant_approved' }), null);
    assert.equal(eventForRestaurantPush({}), null);
});

test('a switch change is checked', () => {
    assert.deepEqual(readSettingChange({ key: 'store_order_notification', channel: 'PUSH', enabled: false }), {
        key: 'store_order_notification', channel: 'push', status: 'inactive',
    });
    assert.deepEqual(readSettingChange({ key: 'store_withdraw_approve', channel: 'mail', status: 'active' }), {
        key: 'store_withdraw_approve', channel: 'mail', status: 'active',
    });
    assert.throws(() => readSettingChange({ key: 'nope', channel: 'push', status: 'active' }), /Unknown notification/);
    assert.throws(() => readSettingChange({ key: 'store_order_notification', channel: 'fax', status: 'active' }), /Channel/);
    assert.throws(() => readSettingChange({ key: 'store_order_notification', channel: 'mail', status: 'active' }), /cannot be switched/);
    assert.throws(() => readSettingChange({ key: 'store_withdraw_approve', channel: 'mail', status: 'disable' }), /active or inactive/);
});

test('the gate needs no database for what the restaurant cannot switch', async () => {
    assert.equal(await isRestaurantNotificationOn('a'.repeat(24), null, 'push'), true);
    assert.equal(await isRestaurantNotificationOn('a'.repeat(24), 'store_order_notification', 'mail'), true);
    assert.equal(await isRestaurantNotificationOn('', 'store_order_notification', 'push'), true);
});
