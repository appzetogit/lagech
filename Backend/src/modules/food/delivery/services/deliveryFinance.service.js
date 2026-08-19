import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { getDeliveryCashLimitSettings } from '../../admin/services/admin.service.js';
import { ValidationError } from '../../../../core/auth/errors.js';
import {
    createRazorpayOrder,
    getRazorpayKeyId,
    isRazorpayConfigured,
    verifyPaymentSignature,
    fetchRazorpayPayment,
} from '../../orders/helpers/razorpay.helper.js';
import { logger } from '../../../../utils/logger.js';

const num = (v) => Number(v) || 0;

/** The rider's wallet row in the unified wallets table. */
const walletKey = (deliveryPartnerId) => ({
    entityType_entityId: { entityType: 'deliveryBoy', entityId: String(deliveryPartnerId) },
});

/**
 * Enhanced wallet fetch for delivery partners. Integrates:
 * 1. Historical orders (earnings)
 * 2. Admin bonuses
 * 3. Withdrawals (pending/payout)
 * 4. Cash collected vs limit
 */
export const getDeliveryPartnerWalletEnhanced = async (deliveryPartnerId) => {
    if (!isId(deliveryPartnerId)) throw new ValidationError('Invalid delivery partner ID');
    const partnerId = String(deliveryPartnerId);

    const partner = await prisma.foodDeliveryPartner.findUnique({ where: { id: partnerId } });
    if (!partner) throw new ValidationError('Delivery partner not found');

    const [
        cashLimitSettings,
        earningsAgg,
        cashCollectedAgg,
        cashDepositsAgg,
        bonusAgg,
        withdrawalsByStatus,
        withdrawalsList,
        depositList,
        walletDoc,
        ordersTx,
    ] = await Promise.all([
        getDeliveryCashLimitSettings(),
        // 1. Total earnings from delivered orders
        prisma.foodOrder.aggregate({
            where: { dispatchDeliveryPartnerId: partnerId, orderStatus: 'delivered' },
            _sum: { riderEarning: true },
        }),
        // 2. Gross cash collected (COD orders)
        prisma.foodOrder.aggregate({
            where: {
                dispatchDeliveryPartnerId: partnerId,
                orderStatus: 'delivered',
                paymentMethod: 'cash',
            },
            _sum: { total: true },
        }),
        // 3. Cash deposits (deduct from cash-in-hand)
        prisma.foodDeliveryCashDeposit.aggregate({
            where: { deliveryPartnerId: partnerId, status: 'Completed' },
            _sum: { amount: true },
        }),
        // 4. Admin bonuses
        prisma.deliveryBonusTransaction.aggregate({
            where: { deliveryPartnerId: partnerId },
            _sum: { amount: true },
        }),
        // 5. Withdrawal totals. groupBy replaces the $cond sums — one pass, one row per status.
        prisma.foodDeliveryWithdrawal.groupBy({
            by: ['status'],
            where: { deliveryPartnerId: partnerId },
            _sum: { amount: true },
        }),
        // 6. Recent history
        prisma.foodDeliveryWithdrawal.findMany({
            where: { deliveryPartnerId: partnerId },
            orderBy: { createdAt: 'desc' },
            take: 50,
        }),
        prisma.foodDeliveryCashDeposit.findMany({
            where: { deliveryPartnerId: partnerId },
            orderBy: { createdAt: 'desc' },
            take: 50,
        }),
        prisma.wallet.findUnique({ where: walletKey(partnerId) }),
        prisma.foodOrder.findMany({
            where: { dispatchDeliveryPartnerId: partnerId, orderStatus: 'delivered' },
            orderBy: { createdAt: 'desc' },
            select: {
                id: true, orderId: true, riderEarning: true, paymentMethod: true,
                orderStatus: true, createdAt: true,
            },
            take: 20,
        }),
    ]);

    const byStatus = (status) =>
        num(withdrawalsByStatus.find((r) => r.status === status)?._sum?.amount);

    const aggTotalEarned = num(earningsAgg?._sum?.riderEarning);
    const grossCashCollected = num(cashCollectedAgg?._sum?.total);
    const totalDepositedCash = num(cashDepositsAgg?._sum?.amount);
    const computedCashInHand = Math.max(0, grossCashCollected - totalDepositedCash);
    const aggTotalBonus = num(bonusAgg?._sum?.amount);
    const aggTotalWithdrawn = byStatus('approved');
    const pendingWithdrawals = byStatus('pending');

    // Merge computed metrics with wallet ledger values, so admin bonuses and manual
    // wallet adjustments are not lost behind stale pocket totals.
    const walletBalance = num(walletDoc?.balance);
    const walletLockedAmount = num(walletDoc?.lockedAmount);
    const walletCashInHand = num(walletDoc?.cashInHand);
    const walletTotalEarnings = num(walletDoc?.totalEarnings);
    const walletTotalBonus = num(walletDoc?.totalBonus);
    const walletTotalSettled = num(walletDoc?.totalSettled);

    const totalEarned = Math.max(aggTotalEarned, walletTotalEarnings);
    const totalBonus = Math.max(aggTotalBonus, walletTotalBonus);
    const totalWithdrawn = Math.max(aggTotalWithdrawn, walletTotalSettled);
    const cashInHand = Math.max(computedCashInHand, walletCashInHand);

    const totalCashLimit = num(cashLimitSettings.deliveryCashLimit);
    const deliveryWithdrawalLimit = num(cashLimitSettings.deliveryWithdrawalLimit) || 100;

    // Pocket balance = (earnings + bonus) − approved withdrawals − pending withdrawals,
    // floored at the ledger balance so manual adjustments are honoured.
    const computedPocketBalance = Math.max(
        0,
        totalEarned + totalBonus - (totalWithdrawn + pendingWithdrawals),
    );
    const effectiveLockedAmount = Math.max(walletLockedAmount, pendingWithdrawals);
    const availableWalletBalance = Math.max(0, walletBalance - effectiveLockedAmount);
    const pocketBalance = Math.max(computedPocketBalance, availableWalletBalance);

    const transactions = [
        ...(ordersTx || []).map((o) => ({
            id: o.id,
            type: 'payment',
            amount: num(o.riderEarning),
            status: 'Completed',
            date: o.createdAt,
            description: o.paymentMethod === 'cash' ? 'COD delivery earning' : 'Online delivery earning',
            orderId: o.orderId,
        })),
        ...(withdrawalsList || []).map((w) => ({
            id: w.id,
            type: 'withdrawal',
            amount: num(w.amount),
            status: w.status === 'pending' ? 'Pending' : w.status === 'approved' ? 'Completed' : 'Rejected',
            date: w.createdAt,
            description: `Withdrawal Request - ${w.paymentMethod}`,
            payoutMethod: w.paymentMethod,
        })),
        ...(depositList || []).map((d) => ({
            id: d.id,
            type: 'deposit',
            amount: num(d.amount),
            status: d.status || 'Pending',
            date: d.createdAt,
            description: 'Cash limit settlement',
            paymentMethod: d.paymentMethod || 'cash',
            razorpayPaymentId: d.razorpayPaymentId || '',
            razorpayOrderId: d.razorpayOrderId || '',
        })),
    ].sort((a, b) => new Date(b.date) - new Date(a.date));

    return {
        totalBalance: totalEarned + totalBonus, // gross lifetime earnings
        pocketBalance,                          // available to withdraw
        cashInHand,                             // COD still to be deposited
        totalWithdrawn,                         // actually paid out
        pendingWithdrawals,                     // in process
        lockedAmount: effectiveLockedAmount,
        totalEarned,
        totalBonus,
        totalCashLimit,
        availableCashLimit: Math.max(0, totalCashLimit - cashInHand),
        deliveryWithdrawalLimit,
        transactions: transactions.slice(0, 50),
    };
};

