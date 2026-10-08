import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../config/prisma.js';
import { uniquePhone, uniqueTag } from '../../utils/testIds.js';
import {
    EMAIL_SETTINGS_KEY,
    deliverEmail,
    flushEmails,
    queueEmail,
    setEmailTransportForTests,
} from './transactionalEmail.js';
import { emailNewDeliveryPartnerRegistration, emailNewRestaurantRegistration } from './emailEvents.js';
import {
    approveRestaurant,
    rejectRestaurant,
    updateRestaurantStatus,
} from '../../modules/food/admin/services/adminRestaurantLifecycle.service.js';
import {
    approveDeliveryPartner,
    rejectDeliveryPartner,
    deleteDeliveryPartner,
} from '../../modules/food/admin/services/adminDeliveryPartner.service.js';
import { updateWithdrawalStatus, updateDeliveryWithdrawalStatus } from '../../modules/food/admin/services/adminWithdrawal.service.js';
import { approveRefundRequest, rejectRefundRequest } from '../../modules/food/orders/services/refundRequest.service.js';
import { addFundToCustomer } from '../../modules/food/admin/services/adminCustomerExtras.service.js';
import { updateCustomerStatus } from '../../modules/food/admin/services/adminCustomer.service.js';
import { getEmailSettings, saveEmailSettings, listEmailTemplates } from '../../modules/food/admin/services/emailTemplates.service.js';

/**
 * Transactional emails against the database, through the real service entry
 * points, with a fake transport: each hook sends once, a repeat sends nothing,
 * a switched-off email or a recipient without an address sends nothing, and a
 * transport that throws never breaks the action.
 */

const started = new Date();
const tag = uniqueTag('Mail');
const created = { restaurants: [], partners: [], users: [], orders: [], rWithdrawals: [], dWithdrawals: [], admins: [] };
const ADMIN_TO = `ops+${tag.toLowerCase()}@example.com`;

let sent = [];
let failNext = 0;
const transport = {
    async sendMail(message) {
        if (failNext > 0) {
            failNext -= 1;
            throw new Error('SMTP 451 temporary failure');
        }
        sent.push(message);
        return { messageId: String(sent.length) };
    },
};

const take = async () => {
    await flushEmails();
    const out = sent;
    sent = [];
    return out;
};

const makeRestaurant = async (over = {}) => {
    const r = await prisma.foodRestaurant.create({
        data: {
            restaurantName: `${tag} Kitchen ${created.restaurants.length}`,
            ownerName: 'Meera',
            ownerPhone: uniquePhone('9'),
            ownerEmail: `owner${created.restaurants.length}.${tag.toLowerCase()}@example.com`,
            status: 'pending',
            ...over,
        },
    });
    created.restaurants.push(r.id);
    return r;
};

const makePartner = async (over = {}) => {
    const p = await prisma.foodDeliveryPartner.create({
        data: {
            name: `${tag} Rider`,
            phone: uniquePhone('6'),
            email: `rider${created.partners.length}.${tag.toLowerCase()}@example.com`,
            status: 'pending',
            ...over,
        },
    });
    created.partners.push(p.id);
    return p;
};

const makeUser = async (email) => {
    const u = await prisma.foodUser.create({ data: { name: `${tag} Customer`, phone: uniquePhone('5'), email } });
    created.users.push(u.id);
    return u;
};

test.before(async () => {
    setEmailTransportForTests(transport);
    await prisma.foodSystemSetting.deleteMany({ where: { key: EMAIL_SETTINGS_KEY } });
    await saveEmailSettings({ adminRecipients: [ADMIN_TO] });
});

