import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

/**
 * Customer pays by Razorpay QR at the door.
 *
 * Razorpay is a FAKE client here (setRazorpayClientForTests), installed before
 * anything can call out, and the keys are fake too: no test may ever create a
 * QR, a payment or a refund on a real account.
 */
process.env.RAZORPAY_KEY_ID = 'rzp_test_fake_collectqr';
process.env.RAZORPAY_KEY_SECRET = 'fake-secret-collectqr';
process.env.RAZORPAY_WEBHOOK_SECRET = 'whsec-fake-collectqr';
const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET;

const helper = await import('../helpers/razorpay.helper.js');

/** A stand-in for the razorpay npm client: just the calls this flow makes. */
function makeFakeRazorpay() {
    let n = 0;
    const fake = {
        calls: [],
        qrFail: false,
        qrs: new Map(),
        qrPayments: new Map(),
        links: new Map(),
        refunds: [],
        qrCode: {
            async create(params) {
                fake.calls.push(['qr.create', params]);
                if (fake.qrFail) {
                    const err = new Error('QR codes not enabled');
                    err.error = { description: 'QR Codes feature is not enabled for this merchant' };
                    throw err;
                }
                const id = `qr_fake${++n}`;
                const qr = {
                    id,
                    entity: 'qr_code',
                    image_url: `https://rzp.io/fake/${id}.png`,
                    status: 'active',
                    close_by: params.close_by,
                    payment_amount: params.payment_amount,
                    payments_amount_received: 0,
                    notes: params.notes,
                };
                fake.qrs.set(id, qr);
                return qr;
            },
            async fetch(id) {
                fake.calls.push(['qr.fetch', id]);
                const qr = fake.qrs.get(id);
                if (!qr) throw new Error('not found');
                return qr;
            },
            async fetchAllPayments(id) {
                fake.calls.push(['qr.payments', id]);
                return { items: fake.qrPayments.get(id) || [] };
            },
            async close(id) {
                fake.calls.push(['qr.close', id]);
                const qr = fake.qrs.get(id);
                if (qr) qr.status = 'closed';
                return qr;
            },
        },
        paymentLink: {
            async create(params) {
                fake.calls.push(['link.create', params]);
                const id = `plink_fake${++n}`;
                const link = {
                    id,
                    short_url: `https://rzp.io/i/${id}`,
                    status: 'created',
                    amount: params.amount,
                    expire_by: params.expire_by,
                    notes: params.notes,
                    payments: [],
                };
                fake.links.set(id, link);
                return link;
            },
            async fetch(id) {
                fake.calls.push(['link.fetch', id]);
                return fake.links.get(id);
            },
            async cancel(id) {
                fake.calls.push(['link.cancel', id]);
                const link = fake.links.get(id);
                if (link) link.status = 'cancelled';
                return link;
            },
        },
        payments: {
            async refund(paymentId, params) {
                fake.calls.push(['refund', paymentId, params.amount]);
                fake.refunds.push({ paymentId, amount: params.amount });
                return { id: `rfnd_fake${++n}`, status: 'processed' };
            },
            async fetch() {
                throw new Error('not used');
            },
        },
        /** The customer scans and pays a QR. */
        payQr(qrId, amountPaise) {
            const qr = fake.qrs.get(qrId);
            const payment = { id: `pay_fake${++n}`, entity: 'payment', amount: amountPaise, status: 'captured', method: 'upi' };
            fake.qrPayments.set(qrId, [...(fake.qrPayments.get(qrId) || []), payment]);
            qr.payments_amount_received += amountPaise;
            qr.status = 'closed';
            qr.close_reason = 'paid';
            return payment;
        },
        count(kind) {
            return fake.calls.filter((c) => c[0] === kind).length;
        },
    };
    return fake;
}

const fake = makeFakeRazorpay();
helper.setRazorpayClientForTests(fake);

const { prisma } = await import('../../../../config/prisma.js');
const { uniquePhone, uniqueTag } = await import('../../../../utils/testIds.js');
const payments = await import('./order-payment.service.js');
const { completeDelivery, updateOrderStatusDelivery } = await import('./order-delivery.service.js');
const { getCashInHandMap } = await import('../../delivery/services/riderCash.service.js');
const { getRiderBalances } = await import('../../admin/services/adminBalanceSheet.service.js');
const { getOrderMoneyReport } = await import('../../admin/services/adminOrderMoneyReport.service.js');
const { handleRazorpayWebhook } = await import('../../../../core/payments/controllers/razorpayWebhook.controller.js');