/**
 * Submit a new withdrawal request for a delivery partner.
 */
export const requestDeliveryWithdrawal = async (deliveryPartnerId, payload) => {
    const amount = Number(payload?.amount);
    const { bankDetails, paymentMethod = 'bank_transfer' } = payload;

    if (!Number.isFinite(amount) || amount < 1) throw new ValidationError('Invalid amount');

    const wallet = await getDeliveryPartnerWalletEnhanced(deliveryPartnerId);
    if (amount < wallet.deliveryWithdrawalLimit) {
        throw new ValidationError(`Minimum withdrawal amount is ₹${wallet.deliveryWithdrawalLimit}`);
    }
    if (amount > wallet.pocketBalance) {
        throw new ValidationError('Insufficient balance for this withdrawal');
    }

    const partnerId = String(deliveryPartnerId);
    const [partner, walletDoc, pendingAgg] = await Promise.all([
        prisma.foodDeliveryPartner.findUnique({ where: { id: partnerId } }),
        prisma.wallet.findUnique({ where: walletKey(partnerId) }),
        prisma.foodDeliveryWithdrawal.aggregate({
            where: { deliveryPartnerId: partnerId, status: 'pending' },
            _sum: { amount: true },
        }),
    ]);

    if (!partner) throw new ValidationError('Delivery partner not found');

    const pendingBefore = num(pendingAgg?._sum?.amount);
    const currentBalance = num(walletDoc?.balance);
    const currentLocked = num(walletDoc?.lockedAmount);
    const effectiveLockedBefore = Math.max(currentLocked, pendingBefore);
    const computedAvailableBalance = num(wallet.pocketBalance);
    const targetLedgerBalance = Math.max(currentBalance, effectiveLockedBefore + computedAvailableBalance);
    const availableBalance = Math.max(0, targetLedgerBalance - effectiveLockedBefore);

    if (amount > availableBalance) {
        throw new ValidationError('Insufficient balance for this withdrawal');
    }

    const [withdrawal] = await prisma.$transaction([
        prisma.foodDeliveryWithdrawal.create({
            data: {
                deliveryPartnerId: partnerId,
                amount,
                paymentMethod,
                bankDetails: bankDetails || {
                    accountNumber: partner.bankAccountNumber,
                    ifscCode: partner.bankIfscCode,
                    bankName: partner.bankName,
                    accountHolderName: partner.bankAccountHolderName,
                },
                upiId: partner.upiId,
                upiQrCode: partner.upiQrCode,
                status: 'pending',
            },
        }),
        // ponytail: targetLedgerBalance is max(ledger balance, derived pocket
        // balance), so requesting a withdrawal can raise the stored balance to
        // match a figure computed from order aggregates — money appearing from
        // a reconciliation rather than from a transaction, with no ledger entry
        // behind it. It only ever increases, never decreases.
        //
        // The root cause is that a rider's money has two sources of truth: the
        // wallet ledger, and aggregates over orders, bonuses and deposits. This
        // line papers over the disagreement instead of resolving it. Picking
        // one — the ledger — is the fix, and it is a bigger change than a
        // comment.
        prisma.wallet.upsert({
            where: walletKey(partnerId),
            create: {
                entityType: 'deliveryBoy',
                entityId: partnerId,
                balance: targetLedgerBalance,
                lockedAmount: effectiveLockedBefore + amount,
            },
            update: {
                balance: targetLedgerBalance,
                lockedAmount: effectiveLockedBefore + amount,
            },
        }),
    ]);

    return withdrawal;
};

