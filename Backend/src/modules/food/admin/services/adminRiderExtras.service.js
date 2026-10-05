import { Prisma } from '@prisma/client';
import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { NotFoundError, ValidationError } from '../../../../core/auth/errors.js';
import { logger } from '../../../../utils/logger.js';
import { claimRegistrationIdentity } from '../../delivery/services/delivery.service.js';
import { updateDeliveryWithdrawalStatus } from './adminWithdrawal.service.js';
import { parsePeriod } from './adminReports.service.js';
import { batchStatusFor, money, resolveRiderPayee } from './adminRiderExtras.helpers.js';
import {
    loadRiderBalances,
    lockRiderBalance,
    recordRiderPaymentInTx,
    syncLedger,
} from './adminRiderBalance.service.js';
import {
    validateDecidePayoutsDto,
    validateGenerateDisbursementDto,
    validateNewRiderDto,
    validateRiderPaymentDto,
    validateVehicleCategoryDto,
} from '../validators/riderExtras.validator.js';

/**
 * Delivery man features the previous admin panel had: adding a rider by hand,
 * vehicle categories, disbursements, recorded payments and the earning report.
 *
 * Every way a rider is paid is a row in food_delivery_withdrawals, told apart
 * by `source`. The rider's withdrawable balance (deliveryFinance.service.js)
 * already subtracts pending and approved withdrawals, so a disbursement line
 * or a recorded payment lowers the same balance the rider withdraws from, and
 * the same money cannot be paid twice by different routes.
 */

const num = (value) => Number(value ?? 0) || 0;
const pageOf = (query, fallback = 20) => {
    const limit = Math.min(Math.max(parseInt(query.limit, 10) || fallback, 1), 500);
    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    return { limit, page, skip: (page - 1) * limit };
};
const paginationOf = (total, page, limit) => ({ total, page, limit, pages: Math.ceil(total / limit) || 1 });

// ─── Add Delivery Man ────────────────────────────────────────────────────────

/**
 * A rider added by an admin. They are approved at once -- the admin has seen
 * them and their documents -- and log in to the rider app with the phone
 * number by OTP, like any other rider.
 */
export async function createRiderByAdmin(body = {}, adminId = null) {
    const data = validateNewRiderDto(body);

    const [zone, vehicle] = await Promise.all([
        prisma.foodZone.findUnique({ where: { id: data.zoneId }, select: { id: true, name: true } }),
        prisma.foodDeliveryVehicleCategory.findFirst({
            where: { type: { equals: data.vehicleType, mode: 'insensitive' }, isActive: true },
            select: { type: true },
        }),
    ]);
    if (!zone) throw new ValidationError('That zone no longer exists. Choose another.');
    if (!vehicle) {
        throw new ValidationError('Choose a vehicle type from Vehicles Category. Add it there first if it is missing.');
    }

    await claimRegistrationIdentity({ phone: data.phone, vehicleNumber: data.vehicleNumber });

    const optional = (value) => (value ? value : null);
    let partner;
    try {
        partner = await prisma.foodDeliveryPartner.create({
            data: {
                name: data.name,
                phone: data.phone,
                email: optional(data.email),
                zoneId: zone.id,
                address: optional(data.address),
                city: optional(data.city),
                state: optional(data.state),
                vehicleType: vehicle.type,
                vehicleName: optional(data.vehicleName),
                vehicleNumber: optional(data.vehicleNumber),
                panNumber: optional(data.panNumber),
                aadharNumber: optional(data.aadharNumber),
                drivingLicenseNumber: optional(data.drivingLicenseNumber),
                profilePhoto: optional(data.profilePhoto),
                aadharPhoto: optional(data.aadharPhoto),
                panPhoto: optional(data.panPhoto),
                drivingLicensePhoto: optional(data.drivingLicensePhoto),
                bankAccountHolderName: optional(data.bankAccountHolderName),
                bankAccountNumber: optional(data.bankAccountNumber),
                bankIfscCode: optional(data.bankIfscCode),
                bankName: optional(data.bankName),
                upiId: optional(data.upiId),
                status: 'approved',
                approvedAt: new Date(),
            },
        });
    } catch (error) {
        // Two admins adding the same phone or vehicle at once: one wins.
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
            throw new ValidationError('A delivery man with this phone or vehicle number already exists');
        }
        throw error;
    }

    // The referral code is the rider's own id, as at sign-up.
    partner = await prisma.foodDeliveryPartner.update({
        where: { id: partner.id },
        data: { referralCode: partner.id },
    });

    logger.info(`[RIDERS] ${partner.id} added by admin ${adminId || 'unknown'}`);
    return {
        id: partner.id,
        name: partner.name,
        phone: partner.phone,
        status: partner.status,
        zoneId: partner.zoneId,
        zoneName: zone.name,
        vehicleType: partner.vehicleType,
    };
}

