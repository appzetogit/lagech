import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../config/prisma.js';
import {
    createInboxNotifications,
    getInboxNotifications,
    markNotificationAsRead,
    dismissNotification,
    dismissAllNotifications,
} from './notification.service.js';
import {
    upsertFirebaseDeviceToken,
    listOwnerTokens,
    removeFirebaseDeviceToken,
    replaceFirebaseDeviceToken,
    detachFirebaseDeviceTokenEverywhere,
} from './firebase.service.js';
import { uniquePhone } from '../../utils/testIds.js';

/**
 * The inbox and the FCM token lists.
 *
 * Token registration is the interesting half: it happens from several places at
 * once (login, app resume, token refresh), so append has to be atomic or a
 * device silently stops receiving pushes. It is a raw array_append_capped,
 * which only a real database can exercise.
 */
let userId;
let otherUserId;
let broadcastId;
let adminId;

test.before(async () => {
    const [user, other, admin] = await Promise.all([
        prisma.foodUser.create({ data: { phone: uniquePhone('91') } }),
        prisma.foodUser.create({ data: { phone: uniquePhone('92') } }),
        prisma.foodAdmin.create({
            data: { email: `notif-${Date.now()}@test.local`, password: 'x' },
        }),
    ]);
    userId = user.id;
    otherUserId = other.id;
    adminId = admin.id;

    const broadcast = await prisma.notificationBroadcast.create({
        data: { title: 'Test', message: 'Hello', targetType: 'ALL', createdById: admin.id },
    });
    broadcastId = broadcast.id;
});

test.after(async () => {
    await prisma.foodNotification.deleteMany({ where: { ownerId: { in: [userId, otherUserId] } } });
    await prisma.notificationBroadcast.deleteMany({ where: { id: broadcastId } });
    // By id, not by email pattern. This deleted every admin whose address
    // contained '@test.local' — which is how the other admin tests name theirs
    // too, so under --test-concurrency this teardown reached into whichever
    // file happened to be running and deleted its fixtures. adminSubAdmin's
    // duplicate-email test is the one that notices.
    await prisma.foodAdmin.deleteMany({ where: { id: adminId } });
    await prisma.foodUser.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
    await prisma.$disconnect();
});

// ── inbox ──

test('a broadcast fan-out is idempotent', async () => {
    const payload = {
        notifications: [
            { ownerType: 'USER', ownerId: userId, title: 'Offer', message: '50% off', broadcastId },
        ],
    };

    await createInboxNotifications(payload);
    await createInboxNotifications(payload);

    // (broadcastId, ownerType, ownerId) is unique, so re-running a broadcast
    // cannot double-post to the same recipient.
    const { items } = await getInboxNotifications({ ownerType: 'USER', ownerId: userId });
    assert.equal(items.length, 1);
});

test('re-sending resurfaces a dismissed notification', async () => {
    const { items } = await getInboxNotifications({ ownerType: 'USER', ownerId: userId });
    await dismissNotification({ notificationId: items[0].id, ownerType: 'USER', ownerId: userId });

    let after = await getInboxNotifications({ ownerType: 'USER', ownerId: userId });
    assert.equal(after.items.length, 0, 'dismissed notifications leave the inbox');

    await createInboxNotifications({
        notifications: [
            { ownerType: 'USER', ownerId: userId, title: 'Offer', message: '50% off', broadcastId },
        ],
    });

    after = await getInboxNotifications({ ownerType: 'USER', ownerId: userId });
    assert.equal(after.items.length, 1);
});

test('a resurfaced notification stays read', async () => {
    // isRead is only ever set on insert (the old bulkWrite used $setOnInsert), so
    // re-sending a broadcast the recipient already read and dismissed brings it
    // back to the inbox without pretending it is new.
    const inbox = await getInboxNotifications({ ownerType: 'USER', ownerId: userId });
    assert.equal(inbox.items.length, 1);
    assert.equal(inbox.items[0].isRead, true);
    assert.equal(inbox.unreadCount, 0);
});

test('a genuinely new notification is unread, and reading it clears the count', async () => {
    await createInboxNotifications({
        notifications: [
            { ownerType: 'USER', ownerId: userId, title: 'Fresh', message: 'Brand new' },
        ],
    });

    const before = await getInboxNotifications({ ownerType: 'USER', ownerId: userId });
    assert.equal(before.unreadCount, 1);

    const fresh = before.items.find((n) => n.title === 'Fresh');
    await markNotificationAsRead({ notificationId: fresh.id, ownerType: 'USER', ownerId: userId });

    const after = await getInboxNotifications({ ownerType: 'USER', ownerId: userId });
    assert.equal(after.unreadCount, 0);
    assert.equal(after.items.length, before.items.length, 'reading does not remove it from the inbox');
});

test('another owner cannot read or dismiss your notification', async () => {
    const { items } = await getInboxNotifications({ ownerType: 'USER', ownerId: userId });
    assert.ok(items.length > 0);

    // Ownership is in the WHERE clause, so it reads as "not found" rather than
    // confirming the notification exists.
    await assert.rejects(
        () => markNotificationAsRead({ notificationId: items[0].id, ownerType: 'USER', ownerId: otherUserId }),
        /Notification not found/,
    );
});

test('dismissAll empties the inbox and reports how many moved', async () => {
    await createInboxNotifications({
        notifications: [
            { ownerType: 'USER', ownerId: userId, title: 'Second', message: 'Another one' },
        ],
    });

    const result = await dismissAllNotifications({ ownerType: 'USER', ownerId: userId });
    assert.ok(result.modifiedCount >= 1);

    const after = await getInboxNotifications({ ownerType: 'USER', ownerId: userId });
    assert.equal(after.items.length, 0);
});

// ── FCM device tokens ──