export const createDeliveryCashDepositOrder = async (deliveryPartnerId, amountInr) => {
    const amount = Number(amountInr);
    if (!Number.isFinite(amount) || amount < 1) {
        throw new ValidationError('Amount must be at least ₹1');
    }
    if (amount > 500000) {
        throw new ValidationError('Maximum deposit is ₹5,00,000');
    }

    const wallet = await getDeliveryPartnerWalletEnhanced(deliveryPartnerId);
    if (amount > wallet.cashInHand) {
        throw new ValidationError('Deposit amount cannot exceed cash in hand');
    }

    const amountPaise = Math.round(amount * 100);
    const receipt = `cash_deposit_${String(deliveryPartnerId).slice(-8)}_${Date.now()}`;

    if (!isRazorpayConfigured()) {
        return {
            razorpay: {
                key: getRazorpayKeyId() || 'rzp_test_dummy',
                orderId: `order_dev_${Date.now()}`,
                amount: amountPaise,
                currency: 'INR',
            },
        };
    }

    const order = await createRazorpayOrder(amountPaise, 'INR', receipt);
    return {
        razorpay: {
            key: getRazorpayKeyId(),
            orderId: String(order.id),
            amount: Number(order.amount) || amountPaise,
            currency: order.currency || 'INR',
        },
    };
};