// ─── Vehicle categories ──────────────────────────────────────────────────────

const serializeVehicle = (row, riders = 0) => ({
    id: row.id,
    type: row.type,
    startingCoverageKm: num(row.startingCoverageKm),
    maxCoverageKm: num(row.maxCoverageKm),
    extraCharges: num(row.extraCharges),
    isActive: row.isActive,
    riders,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
});

export async function listVehicleCategories(query = {}) {
    const where = {};
    const search = String(query.search || '').trim();
    if (search) where.type = { contains: search, mode: 'insensitive' };
    if (query.active === 'true') where.isActive = true;

    const [rows, riderTypes] = await Promise.all([
        prisma.foodDeliveryVehicleCategory.findMany({ where, orderBy: { createdAt: 'asc' } }),
        prisma.foodDeliveryPartner.groupBy({
            by: ['vehicleType'],
            where: { status: 'approved', vehicleType: { not: null } },
            _count: { _all: true },
        }),
    ]);

    // Riders who signed up in the app typed their own vehicle type, so match
    // without regard to case.
    const ridersByType = new Map();
    for (const row of riderTypes) {
        const key = String(row.vehicleType).trim().toLowerCase();
        ridersByType.set(key, (ridersByType.get(key) || 0) + row._count._all);
    }

    return {
        categories: rows.map((row) => serializeVehicle(row, ridersByType.get(row.type.toLowerCase()) || 0)),
    };
}

async function assertTypeFree(type, exceptId = null) {
    const clash = await prisma.foodDeliveryVehicleCategory.findFirst({
        where: { type: { equals: type, mode: 'insensitive' }, ...(exceptId ? { id: { not: exceptId } } : {}) },
        select: { id: true },
    });
    if (clash) throw new ValidationError(`A vehicle category called "${type}" already exists`);
}

const saveVehicle = async (write) => {
    try {
        return await write();
    } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
            throw new ValidationError('A vehicle category with this type already exists');
        }
        throw error;
    }
};

export async function createVehicleCategory(body = {}) {
    const data = validateVehicleCategoryDto(body);
    await assertTypeFree(data.type);
    const row = await saveVehicle(() => prisma.foodDeliveryVehicleCategory.create({ data }));
    return { category: serializeVehicle(row) };
}

export async function updateVehicleCategory(id, body = {}) {
    if (!isId(id)) throw new ValidationError('Invalid vehicle category');
    const existing = await prisma.foodDeliveryVehicleCategory.findUnique({ where: { id: String(id) } });
    if (!existing) throw new NotFoundError('Vehicle category not found');
    const data = validateVehicleCategoryDto(body, {
        ...existing,
        startingCoverageKm: num(existing.startingCoverageKm),
        maxCoverageKm: num(existing.maxCoverageKm),
        extraCharges: num(existing.extraCharges),
    });
    if (data.type.toLowerCase() !== existing.type.toLowerCase()) await assertTypeFree(data.type, existing.id);
    const row = await saveVehicle(() =>
        prisma.foodDeliveryVehicleCategory.update({ where: { id: existing.id }, data }),
    );
    return { category: serializeVehicle(row) };
}

/** Riders keep the type they have; it is a label on them, not a link. */
export async function deleteVehicleCategory(id) {
    if (!isId(id)) throw new ValidationError('Invalid vehicle category');
    const { count } = await prisma.foodDeliveryVehicleCategory.deleteMany({ where: { id: String(id) } });
    if (!count) throw new NotFoundError('Vehicle category not found');
    return { deleted: true };
}

// ─── Delivery Man Payments ───────────────────────────────────────────────────

const PAYMENT_SOURCES = ['admin_payment', 'balance_sheet'];

const PARTNER_BRIEF = { select: { id: true, name: true, phone: true } };