test.after(async () => {
    await flushEmails();
    setEmailTransportForTests(null);
    const users = created.users;
    await prisma.foodEmailSendLog.deleteMany({ where: { createdAt: { gte: started } } });
    await prisma.foodSystemSetting.deleteMany({ where: { key: EMAIL_SETTINGS_KEY } });
    await prisma.foodRefundRequest.deleteMany({ where: { userId: { in: users } } });
    await prisma.foodNotification.deleteMany({ where: { ownerId: { in: [...users, ...created.partners, ...created.restaurants] } } });
    await prisma.foodLoyaltyPointTransaction.deleteMany({ where: { userId: { in: users } } });
    await prisma.foodLoyaltyPointAccount.deleteMany({ where: { userId: { in: users } } });
    await prisma.foodTransaction.deleteMany({ where: { orderId: { in: created.orders } } });
    await prisma.transaction.deleteMany({ where: { entityId: { in: [...users, ...created.partners] } } });
    await prisma.wallet.deleteMany({ where: { entityId: { in: [...users, ...created.partners] } } });
    await prisma.foodOrder.deleteMany({ where: { id: { in: created.orders } } });
    await prisma.foodRestaurantWithdrawal.deleteMany({ where: { id: { in: created.rWithdrawals } } });
    await prisma.foodDeliveryWithdrawal.deleteMany({ where: { id: { in: created.dWithdrawals } } });
    await prisma.foodRefreshToken.deleteMany({ where: { userId: { in: users } } });
    await prisma.foodUser.deleteMany({ where: { id: { in: users } } });
    await prisma.foodDeliveryPartner.deleteMany({ where: { id: { in: created.partners } } });
    await prisma.foodRestaurant.deleteMany({ where: { id: { in: created.restaurants } } });
    await prisma.foodAdmin.deleteMany({ where: { id: { in: created.admins } } });
    await prisma.$disconnect();
});

test('sign-ups email the configured admin addresses, once per registration', async () => {
    const restaurant = await makeRestaurant();
    const partner = await makePartner();
    emailNewRestaurantRegistration(restaurant.id);
    emailNewRestaurantRegistration(restaurant.id); // a retried hook
    emailNewDeliveryPartnerRegistration(partner.id);
    const mails = await take();
    assert.equal(mails.length, 2);
    const toRestaurant = mails.find((m) => m.subject.includes(restaurant.restaurantName));
    assert.ok(toRestaurant);
    assert.equal(toRestaurant.to, ADMIN_TO);
    assert.match(toRestaurant.text, /Owner: Meera/);
    assert.ok(mails.find((m) => m.subject.startsWith('New delivery partner registration')));
});

test('restaurant approval and rejection email the owner once each', async () => {
    const restaurant = await makeRestaurant();
    await approveRestaurant(restaurant.id);
    await approveRestaurant(restaurant.id); // already approved: no second email
    let mails = await take();
    assert.equal(mails.length, 1);
    assert.equal(mails[0].to, restaurant.ownerEmail);
    assert.match(mails[0].subject, /is approved/);

    const other = await makeRestaurant();
    await rejectRestaurant(other.id, 'FSSAI licence unreadable');
    mails = await take();
    assert.equal(mails.length, 1);
    assert.match(mails[0].text, /Reason: FSSAI licence unreadable/);

    // No address on file: nothing is sent, and the decision still stands.
    const silent = await makeRestaurant({ ownerEmail: null });
    const approved = await approveRestaurant(silent.id);
    assert.equal(approved.status, 'approved');
    assert.equal((await take()).length, 0);
});

test('switching a restaurant off and on is a suspension and its lifting', async () => {
    const restaurant = await makeRestaurant({ status: 'approved' });
    await updateRestaurantStatus(restaurant.id, { isActive: false });
    await updateRestaurantStatus(restaurant.id, { isActive: false });
    let mails = await take();
    assert.equal(mails.length, 1);
    assert.match(mails[0].subject, /has been suspended/);
    assert.match(mails[0].text, /restaurant account/);

    await updateRestaurantStatus(restaurant.id, { isActive: true });
    mails = await take();
    assert.equal(mails.length, 1);
    assert.match(mails[0].subject, /active again/);
});

test('rider approval, rejection, deactivation and reactivation', async () => {
    const a = await makePartner();
    await approveDeliveryPartner(a.id);
    await approveDeliveryPartner(a.id);
    let mails = await take();
    assert.equal(mails.length, 1);
    assert.equal(mails[0].to, a.email);
    assert.match(mails[0].subject, /application is approved/);

    const b = await makePartner();
    await rejectDeliveryPartner(b.id, 'Licence expired');
    mails = await take();
    assert.equal(mails.length, 1);
    assert.match(mails[0].text, /Reason: Licence expired/);

    await deleteDeliveryPartner(a.id);
    mails = await take();
    assert.equal(mails.length, 1);
    assert.match(mails[0].text, /delivery partner account has been suspended/);

    await approveDeliveryPartner(a.id);
    mails = await take();
    assert.equal(mails.length, 1);
    assert.match(mails[0].subject, /active again/);
});

