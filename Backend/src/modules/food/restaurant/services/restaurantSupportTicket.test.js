import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../../config/prisma.js';
import { uniquePhone, uniqueTag } from '../../../../utils/testIds.js';
import {
    createRestaurantSupportTicket,
    listRestaurantSupportTickets,
} from './restaurantSupportTicket.service.js';
import { listMyWithdrawals } from './restaurantWithdrawal.service.js';

/**
 * A restaurant's own support tickets and withdrawal history.
 */
const created = { restaurants: [], tickets: [], withdrawals: [] };
let restaurantId = null;

test.before(async () => {
    const r = await prisma.foodRestaurant.create({
        data: {
            restaurantName: `Ticket ${uniqueTag('R')}`,
            ownerName: 'Owner',
            ownerPhone: uniquePhone('9'),
            status: 'approved',
        },
    });
    created.restaurants.push(r.id);
    restaurantId = r.id;
});

test.after(async () => {
    await prisma.foodRestaurantSupportTicket.deleteMany({ where: { restaurantId: { in: created.restaurants } } });
    await prisma.foodRestaurantWithdrawal.deleteMany({ where: { restaurantId: { in: created.restaurants } } });
    await prisma.foodRestaurant.deleteMany({ where: { id: { in: created.restaurants } } });
    await prisma.$disconnect();
});

test('a ticket needs a known category, a type and a known priority', async () => {
    const base = { category: 'payments', issueType: 'Payout delayed' };

    await assert.rejects(
        () => createRestaurantSupportTicket(restaurantId, { ...base, category: 'billing' }),
        /Invalid category/,
    );
    await assert.rejects(
        () => createRestaurantSupportTicket(restaurantId, { ...base, issueType: '  ' }),
        /issueType required/,
    );
    await assert.rejects(
        () => createRestaurantSupportTicket(restaurantId, { ...base, priority: 'urgent' }),
        /Invalid priority/,
    );

    // Case and stray spaces in the category are tolerated.
    const ticket = await createRestaurantSupportTicket(restaurantId, { ...base, category: ' Payments ' });
    created.tickets.push(ticket.id);
    assert.equal(ticket.category, 'payments');
    assert.equal(ticket.priority, 'medium', 'defaults to medium');
    assert.equal(ticket.status, 'open');
});

test('orderId is accepted as an alias for orderRef', async () => {
    const ticket = await createRestaurantSupportTicket(restaurantId, {
        category: 'orders',
        issueType: 'Wrong item',
        orderId: 'FOD-12345',
    });
    created.tickets.push(ticket.id);
    assert.equal(ticket.orderRef, 'FOD-12345');
});

test('the in-progress filter maps to the enum name', async () => {
    const tag = uniqueTag('IP');
    const ticket = await createRestaurantSupportTicket(restaurantId, {
        category: 'technical',
        issueType: 'App crash',
        subject: `${tag} crashes on open`,
    });
    created.tickets.push(ticket.id);
    await prisma.foodRestaurantSupportTicket.update({
        where: { id: ticket.id },
        data: { status: 'in_progress' },
    });

    // The API says 'in-progress'; the Prisma enum member is in_progress. Passing
    // the wire value straight through would throw.
    const found = await listRestaurantSupportTickets(restaurantId, { status: 'in-progress' });
    assert.ok(found.tickets.some((t) => t.id === ticket.id));

    const open = await listRestaurantSupportTickets(restaurantId, { status: 'open' });
    assert.ok(!open.tickets.some((t) => t.id === ticket.id));

    // An unknown status is ignored rather than matching nothing.
    const all = await listRestaurantSupportTickets(restaurantId, { status: 'banana', search: tag });
    assert.equal(all.total, 1);
});

test('search covers subject, type, description and order reference', async () => {
    const tag = uniqueTag('S');
    const ticket = await createRestaurantSupportTicket(restaurantId, {
        category: 'menu',
        issueType: 'Item missing',
        description: `The ${tag} dish never shows`,
    });
    created.tickets.push(ticket.id);

    // Regex metacharacters used to be escaped by hand; `contains` is literal.
    const found = await listRestaurantSupportTickets(restaurantId, { search: tag.toLowerCase() });
    assert.equal(found.total, 1, 'case-insensitive');
    assert.equal(found.tickets[0].id, ticket.id);
});

test('a restaurant sees only its own tickets', async () => {
    const other = await prisma.foodRestaurant.create({
        data: {
            restaurantName: `Other ${uniqueTag('R')}`,
            ownerName: 'Owner',
            ownerPhone: uniquePhone('9'),
            status: 'approved',
        },
    });
    created.restaurants.push(other.id);

    const mine = await listRestaurantSupportTickets(restaurantId, {});
    const theirs = await listRestaurantSupportTickets(other.id, {});
    assert.ok(mine.total > 0);
    assert.equal(theirs.total, 0);
});

test('withdrawals come back newest first, with numeric amounts', async () => {
    const older = await prisma.foodRestaurantWithdrawal.create({
        data: { restaurantId, amount: 500, createdAt: new Date('2026-01-01') },
    });
    const newer = await prisma.foodRestaurantWithdrawal.create({
        data: { restaurantId, amount: 1250.5, createdAt: new Date('2026-02-01') },
    });
    created.withdrawals.push(older.id, newer.id);

    const list = await listMyWithdrawals(restaurantId);
    assert.equal(list[0].id, newer.id);
    // Decimal, so it would otherwise reach the client as a string.
    assert.equal(list[0].amount, 1250.5);
    assert.equal(list[1].amount, 500);
});