const serializePayment = (row) => ({
    id: row.id,
    deliveryPartnerId: row.deliveryPartnerId,
    deliveryName: row.deliveryPartner?.name || 'Deleted delivery man',
    deliveryPhone: row.deliveryPartner?.phone || '',
    amount: num(row.amount),
    method: row.paymentMethod,
    reference: row.transactionId || '',
    note: row.adminNote || '',
    source: row.source,
    createdAt: row.createdAt,
});

export async function recordRiderPayment(body = {}, adminId = null) {
    const data = validateRiderPaymentDto(body);
    const partner = await prisma.foodDeliveryPartner.findUnique({
        where: { id: data.deliveryPartnerId },
        select: { id: true },
    });
    if (!partner) throw new NotFoundError('Delivery man not found');

    const row = await prisma.$transaction(
        (tx) => recordRiderPaymentInTx(tx, {
            deliveryPartnerId: partner.id,
            amount: data.amount,
            method: data.method,
            reference: data.reference,
            note: data.note,
            adminId,
            source: 'admin_payment',
        }),
        { timeout: 20000 },
    );
    const saved = await prisma.foodDeliveryWithdrawal.findUnique({
        where: { id: row.id },
        include: { deliveryPartner: PARTNER_BRIEF },
    });
    const balance = (await loadRiderBalances([partner.id])).get(partner.id);
    return { payment: serializePayment(saved), remainingBalance: balance?.available ?? 0 };
}

const dayRange = (query) => {
    const range = {};
    if (query.from) {
        const start = new Date(query.from);
        if (Number.isNaN(start.getTime())) throw new ValidationError('Invalid "from" date');
        start.setHours(0, 0, 0, 0);
        range.gte = start;
    }
    if (query.to) {
        const end = new Date(query.to);
        if (Number.isNaN(end.getTime())) throw new ValidationError('Invalid "to" date');
        end.setHours(23, 59, 59, 999);
        range.lte = end;
    }
    return Object.keys(range).length ? range : null;
};

export async function listRiderPayments(query = {}) {
    const { limit, page, skip } = pageOf(query, 20);
    const where = { source: { in: PAYMENT_SOURCES } };
    if (PAYMENT_SOURCES.includes(query.source)) where.source = query.source;
    if (query.method && query.method !== 'all') where.paymentMethod = String(query.method);
    if (isId(query.deliveryPartnerId)) where.deliveryPartnerId = String(query.deliveryPartnerId);
    const createdAt = dayRange(query);
    if (createdAt) where.createdAt = createdAt;
    const search = String(query.search || '').trim();
    if (search) {
        const contains = { contains: search, mode: 'insensitive' };
        where.OR = [
            { deliveryPartner: { OR: [{ name: contains }, { phone: contains }] } },
            { transactionId: contains },
        ];
    }

    const [rows, total, sum] = await Promise.all([
        prisma.foodDeliveryWithdrawal.findMany({
            where, orderBy: { createdAt: 'desc' }, skip, take: limit,
            include: { deliveryPartner: PARTNER_BRIEF },
        }),
        prisma.foodDeliveryWithdrawal.count({ where }),
        prisma.foodDeliveryWithdrawal.aggregate({ where, _sum: { amount: true } }),
    ]);

    return {
        payments: rows.map(serializePayment),
        totalAmount: money(sum._sum.amount),
        pagination: paginationOf(total, page, limit),
    };
}

/**
 * Riders an admin can pay, with what each can be paid now: for the payment
 * form's picker. Approved riders only; search by name or phone.
 */
export async function listPayableRiders(query = {}) {
    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 20, 1), 50);
    const where = { status: 'approved' };
    const search = String(query.search || '').trim();
    if (search) {
        const contains = { contains: search, mode: 'insensitive' };
        where.OR = [{ name: contains }, { phone: contains }];
    }
    const riders = await prisma.foodDeliveryPartner.findMany({
        where, orderBy: { name: 'asc' }, take: limit,
        select: { id: true, name: true, phone: true, bankAccountNumber: true, bankIfscCode: true, upiId: true },
    });
    const balances = await loadRiderBalances(riders.map((r) => r.id));
    return {
        riders: riders.map((r) => ({
            id: r.id,
            name: r.name,
            phone: r.phone,
            balance: balances.get(r.id)?.available ?? 0,
            hasPayoutDetails: Boolean((r.bankAccountNumber && r.bankIfscCode) || r.upiId),
        })),
    };
}

// ─── Delivery Man Disbursement ───────────────────────────────────────────────