const owner = () => ({ ownerType: 'USER', ownerId: userId, platform: 'mobile' });

test('registering a token twice does not duplicate it', async () => {
    await upsertFirebaseDeviceToken({ ...owner(), token: 'tok-A' });
    await upsertFirebaseDeviceToken({ ...owner(), token: 'tok-A' });

    const tokens = await listOwnerTokens(owner());
    assert.deepEqual(tokens, ['tok-A']);
});

test('the token list is capped, evicting the oldest device', async () => {
    for (const t of ['tok-B', 'tok-C', 'tok-D']) {
        await upsertFirebaseDeviceToken({ ...owner(), token: t });
    }

    const tokens = await listOwnerTokens(owner());
    assert.equal(tokens.length, 3, 'three devices max per platform');
    assert.ok(!tokens.includes('tok-A'), 'the oldest registration is evicted');
    assert.deepEqual(tokens, ['tok-B', 'tok-C', 'tok-D']);
});

test('re-registering an existing token moves it to newest', async () => {
    // Otherwise a device in daily use could be evicted ahead of one that has not
    // checked in for weeks.
    await upsertFirebaseDeviceToken({ ...owner(), token: 'tok-B' });
    assert.deepEqual(await listOwnerTokens(owner()), ['tok-C', 'tok-D', 'tok-B']);
});

test('concurrent registrations do not lose any token', async () => {
    await removeFirebaseDeviceToken({ ownerType: 'USER', ownerId: userId });

    // The real failure mode: login, app resume and token refresh all register at
    // once. A read-modify-write drops all but one.
    await Promise.all(['c1', 'c2', 'c3'].map((t) =>
        upsertFirebaseDeviceToken({ ...owner(), token: t })));

    const tokens = await listOwnerTokens(owner());
    assert.equal(tokens.length, 3);
    assert.deepEqual([...tokens].sort(), ['c1', 'c2', 'c3']);
});

test('a token can only belong to one owner', async () => {
    await upsertFirebaseDeviceToken({ ownerType: 'USER', ownerId: userId, token: 'shared', platform: 'mobile' });
    // Same handset, different account: the previous owner must lose it, or both
    // accounts get every push.
    await upsertFirebaseDeviceToken({ ownerType: 'USER', ownerId: otherUserId, token: 'shared', platform: 'mobile' });

    assert.ok(!(await listOwnerTokens({ ownerType: 'USER', ownerId: userId, platform: 'mobile' })).includes('shared'));
    assert.ok((await listOwnerTokens({ ownerType: 'USER', ownerId: otherUserId, platform: 'mobile' })).includes('shared'));
});

test('a token never sits in both platform buckets', async () => {
    await upsertFirebaseDeviceToken({ ownerType: 'USER', ownerId: userId, token: 'dual', platform: 'web' });
    await upsertFirebaseDeviceToken({ ownerType: 'USER', ownerId: userId, token: 'dual', platform: 'mobile' });

    const web = await listOwnerTokens({ ownerType: 'USER', ownerId: userId, platform: 'web' });
    const mobile = await listOwnerTokens({ ownerType: 'USER', ownerId: userId, platform: 'mobile' });
    assert.ok(!web.includes('dual'));
    assert.ok(mobile.includes('dual'));
});

test('replace makes a token the only one, for single-device roles', async () => {
    await replaceFirebaseDeviceToken({ ownerType: 'USER', ownerId: userId, token: 'only-one', platform: 'mobile' });

    const all = await listOwnerTokens({ ownerType: 'USER', ownerId: userId });
    assert.deepEqual(all, ['only-one'], 'signing in elsewhere must silence the old handset');
});

test('logout with no token clears the whole list', async () => {
    // The apps call this with an empty body on logout; it used to throw, so the
    // token stayed attached and a signed-out rider kept getting order alerts.
    const result = await removeFirebaseDeviceToken({ ownerType: 'USER', ownerId: userId });
    assert.equal(result.cleared, 'all');
    assert.deepEqual(await listOwnerTokens({ ownerType: 'USER', ownerId: userId }), []);
});

test('detaching an unknown token is a no-op, not an error', async () => {
    const result = await detachFirebaseDeviceTokenEverywhere('never-registered');
    assert.equal(result.success, true);
});

test('detaching takes the token off every owner and both platforms', async () => {
    // One device, registered against two accounts and both buckets — what
    // happens when someone signs out and a colleague signs in on the same
    // phone. Left attached, the previous owner keeps receiving the new
    // owner's order notifications.
    const token = `shared-device-${Date.now()}`;
    await Promise.all([
        upsertFirebaseDeviceToken({ ownerType: 'USER', ownerId: userId, token, platform: 'web' }),
        upsertFirebaseDeviceToken({ ownerType: 'USER', ownerId: userId, token, platform: 'android' }),
        upsertFirebaseDeviceToken({ ownerType: 'USER', ownerId: otherUserId, token, platform: 'web' }),
    ]);

    const before = await prisma.foodUser.findMany({
        where: { id: { in: [userId, otherUserId] } },
        select: { fcmTokens: true, fcmTokenMobile: true },
    });
    assert.equal(
        before.filter((u) => u.fcmTokens.includes(token) || u.fcmTokenMobile.includes(token)).length,
        2,
        'the fixture has to actually attach the token, or the assertion below proves nothing',
    );

    await detachFirebaseDeviceTokenEverywhere(token);

    const after = await prisma.foodUser.findMany({
        where: { id: { in: [userId, otherUserId] } },
        select: { fcmTokens: true, fcmTokenMobile: true },
    });
    for (const owner of after) {
        assert.ok(!owner.fcmTokens.includes(token), 'still attached on web');
        assert.ok(!owner.fcmTokenMobile.includes(token), 'still attached on mobile');
    }
});
