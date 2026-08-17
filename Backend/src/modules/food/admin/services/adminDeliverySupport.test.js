import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../../config/prisma.js';
import { uniquePhone, uniqueTag } from '../../../../utils/testIds.js';
import {
    getSupportTicketStats,
    getDeliverySupportTickets,
    updateDeliverySupportTicket,
    updateRestaurantSubscriptionSettings,
    getDeliveryPartnerBonusTransactions,
    getDeliverymanReviews,
} from './adminDeliverySupport.service.js';

/**
 * Rider support, bonus history, reviews, and the subscription GMV bands.
 *
 * The bands are the one with teeth: they decide which monthly plan a
 * restaurant lands on, so a gap or an overlap prices someone wrongly.
 */
const live = Boolean(process.env.DATABASE_URL);

const created = {
    partners: [], restaurants: [], users: [], orders: [],
    tickets: [], bonuses: [], notifications: [],
};

// The subscription settings are a singleton; restored after the test edits it.
let settingsSnapshot = null;

const makePartner = async (name) => {
    const p = await prisma.foodDeliveryPartner.create({
        data: { name, phone: uniquePhone('6'), status: 'approved' },
    });
    created.partners.push(p.id);
    return p;
};

test.before(async () => {
    if (!live) return;
    settingsSnapshot = await prisma.foodRestaurantSubscriptionSettings.findFirst();
});

test.after(async () => {
    if (!live) return;
    await prisma.foodNotification.deleteMany({ where: { ownerId: { in: created.partners } } });
    await prisma.deliverySupportTicket.deleteMany({ where: { id: { in: created.tickets } } });
    await prisma.deliveryBonusTransaction.deleteMany({ where: { id: { in: created.bonuses } } });
    await prisma.foodOrder.deleteMany({ where: { id: { in: created.orders } } });
    await prisma.foodDeliveryPartner.deleteMany({ where: { id: { in: created.partners } } });
    await prisma.foodUser.deleteMany({ where: { id: { in: created.users } } });
    await prisma.foodRestaurant.deleteMany({ where: { id: { in: created.restaurants } } });
    if (settingsSnapshot) {
        const { id, _id, createdAt, updatedAt, ...values } = settingsSnapshot;
        // Restored by id, not updated by it: these tables hold one row, and a
        // test that deletes it makes the service create a replacement with a
        // new id — so an update keyed on the old id finds nothing.
        await prisma.foodRestaurantSubscriptionSettings.deleteMany({});
        await prisma.foodRestaurantSubscriptionSettings.create({ data: { id, ...values } });
    } else {
        // The test created the singleton; leaving it behind would give every
        // later run a different starting point.
        await prisma.foodRestaurantSubscriptionSettings.deleteMany({});
    }
    await prisma.$disconnect();
});

test('rider tickets filter and join their partner', { skip: !live }, async () => {
    const tag = uniqueTag('Tk');
    const partner = await makePartner(`${tag} Rider`);

    const ticket = await prisma.deliverySupportTicket.create({
        data: {
            deliveryPartnerId: partner.id,
            ticketId: `${tag}-001`,
            subject: `${tag} app keeps logging me out`,
            description: 'Every few minutes',
            priority: 'high',
        },
    });
    created.tickets.push(ticket.id);

    const bySearch = await getDeliverySupportTickets({ search: tag });
    assert.equal(bySearch.pagination.total, 1);
    assert.equal(bySearch.tickets[0].deliveryPartner.name, `${tag} Rider`);

    const byPriority = await getDeliverySupportTickets({ priority: 'high' });
    assert.ok(byPriority.tickets.some((t) => t.id === ticket.id));

    const byStatus = await getDeliverySupportTickets({ status: 'open' });
    assert.ok(byStatus.tickets.some((t) => t.id === ticket.id));

    // An unrecognised status is ignored rather than matching nothing.
    const bogus = await getDeliverySupportTickets({ status: 'not-a-status', search: tag });
    assert.equal(bogus.pagination.total, 1);
});

test('replying to a rider ticket stamps and notifies', { skip: !live }, async () => {
    const partner = await makePartner(uniqueTag('R'));
    const ticket = await prisma.deliverySupportTicket.create({
        data: {
            deliveryPartnerId: partner.id,
            subject: 'Payout missing',
            description: 'Last week',
        },
    });
    created.tickets.push(ticket.id);

    const replied = await updateDeliverySupportTicket(ticket.id, {
        status: 'resolved',
        adminResponse: 'Paid today',
    });
    assert.equal(replied.status, 'resolved');
    assert.equal(replied.adminResponse, 'Paid today');
    assert.ok(replied.respondedAt, 'the reply is timestamped');

    const notification = await prisma.foodNotification.findFirst({
        where: { ownerId: partner.id, source: 'SUPPORT_RESPONSE' },
    });
    assert.ok(notification);
    assert.ok(notification.message.includes('Payout missing'));

    // A status-only change is not a reply and does not re-notify.
    await updateDeliverySupportTicket(ticket.id, { status: 'closed' });
    const count = await prisma.foodNotification.count({
        where: { ownerId: partner.id, source: 'SUPPORT_RESPONSE' },
    });
    assert.equal(count, 1);

    assert.equal(await updateDeliverySupportTicket('a'.repeat(24), { status: 'open' }), null);
    assert.equal(await updateDeliverySupportTicket('not-an-id', {}), null);
});