const PAYEE_SELECT = {
    id: true, name: true, phone: true,
    bankAccountHolderName: true, bankAccountNumber: true, bankIfscCode: true, bankName: true, upiId: true,
};

const serializeBatch = (batch, lines = []) => {
    const paid = lines.filter((l) => l.status === 'approved');
    const pending = lines.filter((l) => l.status === 'pending');
    const failed = lines.filter((l) => l.status === 'rejected');
    const sum = (list) => money(list.reduce((s, l) => s + num(l.amount), 0));
    return {
        id: batch.id,
        number: batch.number,
        title: `Disbursement #${batch.number}`,
        status: batchStatusFor(lines.map((l) => l.status)),
        totalAmount: num(batch.totalAmount),
        riderCount: batch.riderCount,
        minAmount: num(batch.minAmount),
        skipped: Array.isArray(batch.skipped) ? batch.skipped : [],
        paidAmount: sum(paid),
        pendingAmount: sum(pending),
        failedAmount: sum(failed),
        createdAt: batch.createdAt,
    };
};

/**
 * Pay every approved rider their withdrawable balance, as one batch of payout
 * lines. Nothing is transferred: the admin pays each line by bank or UPI and
 * marks it paid or failed. A pending line already counts against the rider's
 * balance, so the rider cannot withdraw the same money meanwhile, and a second
 * batch made at the same time finds nothing left to pay; a failed line gives
 * the money back.
 */
export async function generateRiderDisbursement(body = {}, adminId = null) {
    const { minAmount } = validateGenerateDisbursementDto(body);

    const riders = await prisma.foodDeliveryPartner.findMany({
        where: { status: 'approved' },
        select: PAYEE_SELECT,
        orderBy: { createdAt: 'asc' },
    });

    let batch = await prisma.foodDeliveryPayoutBatch.create({
        data: { minAmount, createdById: adminId && isId(adminId) ? String(adminId) : null },
    });

    const skipped = [];
    let total = 0;
    let count = 0;

    for (let i = 0; i < riders.length; i += 100) {
        const page = riders.slice(i, i + 100);
        const balances = await loadRiderBalances(page.map((r) => r.id));

        for (const rider of page) {
            const owed = balances.get(rider.id)?.available || 0;
            if (owed < minAmount) continue;

            const payee = resolveRiderPayee(rider);
            if (!payee) {
                skipped.push({ deliveryPartnerId: rider.id, name: rider.name, amount: owed, reason: 'No bank account or UPI id on file' });
                continue;
            }

            try {
                const amount = await prisma.$transaction(async (tx) => {
                    // Re-read under the lock: a withdrawal or payment made since
                    // the page was read must not be paid a second time here.
                    await lockRiderBalance(tx, rider.id);
                    const figures = (await loadRiderBalances([rider.id], tx)).get(rider.id);
                    const value = money(figures?.available);
                    if (value < minAmount) return 0;

                    const line = await tx.foodDeliveryWithdrawal.create({
                        data: {
                            deliveryPartnerId: rider.id,
                            amount: value,
                            status: 'pending',
                            source: 'disbursement',
                            batchId: batch.id,
                            paymentMethod: payee.paymentMethod,
                            bankDetails: payee.bankDetails,
                            upiId: rider.upiId || null,
                            processedBy: adminId && isId(adminId) ? String(adminId) : null,
                        },
                    });
                    await syncLedger(tx, rider.id, figures, line.id);
                    // Reserve it, as a rider's own request does; marking it
                    // paid debits and releases it, marking it failed releases it.
                    await tx.wallet.updateMany({
                        where: { entityType: 'deliveryBoy', entityId: rider.id },
                        data: { lockedAmount: figures.effectiveLocked + value },
                    });
                    return value;
                }, { timeout: 20000 });
                if (amount > 0) {
                    total = money(total + amount);
                    count += 1;
                }
            } catch (error) {
                // One rider's bad data must not stop everyone else's payout.
                logger.error(`[RIDER PAYOUTS] batch ${batch.id} rider ${rider.id}: ${error?.message || error}`);
                skipped.push({ deliveryPartnerId: rider.id, name: rider.name, amount: owed, reason: 'Error while creating the payout' });
            }
        }
    }

    if (!count && !skipped.length) {
        await prisma.foodDeliveryPayoutBatch.delete({ where: { id: batch.id } });
        return {
            created: false,
            reason: `No delivery man has ₹${minAmount.toLocaleString('en-IN')} or more to be paid`,
        };
    }

    batch = await prisma.foodDeliveryPayoutBatch.update({
        where: { id: batch.id },
        data: { totalAmount: total, riderCount: count, skipped },
    });
    logger.info(`[RIDER PAYOUTS] #${batch.number}: ${count} rider(s), ₹${total}, ${skipped.length} skipped`);
    const lines = await prisma.foodDeliveryWithdrawal.findMany({
        where: { batchId: batch.id }, select: { status: true, amount: true },
    });
    return { created: true, batch: serializeBatch(batch, lines) };
}