export const verifyDeliveryCashDepositPayment = async (deliveryPartnerId, payload = {}) => {
    const partnerId = String(deliveryPartnerId);
    const orderId = String(payload?.razorpayOrderId || '').trim();
    const paymentId = String(payload?.razorpayPaymentId || '').trim();
    const signature = String(payload?.razorpaySignature || '').trim();
    const amount = Number(payload?.amount);

    if (!orderId) throw new ValidationError('razorpayOrderId is required');
    if (!paymentId) throw new ValidationError('razorpayPaymentId is required');
    if (!signature) throw new ValidationError('razorpaySignature is required');
    if (!Number.isFinite(amount) || amount < 1) throw new ValidationError('amount is required');

    const existing = await prisma.foodDeliveryCashDeposit.findFirst({
        where: {
            deliveryPartnerId: partnerId,
            OR: [{ razorpayPaymentId: paymentId }, { razorpayOrderId: orderId }],
        },
    });

    if (existing?.status === 'Completed') {
        return { deposit: existing, wallet: await getDeliveryPartnerWalletEnhanced(partnerId) };
    }

    const isValid = isRazorpayConfigured() ? verifyPaymentSignature(orderId, paymentId, signature) : true;
    if (!isValid) throw new ValidationError('Payment verification failed');

    // The signature proves the payment belongs to this order — it says NOTHING about
    // how much was paid. Trusting the client's `amount` let a rider pay Rs 1 and post
    // amount: 5000, clearing Rs 5000 of cash-in-hand while pocketing the difference.
    // Always settle on the amount Razorpay actually captured.
    let settledAmount = amount;
    if (isRazorpayConfigured()) {
        const payment = await fetchRazorpayPayment(paymentId);

        const capturedPaise = Number(payment?.amount);
        if (!Number.isFinite(capturedPaise) || capturedPaise <= 0) {
            throw new ValidationError('Could not confirm the paid amount with Razorpay');
        }
        if (!['captured', 'authorized'].includes(String(payment?.status || ''))) {
            throw new ValidationError(`Payment is not captured (status: ${payment?.status || 'unknown'})`);
        }
        // Reject a payment belonging to a different Razorpay order.
        if (payment?.order_id && String(payment.order_id) !== orderId) {
            throw new ValidationError('Payment does not belong to this order');
        }

        settledAmount = Math.round((capturedPaise / 100) * 100) / 100;
        if (Math.abs(settledAmount - amount) > 0.01) {
            logger.warn(
                `Cash deposit amount mismatch for partner ${partnerId}: client claimed ${amount}, Razorpay captured ${settledAmount}. Using the captured amount.`,
            );
        }
    }

    const wallet = await getDeliveryPartnerWalletEnhanced(partnerId);
    if (settledAmount > wallet.cashInHand) {
        throw new ValidationError('Deposit amount cannot exceed cash in hand');
    }

    // settledAmount on BOTH paths. The update branch used to write the client-supplied
    // `amount`, which is exactly the value the check above exists to distrust — so a
    // deposit that reached this branch could still clear more cash than was paid.
    const depositData = {
        amount: settledAmount,
        paymentMethod: isRazorpayConfigured() ? 'razorpay' : 'cash',
        status: 'Completed',
        razorpayOrderId: orderId,
        razorpayPaymentId: paymentId,
    };

    const deposit = existing
        ? await prisma.foodDeliveryCashDeposit.update({ where: { id: existing.id }, data: depositData })
        : await prisma.foodDeliveryCashDeposit.create({
            data: { deliveryPartnerId: partnerId, ...depositData },
        });

    return { deposit, wallet: await getDeliveryPartnerWalletEnhanced(partnerId) };
};