test('ticket stats add up', { skip: !live }, async () => {
    const stats = await getSupportTicketStats();
    assert.equal(
        stats.total,
        stats.open + stats.inProgress + stats.resolved + stats.closed,
    );
});

test('the GMV bands stay ordered and contiguous', { skip: !live }, async () => {
    // Deliberately inconsistent: growth starts below where starter ends, and
    // premium starts below where growth ends.
    const saved = await updateRestaurantSubscriptionSettings({
        starterPrice: 500,
        starterMinGmv: 0,
        starterMaxGmv: 100000,
        growthMinGmv: 50000,
        growthMaxGmv: 40000,
        premiumMinGmv: 10000,
    });

    // Each band has to start where the last one ended, or a restaurant's
    // turnover falls into a gap and matches no plan.
    assert.ok(saved.growthMinGmv >= saved.starterMaxGmv);
    assert.ok(saved.growthMaxGmv >= saved.growthMinGmv);
    assert.ok(saved.premiumMinGmv >= saved.growthMaxGmv);
});

test('a negative subscription price is clamped', { skip: !live }, async () => {
    await updateRestaurantSubscriptionSettings({ starterPrice: -100 });

    // Asserted on the row, not the reader: the reader treats a price of 0 as
    // unset and substitutes the default, so it would hide the clamp.
    const row = await prisma.foodRestaurantSubscriptionSettings.findFirst({
        orderBy: { createdAt: 'desc' },
    });
    assert.equal(Number(row.starterPrice), 0);
});

test('bonus history searches by rider or reference', { skip: !live }, async () => {
    const tag = uniqueTag('Bn');
    const partner = await makePartner(`${tag} Bonus Rider`);

    const bonus = await prisma.deliveryBonusTransaction.create({
        data: {
            deliveryPartnerId: partner.id,
            transactionId: `${tag}-TXN`,
            amount: 250,
            reference: 'Weekend push',
        },
    });
    created.bonuses.push(bonus.id);

    // The rider's name lives on another table; the filter reaches through the
    // relation rather than pre-resolving an id list.
    const byName = await getDeliveryPartnerBonusTransactions({ search: `${tag} Bonus` });
    assert.equal(byName.pagination.total, 1);
    assert.equal(byName.transactions[0].deliveryman, `${tag} Bonus Rider`);
    assert.equal(byName.transactions[0].amount, 250, 'Decimal converted for the table');
    assert.equal(byName.transactions[0].bonus, 250, 'the legacy key still carries it');
    assert.match(byName.transactions[0].deliveryId, /^DP-/);

    const byTxn = await getDeliveryPartnerBonusTransactions({ search: `${tag}-TXN` });
    assert.equal(byTxn.pagination.total, 1);
});

test('rider reviews come from the rating columns', { skip: !live }, async () => {
    const tag = uniqueTag('Rv');
    const partner = await makePartner(`${tag} Reviewed`);

    const user = await prisma.foodUser.create({
        data: { name: `${tag} Customer`, phone: uniquePhone('5') },
    });
    created.users.push(user.id);

    const restaurant = await prisma.foodRestaurant.create({
        data: {
            restaurantName: `${tag} Rest`,
            ownerName: 'Owner',
            ownerPhone: uniquePhone('9'),
            status: 'approved',
        },
    });
    created.restaurants.push(restaurant.id);

    const base = {
        userId: user.id,
        restaurantId: restaurant.id,
        dispatchDeliveryPartnerId: partner.id,
        orderStatus: 'delivered',
        paymentMethod: 'cash',
        addrStreet: '1 Test Street',
        addrCity: 'Indore',
        addrState: 'MP',
        subtotal: 100,
        total: 100,
    };

    const rated = await prisma.foodOrder.create({
        data: {
            ...base,
            orderId: `${tag}-rated`,
            partnerRating: 5,
            partnerRatingComment: 'Very quick',
            deliveredAt: new Date(),
        },
    });
    // An unrated delivery is not a review.
    const unrated = await prisma.foodOrder.create({
        data: { ...base, orderId: `${tag}-unrated` },
    });
    created.orders.push(rated.id, unrated.id);

    const { reviews, total } = await getDeliverymanReviews({ search: tag });
    assert.equal(total, 1);
    assert.equal(reviews[0].rating, 5);
    assert.equal(reviews[0].review, 'Very quick');
    assert.equal(reviews[0].deliveryman, `${tag} Reviewed`);
    assert.equal(reviews[0].customer, `${tag} Customer`);
    assert.ok(reviews[0].submittedAt, 'stamped from the delivery, not the order');
});