export async function listRiderDisbursements(query = {}) {
    const { limit, page, skip } = pageOf(query, 20);
    const [rows, total] = await Promise.all([
        prisma.foodDeliveryPayoutBatch.findMany({ orderBy: { createdAt: 'desc' }, skip, take: limit }),
        prisma.foodDeliveryPayoutBatch.count(),
    ]);
    const lines = rows.length
        ? await prisma.foodDeliveryWithdrawal.findMany({
            where: { batchId: { in: rows.map((r) => r.id) } },
            select: { batchId: true, status: true, amount: true },
        })
        : [];
    return {
        batches: rows.map((b) => serializeBatch(b, lines.filter((l) => l.batchId === b.id))),
        pagination: paginationOf(total, page, limit),
    };
}

const LINE_STATUSES = { pending: 'pending', paid: 'approved', failed: 'rejected' };

export async function getRiderDisbursement(batchId, query = {}) {
    if (!isId(batchId)) throw new ValidationError('Invalid disbursement');
    const batch = await prisma.foodDeliveryPayoutBatch.findUnique({ where: { id: String(batchId) } });
    if (!batch) throw new NotFoundError('Disbursement not found');

    const all = await prisma.foodDeliveryWithdrawal.findMany({
        where: { batchId: batch.id },
        orderBy: { amount: 'desc' },
        include: { deliveryPartner: PARTNER_BRIEF },
    });

    const search = String(query.search || '').trim().toLowerCase();
    const wanted = LINE_STATUSES[query.status];
    const visible = all.filter((line) =>
        (!wanted || line.status === wanted)
        && (!search
            || String(line.deliveryPartner?.name || '').toLowerCase().includes(search)
            || String(line.deliveryPartner?.phone || '').includes(search)));

    return {
        batch: serializeBatch(batch, all),
        payouts: visible.map((line) => ({
            id: line.id,
            deliveryPartnerId: line.deliveryPartnerId,
            deliveryName: line.deliveryPartner?.name || 'Deleted delivery man',
            deliveryPhone: line.deliveryPartner?.phone || '',
            amount: num(line.amount),
            status: line.status === 'approved' ? 'paid' : line.status === 'rejected' ? 'failed' : 'pending',
            paymentMethod: line.paymentMethod,
            bankDetails: line.bankDetails || {},
            reference: line.transactionId || '',
            note: line.adminNote || line.rejectionReason || '',
            processedAt: line.processedAt,
        })),
    };
}

/**
 * Mark lines of one batch paid or failed. Each goes through the same decision
 * as a rider's withdrawal request (adminWithdrawal.service.js), which claims
 * the line only while it is still pending and debits the ledger once under an
 * idempotency key -- so a line decided twice, or from two screens, is paid once.
 */
export async function decideRiderPayouts(batchId, body = {}, adminId = null) {
    if (!isId(batchId)) throw new ValidationError('Invalid disbursement');
    const { ids, status, reference, note } = validateDecidePayoutsDto(body);

    const lines = await prisma.foodDeliveryWithdrawal.findMany({
        where: { id: { in: ids }, batchId: String(batchId) },
        select: { id: true, status: true },
    });
    const pending = lines.filter((l) => l.status === 'pending').map((l) => l.id);

    const done = [];
    const failures = [];
    for (const id of pending) {
        try {
            await updateDeliveryWithdrawalStatus(id, {
                status: status === 'paid' ? 'approved' : 'rejected',
                transactionId: status === 'paid' && reference ? reference : undefined,
                adminNote: note || undefined,
                rejectionReason: status === 'failed' && note ? note : undefined,
            });
            done.push(id);
        } catch (error) {
            failures.push({ id, reason: error?.message || 'Could not update this payout' });
        }
    }
    if (done.length && adminId && isId(adminId)) {
        await prisma.foodDeliveryWithdrawal.updateMany({
            where: { id: { in: done } },
            data: { processedBy: String(adminId) },
        });
    }

    return { updated: done.length, notPending: ids.length - pending.length, failed: failures };
}