const { createCollectQr, getPaymentStatus, switchToCash, recordQrPayment } = payments;

const events = [];
payments.setPaymentEventListenerForTests((event) => events.push(event));

const created = { orders: [], users: [], restaurants: [], partners: [] };
let restaurantId;
let userId;
let partnerId;
let otherPartnerId;
let tag;

test.before(async () => {
    tag = uniqueTag('CQr');
    const restaurant = await prisma.foodRestaurant.create({
        data: { restaurantName: `${tag} Kitchen`, ownerName: 'Owner', ownerPhone: uniquePhone('9'), status: 'approved' },
    });
    created.restaurants.push(restaurant.id);
    restaurantId = restaurant.id;

    const user = await prisma.foodUser.create({ data: { phone: uniquePhone('5'), name: `${tag} Diner` } });
    created.users.push(user.id);
    userId = user.id;

    const other = await prisma.foodDeliveryPartner.create({
        data: { name: `${tag} Other`, phone: uniquePhone('6'), status: 'approved' },
    });
    created.partners.push(other.id);
    otherPartnerId = other.id;
    partnerId = await newRider();
});

test.after(async () => {
    helper.setRazorpayClientForTests(null);
    payments.setPaymentEventListenerForTests(null);
    // completeDelivery fires a few best-effort hooks; let them settle first.
    await new Promise((r) => setTimeout(r, 500));
    await prisma.foodTransactionHistory.deleteMany({ where: { transaction: { orderId: { in: created.orders } } } });
    await prisma.foodTransaction.deleteMany({ where: { orderId: { in: created.orders } } });
    await prisma.orderStatusHistory.deleteMany({ where: { orderId: { in: created.orders } } }).catch(() => {});
    await prisma.foodOrder.deleteMany({ where: { id: { in: created.orders } } }).catch(() => {});
    await prisma.foodDeliveryPartner.deleteMany({ where: { id: { in: created.partners } } }).catch(() => {});
    await prisma.foodUser.deleteMany({ where: { id: { in: created.users } } }).catch(() => {});
    await prisma.foodRestaurant.deleteMany({ where: { id: { in: created.restaurants } } }).catch(() => {});
    await prisma.$disconnect();
});

async function newRider() {
    const rider = await prisma.foodDeliveryPartner.create({
        data: { name: `${tag} Rider`, phone: uniquePhone('6'), status: 'approved' },
    });
    created.partners.push(rider.id);
    return rider.id;
}

/** An order picked up and on its way, with its ledger row. */
async function outForDelivery({
    paymentMethod = 'cash',
    paymentStatus = 'cod_pending',
    total = 500,
    walletAmount = 0,
    rider = partnerId,
    orderStatus = 'picked_up',
    withTransaction = true,
} = {}) {
    const code = `${tag}-${uniqueTag('O')}`;
    const order = await prisma.foodOrder.create({
        data: {
            userId,
            restaurantId,
            dispatchDeliveryPartnerId: rider,
            order_id: code,
            orderId: code,
            orderStatus,
            pickedUpAt: new Date(),
            paymentMethod,
            paymentStatus,
            walletAmount,
            paymentAmountDue: total - walletAmount,
            addrStreet: '1 Test Street', addrCity: 'Indore', addrState: 'MP',
            subtotal: total,
            total,
            riderEarning: 35,
        },
    });
    created.orders.push(order.id);
    if (withTransaction) {
        await prisma.foodTransaction.create({
            data: {
                orderId: order.id,
                userId,
                restaurantId,
                deliveryPartnerId: rider,
                paymentMethod,
                paymentStatusLabel: paymentStatus,
                amountDue: total - walletAmount,
                walletAmount,
                currency: 'INR',
                status: 'pending',
                subtotal: total,
                total,
                totalCustomerPaid: total,
                restaurantShare: 400,
                commissionAmount: 50,
                riderShare: 35,
                platformNetProfit: 15,
            },
        });
    }
    return order;
}

