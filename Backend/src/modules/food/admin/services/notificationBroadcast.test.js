import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../../config/prisma.js';
import { uniquePhone, uniqueTag } from '../../../../utils/testIds.js';
import {
    createBroadcastNotification,
    getBroadcastNotifications,
    deleteBroadcastNotification,
} from './notificationBroadcast.service.js';

/**
 * Admin broadcasts.
 *
 * The audience is the part with teeth: a broadcast must not reach a suspended
 * restaurant or a rider who was never approved, and deleting one has to take
 * its inbox rows with it.
 */
const live = Boolean(process.env.DATABASE_URL);

const created = { admins: [], users: [], restaurants: [], partners: [], broadcasts: [] };
let adminId = null;

test.before(async () => {
    if (!live) return;
    const admin = await prisma.foodAdmin.create({
        data: {
            name: `Broadcaster ${uniqueTag('A')}`,
            email: `${uniqueTag('a')}@admin.test`,
            password: 'x',
        },
    });
    created.admins.push(admin.id);
    adminId = admin.id;
});

test.after(async () => {
    if (!live) return;
    await prisma.foodNotification.deleteMany({ where: { broadcastId: { in: created.broadcasts } } });
    await prisma.notificationBroadcast.deleteMany({ where: { id: { in: created.broadcasts } } });
    await prisma.foodUser.deleteMany({ where: { id: { in: created.users } } });
    await prisma.foodRestaurant.deleteMany({ where: { id: { in: created.restaurants } } });
    await prisma.foodDeliveryPartner.deleteMany({ where: { id: { in: created.partners } } });
    await prisma.foodAdmin.deleteMany({ where: { id: { in: created.admins } } });
    await prisma.$disconnect();
});

const send = async (body) => {
    const { broadcast, targetPreview } = await createBroadcastNotification({ body, adminId });
    created.broadcasts.push(broadcast.id);
    return { broadcast, targetPreview };
};

test('a restaurant broadcast skips restaurants that are not approved', { skip: !live }, async () => {
    const tag = uniqueTag('B');
    const approved = await prisma.foodRestaurant.create({
        data: {
            restaurantName: `${tag} Open`,
            ownerName: 'Owner',
            ownerPhone: uniquePhone('9'),
            ownerEmail: `${tag}@rest.test`,
            status: 'approved',
        },
    });
    const pending = await prisma.foodRestaurant.create({
        data: {
            restaurantName: `${tag} Waiting`,
            ownerName: 'Owner',
            ownerPhone: uniquePhone('9'),
            status: 'pending',
        },
    });
    created.restaurants.push(approved.id, pending.id);

    const { broadcast } = await send({
        title: 'Menu deadline',
        message: 'Please update your menu',
        targetType: 'RESTAURANT',
    });

    assert.equal(broadcast.targetType, 'RESTAURANT');
    assert.deepEqual(broadcast.targetIds, [], 'only a custom broadcast records ids');

    const reached = await prisma.foodNotification.findMany({
        where: { broadcastId: broadcast.id },
        select: { ownerId: true, ownerType: true, metadata: true },
    });
    const ids = reached.map((n) => n.ownerId);
    assert.ok(ids.includes(approved.id));
    assert.ok(!ids.includes(pending.id), 'an unapproved restaurant is not an audience');
    assert.ok(reached.every((n) => n.ownerType === 'RESTAURANT'));

    // The audience is snapshotted so the history survives the accounts changing.
    const snapshot = broadcast.targets.find((t) => t.ownerId === approved.id);
    assert.equal(snapshot.label, `${tag} Open`);
    assert.ok(snapshot.subLabel.includes(`${tag}@rest.test`));

    const inbox = reached.find((n) => n.ownerId === approved.id);
    assert.equal(inbox.metadata.ownerLabel, `${tag} Open`);
});