test('withdrawal decisions email the restaurant and the rider once', async () => {
    const restaurant = await makeRestaurant({ status: 'approved' });
    const rw = await prisma.foodRestaurantWithdrawal.create({ data: { restaurantId: restaurant.id, amount: 1500 } });
    created.rWithdrawals.push(rw.id);
    await updateWithdrawalStatus(rw.id, { status: 'approved', transactionId: 'UTR-77' });
    await assert.rejects(() => updateWithdrawalStatus(rw.id, { status: 'approved' }));
    let mails = await take();
    assert.equal(mails.length, 1);
    assert.equal(mails[0].to, restaurant.ownerEmail);
    assert.match(mails[0].subject, /₹1500 is approved/);
    assert.match(mails[0].text, /Reference: UTR-77/);

    const partner = await makePartner({ status: 'approved' });
    await prisma.wallet.create({ data: { entityType: 'deliveryBoy', entityId: partner.id, balance: 500, lockedAmount: 200 } });
    const dw = await prisma.foodDeliveryWithdrawal.create({ data: { deliveryPartnerId: partner.id, amount: 200 } });
    created.dWithdrawals.push(dw.id);
    await updateDeliveryWithdrawalStatus(dw.id, { status: 'rejected', rejectionReason: 'UPI id invalid' });
    await updateDeliveryWithdrawalStatus(dw.id, { status: 'rejected', rejectionReason: 'UPI id invalid' }); // already rejected
    mails = await take();
    assert.equal(mails.length, 1);
    assert.equal(mails[0].to, partner.email);
    assert.match(mails[0].text, /Reason: UPI id invalid/);
});