/** Calls the real webhook handler with a correctly signed body. */
async function deliverWebhook(body) {
    const raw = Buffer.from(JSON.stringify(body));
    const signature = crypto.createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex');
    const req = { headers: { 'x-razorpay-signature': signature }, rawBody: raw, body: JSON.parse(raw.toString()) };
    const res = {
        code: 200,
        status(c) { this.code = c; return this; },
        json(b) { this.body = b; return this; },
        send(b) { this.body = b; return this; },
    };
    await handleRazorpayWebhook(req, res);
    return res;
}

const qrCreditedEvent = (qrId, payment) => {
    const qr = fake.qrs.get(qrId);
    return {
        event: 'qr_code.credited',
        payload: {
            payment: { entity: { ...payment, notes: [] } },
            qr_code: { entity: { ...qr } },
        },
    };
};

/** Yesterday to tomorrow, so the report periods hold "now" in any time zone. */
const AROUND_NOW = () => ({
    from: new Date(Date.now() - 86400000).toISOString().slice(0, 10),
    to: new Date(Date.now() + 86400000).toISOString().slice(0, 10),
});

const orderRow = (id) => prisma.foodOrder.findUnique({ where: { id } });
const txRow = (id) => prisma.foodTransaction.findUnique({ where: { orderId: id } });

// ── creating the QR ──

test('a QR is raised for the full amount due, single use, fixed amount, ~15 minutes', async () => {
    const order = await outForDelivery({ total: 640 });
    const before = Math.floor(Date.now() / 1000);

    const qr = await createCollectQr(order.id, partnerId);

    const [, params] = fake.calls.filter((c) => c[0] === 'qr.create').at(-1);
    assert.equal(params.type, 'upi_qr');
    assert.equal(params.usage, 'single_use');
    assert.equal(params.fixed_amount, true);
    assert.equal(params.payment_amount, 64000, 'paise');
    assert.ok(params.close_by >= before + 14 * 60 && params.close_by <= before + 16 * 60, 'about 15 minutes');
    assert.equal(params.notes.orderId, order.id);
    assert.equal(params.notes.purpose, 'cod_collect');

    assert.equal(qr.kind, 'qr');
    assert.ok(qr.qrId.startsWith('qr_fake'));
    assert.equal(qr.imageUrl, fake.qrs.get(qr.qrId).image_url, "Razorpay's own image");
    assert.equal(qr.amount, 640);
    assert.ok(new Date(qr.expiresAt) > new Date());
    assert.equal(qr.status, 'created');

    const [row, tx] = [await orderRow(order.id), await txRow(order.id)];
    assert.equal(row.paymentMethod, 'razorpay_qr');
    assert.equal(row.paymentStatus, 'pending_qr');
    assert.equal(row.qr.qrId, qr.qrId);
    assert.equal(tx.paymentMethod, 'razorpay_qr');
});

test('a partial payment (wallet + cash) puts only the cash part on the QR', async () => {
    const order = await outForDelivery({ total: 500, walletAmount: 120 });

    const qr = await createCollectQr(order.id, partnerId);

    assert.equal(qr.amount, 380);
    assert.equal(fake.qrs.get(qr.qrId).payment_amount, 38000);
});

test('asking again hands back the open QR instead of raising another', async () => {
    const order = await outForDelivery();
    const first = await createCollectQr(order.id, partnerId);
    const creates = fake.count('qr.create');

    const again = await createCollectQr(order.id, partnerId);

    assert.equal(again.qrId, first.qrId);
    assert.equal(again.reused, true);
    assert.equal(fake.count('qr.create'), creates, 'no new QR at Razorpay');
});

test('an expired QR is closed and replaced', async () => {
    const order = await outForDelivery();
    const first = await createCollectQr(order.id, partnerId);
    await prisma.foodOrder.update({
        where: { id: order.id },
        data: { qr: { ...(await orderRow(order.id)).qr, expiresAt: new Date(Date.now() - 1000).toISOString() } },
    });

    const status = await getPaymentStatus(order.id, partnerId);
    assert.equal(status.qr.status, 'expired', 'the app is told to offer a new QR');

    const second = await createCollectQr(order.id, partnerId);
    assert.notEqual(second.qrId, first.qrId);
    assert.ok(fake.calls.some((c) => c[0] === 'qr.close' && c[1] === first.qrId), 'the old one was closed');
});