// ─── Deliveryman Earning Report ──────────────────────────────────────────────

/**
 * What each rider earned in a period: delivered orders, their pay for them,
 * bonuses they were given and the cash they collected at the door. A delivery
 * counts on the day it was delivered.
 *
 * Bonuses belong to the rider, not to an order, so a restaurant filter narrows
 * the deliveries but leaves the bonuses whole, and only riders who delivered
 * for that restaurant are listed.
 */
export async function getDeliverymanEarningReport(query = {}) {
    const { start, end } = parsePeriod(query);
    const { limit, page } = pageOf(query, 50);

    const restaurant = isId(query.restaurantId)
        ? Prisma.sql`AND o."restaurantId" = ${String(query.restaurantId)}`
        : Prisma.empty;
    const needsDelivery = isId(query.restaurantId) ? Prisma.sql`AND r.id IS NOT NULL` : Prisma.empty;
    const search = String(query.search || '').trim();
    const searchFilter = search
        ? Prisma.sql`AND (p.name ILIKE ${`%${search}%`} OR p.phone LIKE ${`%${search}%`})`
        : Prisma.empty;
    const zone = isId(query.zoneId) ? Prisma.sql`AND p."zoneId" = ${String(query.zoneId)}` : Prisma.empty;

    const rows = await prisma.$queryRaw`
        WITH per_rider AS (
            SELECT o."dispatchDeliveryPartnerId" AS id,
                   COUNT(*)::int AS deliveries,
                   SUM(o."riderEarning") AS earning,
                   SUM(CASE WHEN o."paymentMethod" = 'cash' THEN o.total ELSE 0 END) AS "codCollected"
              FROM food_orders o
             WHERE o."orderStatus" = 'delivered'
               AND o."dispatchDeliveryPartnerId" IS NOT NULL
               AND COALESCE(o."deliveredAt", o."createdAt") BETWEEN ${start} AND ${end}
               ${restaurant}
             GROUP BY o."dispatchDeliveryPartnerId"
        ), per_bonus AS (
            SELECT b."deliveryPartnerId" AS id, SUM(b.amount) AS bonus
              FROM food_delivery_bonus_transactions b
             WHERE b."createdAt" BETWEEN ${start} AND ${end}
             GROUP BY b."deliveryPartnerId"
        ), report AS (
            SELECT p.id, p.name, p.phone,
                   COALESCE(r.deliveries, 0) AS deliveries,
                   COALESCE(r.earning, 0) AS earning,
                   COALESCE(b.bonus, 0) AS bonus,
                   COALESCE(r."codCollected", 0) AS "codCollected"
              FROM food_delivery_partners p
              LEFT JOIN per_rider r ON r.id = p.id
              LEFT JOIN per_bonus b ON b.id = p.id
             WHERE (r.id IS NOT NULL OR b.id IS NOT NULL)
               ${needsDelivery} ${searchFilter} ${zone}
        )
        SELECT *, earning + bonus AS total,
               COUNT(*) OVER () AS "rowCount",
               SUM(deliveries) OVER () AS "sumDeliveries",
               SUM(earning) OVER () AS "sumEarning",
               SUM(bonus) OVER () AS "sumBonus",
               SUM("codCollected") OVER () AS "sumCod"
          FROM report
         ORDER BY earning + bonus DESC, name ASC
         LIMIT ${limit} OFFSET ${(page - 1) * limit}`;

    const first = rows[0] || {};
    const count = Number(first.rowCount || 0);
    const totals = {
        riders: count,
        deliveries: Number(first.sumDeliveries || 0),
        earning: money(first.sumEarning),
        bonus: money(first.sumBonus),
        codCollected: money(first.sumCod),
    };
    totals.total = money(totals.earning + totals.bonus);

    return {
        period: { from: start, to: end },
        totals,
        riders: rows.map((row) => ({
            deliveryPartnerId: row.id,
            name: row.name,
            phone: row.phone,
            deliveries: Number(row.deliveries) || 0,
            earning: money(row.earning),
            bonus: money(row.bonus),
            codCollected: money(row.codCollected),
            total: money(row.total),
            averagePerDelivery: Number(row.deliveries) ? money(num(row.earning) / Number(row.deliveries)) : 0,
        })),
        pagination: paginationOf(count, page, limit),
    };
}