test('refund decisions email the customer, only when they have an address', async () => {
    const restaurant = await makeRestaurant({ status: 'approved' });
    const user = await makeUser(`cust.${tag.toLowerCase()}@example.com`);
    const order = async () => {
        const o = await prisma.foodOrder.create({
            data: {
                userId: user.id, restaurantId: restaurant.id, order_id: `FOD-${uniqueTag('m')}`.slice(0, 32),
                orderStatus: 'delivered', deliveredAt: new Date(), paymentMethod: 'cash', paymentStatus: 'paid',
                addrStreet: '1 Test Street', addrCity: 'Indore', addrState: 'MP', subtotal: 150, total: 150,
            },
        });
        created.orders.push(o.id);
        return o;
    };
    const request = (o) => prisma.foodRefundRequest.create({
        data: { orderId: o.id, userId: user.id, restaurantId: restaurant.id, reason: 'Food was cold', requestedAmount: 150 },
    });

    const first = await order();
    const approved = await approveRefundRequest((await request(first)).id, null, { amount: 100 });
    assert.equal(approved.status, 'refunded');
    let mails = await take();
    assert.equal(mails.length, 1);
    assert.equal(mails[0].to, user.email);
    assert.match(mails[0].text, /refund of ₹100 for order #FOD-/);

    const second = await order();
    const rejected = await rejectRefundRequest((await request(second)).id, null, { note: 'Photo shows a full plate' });
    assert.equal(rejected.status, 'rejected');
    mails = await take();
    assert.equal(mails.length, 1);
    assert.match(mails[0].text, /Reason: Photo shows a full plate/);

    // A customer with no email address: nothing is sent.
    const noEmail = await makeUser(null);
    const third = await prisma.foodOrder.create({
        data: {
            userId: noEmail.id, restaurantId: restaurant.id, order_id: `FOD-${uniqueTag('n')}`.slice(0, 32),
            orderStatus: 'delivered', deliveredAt: new Date(), paymentMethod: 'cash', paymentStatus: 'paid',
            addrStreet: '1 Test Street', addrCity: 'Indore', addrState: 'MP', subtotal: 150, total: 150,
        },
    });
    created.orders.push(third.id);
    const r3 = await prisma.foodRefundRequest.create({
        data: { orderId: third.id, userId: noEmail.id, restaurantId: restaurant.id, reason: 'x', requestedAmount: 150 },
    });
    await rejectRefundRequest(r3.id, null, { note: 'No' });
    assert.equal((await take()).length, 0);
});

test('an admin wallet credit emails once, even when the request is repeated', async () => {
    const user = await makeUser(`wallet.${tag.toLowerCase()}@example.com`);
    const admin = await prisma.foodAdmin.create({ data: { email: `admin.${tag.toLowerCase()}@test.local`, password: 'x', name: `${tag} Admin`, adminType: 'sub_admin' } });
    created.admins.push(admin.id);
    const body = { userId: user.id, amount: 250, reference: 'Goodwill', requestId: `${tag}-fund` };
    await addFundToCustomer(admin.id, body);
    await addFundToCustomer(admin.id, body);
    const mails = await take();
    assert.equal(mails.length, 1);
    assert.equal(mails[0].subject, '₹250 added to your wallet');
    assert.match(mails[0].text, /balance is now ₹250/);
});

test('blocking and unblocking a customer', async () => {
    const user = await makeUser(`block.${tag.toLowerCase()}@example.com`);
    await updateCustomerStatus(user.id, false);
    await updateCustomerStatus(user.id, false);
    let mails = await take();
    assert.equal(mails.length, 1);
    assert.match(mails[0].text, /customer account has been suspended/);
    await updateCustomerStatus(user.id, true);
    mails = await take();
    assert.equal(mails.length, 1);
    assert.match(mails[0].subject, /active again/);
});

test('a switched-off email is not sent; the admin page lists the switches', async () => {
    await saveEmailSettings({ switches: { account_suspended: false } });
    const user = await makeUser(`off.${tag.toLowerCase()}@example.com`);
    await updateCustomerStatus(user.id, false);
    assert.equal((await take()).length, 0);

    const { templates } = await listEmailTemplates();
    assert.equal(templates.find((t) => t.key === 'account_suspended').sendEnabled, false);
    assert.equal(templates.find((t) => t.key === 'account_unsuspended').sendEnabled, true);
    assert.equal(templates.find((t) => t.key === 'admin_password_reset').canDisable, false);
    await assert.rejects(() => saveEmailSettings({ switches: { admin_password_reset: false } }), /cannot be switched off/);
    await assert.rejects(() => saveEmailSettings({ adminRecipients: ['not-an-email'] }), /not an email address/);

    await saveEmailSettings({ switches: { account_suspended: true } });
    const settings = await getEmailSettings();
    assert.equal(settings.switches.account_suspended, true);
    assert.deepEqual(settings.adminRecipients, [ADMIN_TO]);
});

test('a transport failure never breaks the action, is logged, and may be retried', async () => {
    const user = await makeUser(`fail.${tag.toLowerCase()}@example.com`);
    failNext = 1;
    const updated = await updateCustomerStatus(user.id, false);
    assert.equal(updated.isActive, false, 'the block went through');
    assert.equal((await take()).length, 0);

    const log = await prisma.foodEmailSendLog.findFirst({ where: { templateKey: 'account_suspended', recipient: user.email } });
    assert.equal(log.status, 'failed');
    assert.match(log.error, /SMTP 451/);

    // The same event again (a retry): the failed key is claimed and sent.
    const job = { template: 'account_suspended', eventKey: log.eventKey, to: user.email, values: { userName: 'x', accountType: 'customer' } };
    assert.equal(await deliverEmail(job), 'sent');
    assert.equal(await deliverEmail(job), 'duplicate');
    assert.equal((await take()).length, 1);
    const after = await prisma.foodEmailSendLog.findUnique({ where: { eventKey: log.eventKey } });
    assert.equal(after.status, 'sent');
    assert.equal(after.attempts, 2);

    // A job that throws while being built is swallowed too.
    queueEmail(async () => { throw new Error('lookup failed'); });
    assert.equal((await take()).length, 0);
});
