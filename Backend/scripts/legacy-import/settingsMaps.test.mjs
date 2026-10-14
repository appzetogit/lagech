import test from 'node:test';
import assert from 'node:assert/strict';

import {
    rowsFromBusinessSettings,
    mapStoreNotificationRow,
    decideStoreNotificationRow,
    mapLegacyFaq,
} from './settingsMaps.mjs';

/**
 * The pure mappings behind the faqs, notification-messages and
 * store-notification-settings steps, on rows shaped like the backup's.
 */

const R2 = 'a'.repeat(24);
const restaurants = new Map([['2', R2]]);
const store = (over = {}) => ({
    id: 1, store_id: '2', key: 'store_order_notification', mail_status: 'disable', sms_status: 'disable',
    push_notification_status: 'active', ...over,
});

test('store notification: the old defaults come across as they were', () => {
    assert.deepEqual(mapStoreNotificationRow(store(), restaurants).data, {
        restaurantId: R2, key: 'store_order_notification', mailStatus: 'disable', smsStatus: 'disable', pushStatus: 'active',
    });
    assert.deepEqual(
        mapStoreNotificationRow(store({ key: 'store_withdraw_approve', mail_status: 'active', push_notification_status: 'inactive' }), restaurants).data,
        { restaurantId: R2, key: 'store_withdraw_approve', mailStatus: 'active', smsStatus: 'disable', pushStatus: 'inactive' },
    );
    // campaign_join_request offers no push: whatever the old row said, disable.
    assert.equal(mapStoreNotificationRow(store({ key: 'store_campaign_join_request', push_notification_status: 'active' }), restaurants).data.pushStatus, 'disable');
    // An offered channel the old row had as 'disable' is on (the default).
    assert.equal(mapStoreNotificationRow(store({ key: 'store_product_approve', mail_status: 'disable' }), restaurants).data.mailStatus, 'active');
});

test('store notification: unknown keys and stores not imported are skipped', () => {
    assert.match(mapStoreNotificationRow(store({ key: 'store_parcel_thing' }), restaurants).skip, /not a Notification Setup event/);
    assert.match(mapStoreNotificationRow(store({ store_id: '99' }), restaurants).skip, /store 99 was not imported/);
});

test('store notification: a row here wins unless it still holds the old value', () => {
    const wanted = { mailStatus: 'disable', smsStatus: 'disable', pushStatus: 'inactive' };
    const old = { mailStatus: 'disable', smsStatus: 'disable', pushStatus: 'active' };
    assert.equal(decideStoreNotificationRow(wanted, null), 'create');
    assert.equal(decideStoreNotificationRow(wanted, { ...wanted, id: 'x' }), 'unchanged');
    // Set here by the restaurant (no baseline: first import or re-run).
    assert.equal(decideStoreNotificationRow(wanted, { ...old, id: 'x' }), 'protected');
    // Sync: this system still has what the old system had last time -> follow.
    assert.equal(decideStoreNotificationRow(wanted, { ...old, id: 'x' }, old), 'update');
    // Sync: changed here since -> left alone.
    assert.equal(decideStoreNotificationRow(old, { ...wanted, pushStatus: 'inactive', id: 'x' }, { ...old, pushStatus: 'active' }), 'protected');
});

test('push messages: business_settings copies read like notification_messages rows', () => {
    const rows = rowsFromBusinessSettings([
        { id: 5, key: 'order_pending_message', value: '{"status":1,"message":"Your order is successfully placed"}' },
        { id: 6, key: 'order_delivered_message', value: '{"status":0,"message":"Delivered"}' },
        { id: 7, key: 'broken', value: 'not json' },
    ]);
    assert.deepEqual(rows, [
        { id: 5, key: 'order_pending_message', message: 'Your order is successfully placed', status: 1 },
        { id: 6, key: 'order_delivered_message', message: 'Delivered', status: 0 },
    ]);
});

test('faqs: user_type becomes the audience; status the switch; order kept', () => {
    const row = (over) => ({ id: 1, question: 'How do I place an order?', answer: 'Browse, add, checkout.', page_type: 'react_landing_page', user_type: 'customer', status: 1, created_at: new Date('2025-11-16T15:54:17Z'), ...over });
    const { data } = mapLegacyFaq(row(), 3);
    assert.deepEqual(data, {
        question: 'How do I place an order?', answer: 'Browse, add, checkout.', audience: 'customer', isActive: true, sortOrder: 3,
        createdAt: new Date('2025-11-16T15:54:17Z'),
    });
    assert.equal(mapLegacyFaq(row({ user_type: 'vendor' })).data.audience, 'restaurant');
    assert.equal(mapLegacyFaq(row({ user_type: 'deliveryman' })).data.audience, 'rider');
    assert.equal(mapLegacyFaq(row({ user_type: null })).data.audience, null);
    assert.equal(mapLegacyFaq(row({ user_type: 'martian' })).data.audience, null);
    assert.equal(mapLegacyFaq(row({ status: 0 })).data.isActive, false);
    assert.match(mapLegacyFaq(row({ question: '  ' })).skip, /Question is required/);
});
