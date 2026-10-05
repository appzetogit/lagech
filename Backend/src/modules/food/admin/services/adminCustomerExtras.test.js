import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../../../../config/prisma.js';
import {
    addFundToCustomer,
    createWalletBonus,
    deleteNewsletterSubscriber,
    deleteWalletBonus,
    exportNewsletterSubscribersCsv,
    getUserOverview,
    listCustomerWalletTransactions,
    listLoyaltyPointTransactions,
    listNewsletterSubscribers,
    saveLoyaltySettings,
    searchCustomers,
    updateWalletBonus,
} from './adminCustomerExtras.service.js';
import { verifyWalletTopupPayment } from '../../user/services/userWallet.service.js';
import {
    awardOrderLoyaltyPoints,
    convertLoyaltyPoints,
    getMyLoyaltyPoints,
} from '../../user/services/loyaltyPoint.service.js';
import { subscribeToNewsletter } from '../../user/services/newsletter.service.js';

/**
 * Customer wallet, bonus, loyalty points and newsletter, against the real
 * database. Everything is created under a unique tag and removed afterwards;
 * the loyalty settings row is restored as it was.
 */
const tag = `T${Date.now()}`;
const istDay = (offsetDays) => new Date(Date.now() + 330 * 60000 + offsetDays * 86400000).toISOString().slice(0, 10);

let user;
let admin;
let loyaltySnapshot;
const bonusIds = [];

test.before(async () => {
    user = await prisma.foodUser.create({ data: { phone: `9${String(Date.now()).slice(-9)}`, name: `${tag} Asha` } });
    admin = await prisma.foodAdmin.create({ data: { email: `${tag.toLowerCase()}@test.local`, password: 'x', name: `${tag} Admin`, adminType: 'sub_admin' } });
    loyaltySnapshot = await prisma.foodLoyaltySettings.findFirst({ orderBy: { createdAt: 'desc' } });
});

test.after(async () => {
    await prisma.transaction.deleteMany({ where: { entityType: 'user', entityId: user.id } });
    await prisma.wallet.deleteMany({ where: { entityType: 'user', entityId: user.id } });
    await prisma.foodLoyaltyPointTransaction.deleteMany({ where: { userId: user.id } });
    await prisma.foodLoyaltyPointAccount.deleteMany({ where: { userId: user.id } });
    await prisma.foodWalletBonus.deleteMany({ where: { id: { in: bonusIds } } });
    await prisma.foodNewsletterSubscriber.deleteMany({ where: { email: { startsWith: tag.toLowerCase() } } });
    await prisma.foodUser.delete({ where: { id: user.id } });
    await prisma.foodAdmin.delete({ where: { id: admin.id } });
    await prisma.foodLoyaltySettings.deleteMany({});
    if (loyaltySnapshot) {
        const { id, createdAt, updatedAt, ...values } = loyaltySnapshot;
        await prisma.foodLoyaltySettings.create({ data: { id, ...values } });
    }
    await prisma.$disconnect();
});

test('an admin credit lands in the customer wallet once, stamped with who did it', async () => {
    const found = await searchCustomers({ search: tag });
    assert.equal(found.length, 1);
    assert.equal(found[0].walletBalance, 0);

    const requestId = `${tag}-1`;
    const first = await addFundToCustomer(admin.id, { userId: user.id, amount: 250, reference: 'Goodwill', requestId });
    const again = await addFundToCustomer(admin.id, { userId: user.id, amount: 250, reference: 'Goodwill', requestId });
    assert.equal(first.walletBalance, 250);
    assert.equal(again.transaction.id, first.transaction.id, 'a double submit credits once');

    const wallet = await prisma.wallet.findUnique({ where: { entityType_entityId: { entityType: 'user', entityId: user.id } } });
    assert.equal(Number(wallet.balance), 250);

    const report = await listCustomerWalletTransactions({ userId: user.id, source: 'add_fund' });
    assert.equal(report.transactions.length, 1);
    assert.equal(report.transactions[0].addedBy, `${tag} Admin`);
    assert.equal(report.transactions[0].reference, 'Goodwill');
    assert.equal(report.totals.credit, 250);

    await assert.rejects(() => addFundToCustomer(admin.id, { userId: user.id, amount: 0 }), /greater than 0/);
    await assert.rejects(() => addFundToCustomer(admin.id, { userId: 'nope', amount: 10 }), /Choose a customer/);
});