test('a custom broadcast records exactly the ids it was given', { skip: !live }, async () => {
    const tag = uniqueTag('C');
    const one = await prisma.foodUser.create({ data: { name: `${tag} One`, phone: uniquePhone('5') } });
    const two = await prisma.foodUser.create({ data: { name: `${tag} Two`, phone: uniquePhone('5') } });
    const off = await prisma.foodUser.create({
        data: { name: `${tag} Gone`, phone: uniquePhone('5'), isActive: false },
    });
    created.users.push(one.id, two.id, off.id);

    const { broadcast } = await send({
        title: 'Coupon',
        message: 'Here is 10% off',
        targetType: 'CUSTOM',
        // The deactivated account and the junk id are both dropped.
        targetIds: [one.id, two.id, one.id, off.id, 'not-an-id'],
    });

    assert.equal(broadcast.targetCount, 2);
    assert.deepEqual([...broadcast.targetIds].sort(), [one.id, two.id].sort());

    await assert.rejects(
        () => createBroadcastNotification({
            body: { title: 't', message: 'm', targetType: 'CUSTOM', targetIds: [] },
            adminId,
        }),
        /select at least one recipient/,
    );
});

test('an explicit target list wins over ids, and duplicates collapse', { skip: !live }, async () => {
    const tag = uniqueTag('E');
    const user = await prisma.foodUser.create({ data: { name: `${tag} Pick`, phone: uniquePhone('5') } });
    created.users.push(user.id);

    const { broadcast, targetPreview } = await send({
        title: 'Hello',
        message: 'There',
        targetType: 'CUSTOM',
        targets: [
            { ownerType: 'USER', ownerId: user.id, label: 'First' },
            { ownerType: 'USER', ownerId: user.id, label: 'Second' },
            { ownerType: 'USER', ownerId: 'nope' },
        ],
    });

    assert.equal(broadcast.targetCount, 1);
    assert.equal(targetPreview[0].label, 'Second', 'the later entry wins');
});

test('the input is validated before anyone is contacted', { skip: !live }, async () => {
    const body = { title: 'T', message: 'M', targetType: 'USER' };

    await assert.rejects(
        () => createBroadcastNotification({ body: { ...body, title: ' ' }, adminId }),
        /title is required/,
    );
    await assert.rejects(
        () => createBroadcastNotification({ body: { ...body, message: '' }, adminId }),
        /message is required/,
    );
    await assert.rejects(
        () => createBroadcastNotification({ body: { ...body, targetType: 'EVERYONE' }, adminId }),
        /targetType is invalid/,
    );
    await assert.rejects(
        () => createBroadcastNotification({ body, adminId: 'not-an-id' }),
        /createdBy is invalid/,
    );
});

test('the history labels its audience and pages', { skip: !live }, async () => {
    const { items, pagination } = await getBroadcastNotifications({ page: 1, limit: 5 });

    assert.ok(items.length <= 5);
    assert.ok(pagination.total >= 3);
    assert.ok(items[0].createdBy.name, 'the sender is joined in');

    const custom = items.find((i) => i.targetType === 'CUSTOM');
    assert.match(custom.targetLabel, /selected recipients$/);

    const restaurants = items.find((i) => i.targetType === 'RESTAURANT');
    assert.equal(restaurants.targetLabel, 'Restaurants');
});

test('deleting a broadcast takes its inbox rows with it', { skip: !live }, async () => {
    const user = await prisma.foodUser.create({ data: { phone: uniquePhone('5') } });
    created.users.push(user.id);

    const { broadcast } = await send({
        title: 'Temporary',
        message: 'Will be removed',
        targetType: 'CUSTOM',
        targetIds: [user.id],
    });

    const result = await deleteBroadcastNotification(broadcast.id);
    assert.equal(result.deletedInboxCount, 1);
    // The FK cascades, so nothing is left pointing at a broadcast that is gone.
    assert.equal(await prisma.foodNotification.count({ where: { broadcastId: broadcast.id } }), 0);

    await assert.rejects(() => deleteBroadcastNotification(broadcast.id), /not found/);
    await assert.rejects(() => deleteBroadcastNotification('not-an-id'), /broadcastId is invalid/);
});