test('refused: not your order, prepaid, already paid, cancelled, nothing due', async () => {
    const mine = await outForDelivery();
    await assert.rejects(() => createCollectQr(mine.id, otherPartnerId), /not your order/i);

    const prepaid = await outForDelivery({ paymentMethod: 'razorpay', paymentStatus: 'authorized' });
    await assert.rejects(() => createCollectQr(prepaid.id, partnerId), /nothing to collect/i);

    const paid = await outForDelivery({ paymentMethod: 'razorpay_qr', paymentStatus: 'paid' });
    await assert.rejects(() => createCollectQr(paid.id, partnerId), /already paid/i);

    const cancelled = await outForDelivery({ orderStatus: 'cancelled_by_admin' });
    await assert.rejects(() => createCollectQr(cancelled.id, partnerId), /cancelled/i);

    const allWallet = await outForDelivery({ total: 300, walletAmount: 300 });
    await assert.rejects(() => createCollectQr(allWallet.id, partnerId), /no amount due/i);
});

test('without the QR Codes feature a payment link is raised instead', async () => {
    const order = await outForDelivery({ total: 250 });
    fake.qrFail = true;
    try {
        const qr = await createCollectQr(order.id, partnerId);
        assert.equal(qr.kind, 'link');
        assert.ok(qr.shortUrl.startsWith('https://rzp.io/i/'));
        assert.equal(qr.imageUrl, null, 'the app draws the QR from the link');
        assert.equal(qr.amount, 250);
        const link = fake.links.get(qr.paymentLinkId);
        assert.equal(link.amount, 25000);
        assert.equal(link.notes.orderId, order.id);
        assert.equal(link.notes.purpose, 'cod_collect');
    } finally {
        fake.qrFail = false;
    }
});

// ── payment confirmed ──

test('webhook qr_code.credited marks the order paid by QR, tells the rider, and is idempotent', async () => {
    const rider = await newRider();
    const order = await outForDelivery({ total: 450, rider });
    const qr = await createCollectQr(order.id, rider);
    const payment = fake.payQr(qr.qrId, 45000);
    events.length = 0;

    const res = await deliverWebhook(qrCreditedEvent(qr.qrId, payment));
    assert.equal(res.code, 200);

    const [row, tx] = [await orderRow(order.id), await txRow(order.id)];
    assert.equal(row.paymentMethod, 'razorpay_qr');
    assert.equal(row.paymentStatus, 'paid');
    assert.equal(row.razorpayPaymentId, payment.id);
    assert.equal(Number(row.riderEarning), 35, 'rider pay unchanged');
    assert.equal(tx.paymentMethod, 'razorpay_qr');
    assert.equal(tx.paymentStatusLabel, 'paid');
    assert.equal(tx.status, 'captured', 'online money received, like a checkout payment');
    assert.equal(tx.razorpayPaymentId, payment.id);
    assert.equal(Number(tx.restaurantShare), 400, 'restaurant settlement unchanged');

    assert.equal(events.length, 1);
    assert.equal(events[0].orderId, order.id);
    assert.equal(events[0].method, 'razorpay_qr');
    assert.equal(events[0].amount, 450);

    // Replays (and the payment.captured that follows) change nothing.
    await deliverWebhook(qrCreditedEvent(qr.qrId, payment));
    await deliverWebhook({
        event: 'payment.captured',
        payload: { payment: { entity: { ...payment, order_id: null, notes: { orderId: order.id, purpose: 'cod_collect' } } } },
    });
    assert.equal(events.length, 1, 'one notification');
    assert.equal(fake.refunds.filter((r) => r.paymentId === payment.id).length, 0, 'nothing refunded');
    const history = await prisma.foodTransactionHistory.findMany({
        where: { transaction: { orderId: order.id }, kind: 'captured' },
    });
    assert.equal(history.length, 1, 'one ledger entry');

    // Delivered: the money went to the platform, so the rider holds no cash for it.
    await completeDelivery(order.id, rider, {});
    const cash = await getCashInHandMap([rider]);
    assert.equal(cash.get(rider), 0);
    const delivered = await orderRow(order.id);
    assert.equal(delivered.orderStatus, 'delivered');
    assert.equal(delivered.paymentMethod, 'razorpay_qr');
});