test('a top-up earns the best running bonus as its own entry, and a replay adds nothing', async () => {
    const pct = await createWalletBonus({ title: `${tag} ten percent`, bonusType: 'percentage', bonusAmount: 10, minimumAddAmount: 100, maximumBonus: 30, startDate: istDay(-1), endDate: istDay(1) });
    const flat = await createWalletBonus({ title: `${tag} flat`, bonusType: 'amount', bonusAmount: 20, minimumAddAmount: 100, startDate: istDay(-1), endDate: istDay(1) });
    const off = await createWalletBonus({ title: `${tag} off`, bonusType: 'amount', bonusAmount: 500, startDate: istDay(-1), endDate: istDay(1), isActive: false });
    bonusIds.push(pct.id, flat.id, off.id);
    assert.equal(off.state, 'off');

    // Test env has no Razorpay keys, so the dev branch credits the amount sent.
    const payload = { razorpayOrderId: `order_${tag}`, razorpayPaymentId: `pay_${tag}`, razorpaySignature: 'sig', amount: 500 };
    const result = await verifyWalletTopupPayment(user.id, payload);
    assert.equal(result.bonus.amount, 30, '10% of 500 capped at 30 beats the flat 20');
    await verifyWalletTopupPayment(user.id, payload);

    const bonuses = await listCustomerWalletTransactions({ userId: user.id, source: 'bonus' });
    assert.equal(bonuses.transactions.length, 1, 'one bonus, however often the callback arrives');
    const topups = await listCustomerWalletTransactions({ userId: user.id, source: 'top_up' });
    assert.equal(topups.transactions.length, 1);

    await updateWalletBonus(pct.id, { isActive: false });
    await assert.rejects(() => createWalletBonus({ title: 'x', bonusType: 'percentage', bonusAmount: 150, startDate: istDay(0), endDate: istDay(1) }), /at most 100%/);
    await assert.rejects(() => createWalletBonus({ title: 'x', bonusType: 'amount', bonusAmount: 5, startDate: istDay(2), endDate: istDay(1) }), /End date/);
    await deleteWalletBonus(off.id);
    await assert.rejects(() => deleteWalletBonus(off.id), /not found/);
});

test('points convert into wallet balance atomically, once per request', async () => {
    await assert.rejects(() => saveLoyaltySettings({ isEnabled: true, pointsPerHundred: 0, pointsPerRupee: 10 }), /before switching/);
    await saveLoyaltySettings({ isEnabled: true, pointsPerHundred: 5, pointsPerRupee: 10, minimumConvertPoints: 50 });

    await prisma.foodLoyaltyPointAccount.create({ data: { userId: user.id, points: 120, totalEarned: 120 } });
    const before = await prisma.wallet.findUnique({ where: { entityType_entityId: { entityType: 'user', entityId: user.id } } });

    await assert.rejects(() => convertLoyaltyPoints(user.id, { points: 40 }), /at least 50/);
    await assert.rejects(() => convertLoyaltyPoints(user.id, { points: 500 }), /do not have/);

    const requestId = `${tag}-convert`;
    const done = await convertLoyaltyPoints(user.id, { points: 100, requestId });
    await convertLoyaltyPoints(user.id, { points: 100, requestId });
    assert.equal(done.points, 20);
    assert.equal(done.wallet.balance, Number(before.balance) + 10, '100 points at 10 per rupee is ₹10');

    const mine = await getMyLoyaltyPoints(user.id);
    assert.equal(mine.transactions.length, 1, 'the retried request did nothing');

    const report = await listLoyaltyPointTransactions({ userId: user.id, type: 'debit' });
    assert.equal(report.totals.converted, 100);
    assert.equal(report.totals.walletPaid, 10);
    const wallet = await listCustomerWalletTransactions({ userId: user.id, source: 'loyalty_point' });
    assert.equal(wallet.transactions[0].amount, 10);

    assert.deepEqual(await awardOrderLoyaltyPoints('000000000000000000000000'), { awarded: false, reason: 'order_not_found' });
});

test('subscribing twice keeps one entry; the list searches, exports and deletes', async () => {
    const email = `${tag.toLowerCase()}@example.com`;
    await subscribeToNewsletter(`  ${email.toUpperCase()} `);
    await subscribeToNewsletter(email);
    await assert.rejects(() => subscribeToNewsletter('nope'), /valid email/);

    const list = await listNewsletterSubscribers({ search: tag });
    assert.equal(list.subscribers.length, 1);
    assert.equal(list.subscribers[0].email, email);
    assert.match(await exportNewsletterSubscribersCsv({ search: tag }), new RegExp(`^Email,Subscribed at\\r\\n${email},`));

    await deleteNewsletterSubscriber(list.subscribers[0].id);
    assert.equal((await listNewsletterSubscribers({ search: tag })).subscribers.length, 0);
});

test('the user overview counts the customer and the employee created here', async () => {
    const overview = await getUserOverview();
    assert.ok(overview.customers.total >= 1);
    assert.ok(overview.customers.newThisMonth >= 1);
    assert.equal(overview.customers.signupsByMonth.length, 6);
    assert.ok(overview.employees.total >= 1);
    assert.equal(overview.riders.total, overview.riders.approved + overview.riders.pending + overview.riders.rejected + overview.riders.deactivated);
});