test('a QR-paid order is not rider cash on the balance sheet; a cash order is', async () => {
    const rider = await newRider();
    const qrOrder = await outForDelivery({ total: 300, rider });
    const qr = await createCollectQr(qrOrder.id, rider);
    await recordQrPayment({ orderId: qrOrder.id, paymentId: fake.payQr(qr.qrId, 30000).id, amountPaise: 30000 });
    await completeDelivery(qrOrder.id, rider, {});

    const cashOrder = await outForDelivery({ total: 200, rider });
    await completeDelivery(cashOrder.id, rider, {});
    await prisma.foodTransaction.update({ where: { orderId: cashOrder.id }, data: { status: 'captured' } });

    const cash = await getCashInHandMap([rider]);
    assert.equal(cash.get(rider), 200, 'only the cash order');

    const { rows } = await getRiderBalances(AROUND_NOW());
    const mine = rows.find((r) => r.entityId === rider);
    assert.ok(mine, 'rider on the balance sheet');
    assert.equal(mine.cashCollected, 200);
    assert.equal(mine.deliveries, 2);
});

test('the transaction report shows Razorpay QR, received by Admin', async () => {
    const rider = await newRider();
    const order = await outForDelivery({ total: 350, rider });
    const qr = await createCollectQr(order.id, rider);
    await recordQrPayment({ orderId: order.id, paymentId: fake.payQr(qr.qrId, 35000).id, amountPaise: 35000 });
    await completeDelivery(order.id, rider, {});

    const report = await getOrderMoneyReport({ ...AROUND_NOW(), status: 'all', search: order.orderId, limit: 10 });
    const row = report.orders.find((r) => r.id === order.id);
    assert.ok(row, 'order in the report');
    assert.equal(row.paymentMethodLabel, 'Razorpay QR');
    assert.equal(row.amountReceivedBy, 'Admin');
});

test('polling asks Razorpay when the webhook has not come, at most once per few seconds', async () => {
    const order = await outForDelivery({ total: 275 });
    const qr = await createCollectQr(order.id, partnerId);
    payments.resetQrPollLimiterForTests();

    const pending = await getPaymentStatus(order.id, partnerId);
    assert.equal(pending.paid, false);
    assert.equal(pending.qr.qrId, qr.qrId);
    const fetches = fake.count('qr.fetch');
    await getPaymentStatus(order.id, partnerId);
    assert.equal(fake.count('qr.fetch'), fetches, 'rate limited: no second Razorpay call');

    const payment = fake.payQr(qr.qrId, 27500);
    payments.resetQrPollLimiterForTests();
    const status = await getPaymentStatus(order.id, partnerId);
    assert.equal(status.paid, true);
    assert.equal(status.paidByQr, true);
    assert.equal(status.collectCash, false);
    assert.equal((await orderRow(order.id)).razorpayPaymentId, payment.id);
});

test('a paid payment link settles the order through the webhook', async () => {
    const order = await outForDelivery({ total: 180 });
    fake.qrFail = true;
    let qr;
    try { qr = await createCollectQr(order.id, partnerId); } finally { fake.qrFail = false; }

    await deliverWebhook({
        event: 'payment_link.paid',
        payload: {
            payment_link: { entity: { id: qr.paymentLinkId, status: 'paid', notes: { orderId: order.id, purpose: 'cod_collect' } } },
            payment: { entity: { id: 'pay_linkfake1', amount: 18000, status: 'captured', order_id: 'order_plinkfake' } },
        },
    });

    const row = await orderRow(order.id);
    assert.equal(row.paymentStatus, 'paid');
    assert.equal(row.paymentMethod, 'razorpay_qr');
});

// ── switching to cash ──

test('switching to cash closes the open QR and leaves a cash order', async () => {
    const order = await outForDelivery();
    const qr = await createCollectQr(order.id, partnerId);

    const result = await switchToCash(order.id, partnerId);

    assert.equal(result.success, true);
    assert.ok(fake.calls.some((c) => c[0] === 'qr.close' && c[1] === qr.qrId), 'QR closed at Razorpay');
    const row = await orderRow(order.id);
    assert.equal(row.paymentMethod, 'cash');
    assert.equal(row.paymentStatus, 'cod_pending');
});

test('switching to cash is refused when the customer already paid the QR', async () => {
    const order = await outForDelivery();
    const qr = await createCollectQr(order.id, partnerId);
    fake.payQr(qr.qrId, 50000);

    await assert.rejects(() => switchToCash(order.id, partnerId), /already paid by QR/i);
    assert.equal((await orderRow(order.id)).paymentStatus, 'paid');
});

test('a QR payment that lands after switching to cash still counts, and the rider is told not to take cash', async () => {
    const rider = await newRider();
    const order = await outForDelivery({ total: 220, rider });
    const qr = await createCollectQr(order.id, rider);
    await switchToCash(order.id, rider);
    events.length = 0;

    // The customer had already scanned before the QR closed.
    const payment = fake.payQr(qr.qrId, 22000);
    await deliverWebhook(qrCreditedEvent(qr.qrId, payment));

    const row = await orderRow(order.id);
    assert.equal(row.paymentMethod, 'razorpay_qr', 'paid by QR, not cash');
    assert.equal(row.paymentStatus, 'paid');
    assert.equal(events.length, 1);
    assert.equal(events[0].collectCash, false);
    assert.match(events[0].message, /do not collect cash/i);
    assert.equal(fake.refunds.filter((r) => r.paymentId === payment.id).length, 0);

    await completeDelivery(order.id, rider, {});
    assert.equal((await getCashInHandMap([rider])).get(rider), 0, 'not the rider cash');
});

test('a second payment for an already-paid order is refunded automatically, once', async () => {
    const rider = await newRider();
    const order = await outForDelivery({ total: 260, rider });
    const qr = await createCollectQr(order.id, rider);
    await switchToCash(order.id, rider);
    await completeDelivery(order.id, rider, {}); // cash taken and delivered
    assert.equal((await orderRow(order.id)).paymentStatus, 'paid');

    const payment = fake.payQr(qr.qrId, 26000);
    await deliverWebhook(qrCreditedEvent(qr.qrId, payment));
    await deliverWebhook(qrCreditedEvent(qr.qrId, payment)); // replay

    const refunds = fake.refunds.filter((r) => r.paymentId === payment.id);
    assert.equal(refunds.length, 1, 'refunded exactly once');
    assert.equal(refunds[0].amount, 26000);
    const row = await orderRow(order.id);
    assert.equal(row.paymentMethod, 'cash', 'the cash collection stands');
    assert.ok(row.qr.extraPaymentIds.includes(payment.id));
    const logged = await prisma.foodTransactionHistory.findMany({
        where: { transaction: { orderId: order.id }, kind: 'qr_extra_payment_refunded' },
    });
    assert.equal(logged.length, 1);
    assert.equal((await getCashInHandMap([rider])).get(rider), 260, 'the rider holds the cash');
});

test('a payment of the wrong amount is not taken as payment', async () => {
    const order = await outForDelivery({ total: 400 });
    await createCollectQr(order.id, partnerId);

    const out = await recordQrPayment({ orderId: order.id, paymentId: 'pay_short1', amountPaise: 10000 });

    assert.equal(out.outcome, 'refunded');
    assert.notEqual((await orderRow(order.id)).paymentStatus, 'paid');
});

// ── delivery guard ──

test('an unpaid QR order cannot be marked delivered; the cash path still works', async () => {
    const order = await outForDelivery();
    await createCollectQr(order.id, partnerId);

    await assert.rejects(() => completeDelivery(order.id, partnerId, {}), /QR payment not verified/i);
    // Not through the plain status endpoint either.
    await assert.rejects(
        () => updateOrderStatusDelivery(order.id, partnerId, 'delivered'),
        /QR payment not verified/i,
    );
    assert.equal((await orderRow(order.id)).orderStatus, 'picked_up');

    await switchToCash(order.id, partnerId);
    await completeDelivery(order.id, partnerId, {});
    const row = await orderRow(order.id);
    assert.equal(row.orderStatus, 'delivered');
    assert.equal(row.paymentMethod, 'cash');
    assert.equal(row.paymentStatus, 'paid');
});

test('checkout payments without a Razorpay order id do not touch other orders', async () => {
    const order = await outForDelivery();
    await deliverWebhook({
        event: 'payment.captured',
        payload: { payment: { entity: { id: 'pay_stray1', amount: 50000, status: 'captured', order_id: null, notes: [] } } },
    });
    const row = await orderRow(order.id);
    assert.equal(row.paymentStatus, 'cod_pending');
});
