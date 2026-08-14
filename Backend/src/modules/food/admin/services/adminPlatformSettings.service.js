import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { ValidationError } from '../../../../core/auth/errors.js';

/**
 * Fee settings, referral settings and the safety/emergency inbox, extracted
 * from admin.service.js.
 *
 * The fee settings are the interesting one. `deliveryFeeRanges` was a Json
 * array on the settings document; it is the delivery_fee_bands table now, with
 * an EXCLUDE constraint that stops two bands covering the same distance. So
 * saving them is a replace of the child rows rather than an overwrite of a
 * column, and it shares a transaction with the settings write — a half-applied
 * save would price deliveries from a mix of the old and new ladders.
 */

const SAFETY_STATUSES = ['unread', 'read', 'urgent', 'resolved'];
const SAFETY_PRIORITIES = ['low', 'medium', 'high', 'critical'];

/** Band rows → the `{ min, max, fee, … }` shape the admin UI and pricing read. */
const toFeeRanges = (bands = []) =>
    bands.map((band) => ({
        id: band.id,
        min: Number(band.minDistanceKm),
        max: Number(band.maxDistanceKm),
        fee: Number(band.fee),
        deliveryBoyBasePay: Number(band.deliveryBoyBasePay),
        deliveryBoyPerKm: Number(band.deliveryBoyPerKm),
    }));

/** Decimal columns → numbers, plus the legacy nested band array. */
const serializeFeeSettings = (doc) => {
    if (!doc) return null;
    const { deliveryFeeBands, ...rest } = doc;
    const num = (v) => (v === null || v === undefined ? null : Number(v));

    return {
        ...rest,
        deliveryFee: num(doc.deliveryFee),
        platformFee: num(doc.platformFee),
        quickDeliveryFee: num(doc.quickDeliveryFee),
        gstRate: num(doc.gstRate),
        deliveryFeeGstRate: num(doc.deliveryFeeGstRate),
        deliveryFeeRanges: toFeeRanges(deliveryFeeBands),
    };
};

const FEE_INCLUDE = { deliveryFeeBands: { orderBy: { minDistanceKm: 'asc' } } };

export async function getFeeSettings() {
    const doc = await prisma.foodFeeSettings.findFirst({
        orderBy: { createdAt: 'desc' },
        include: FEE_INCLUDE,
    });
    // Null rather than defaults: the admin screen must not imply a fee is
    // configured when none is.
    return { feeSettings: serializeFeeSettings(doc) };
}

/**
 * `null` clears a fee, `undefined` leaves it alone.
 *
 * The distinction is the whole point: an unset platform fee means it is not
 * charged, which is different from "this request did not mention it".
 */
const feeColumns = (body = {}) => {
    const data = {};
    for (const key of ['deliveryFee', 'platformFee', 'quickDeliveryFee', 'gstRate']) {
        if (body[key] === null) data[key] = null;
        else if (body[key] !== undefined) data[key] = Number(body[key]);
    }
    // Cleared or simply absent both mean the delivery fee is not taxed.
    data.deliveryFeeGstRate =
        body.deliveryFeeGstRate === null || body.deliveryFeeGstRate === undefined
            ? null
            : Number(body.deliveryFeeGstRate);

    if (body.isActive !== undefined) data.isActive = Boolean(body.isActive);
    return data;
};

const bandRows = (ranges = []) =>
    ranges.map((range) => ({
        minDistanceKm: Number(range.min ?? range.minDistanceKm) || 0,
        maxDistanceKm: Number(range.max ?? range.maxDistanceKm) || 0,
        fee: Number(range.fee) || 0,
        deliveryBoyBasePay: Number(range.deliveryBoyBasePay) || 0,
        deliveryBoyPerKm: Number(range.deliveryBoyPerKm) || 0,
    }));

/** Turn a band constraint violation into something an admin can act on. */
const asBandError = (error) => {
    const message = error?.message || '';
    if (/no_overlap/.test(message)) {
        return new ValidationError('Distance bands must not overlap');
    }
    if (/band_pay_exclusive/.test(message)) {
        return new ValidationError('A band sets either a base pay or a per-km rate, not both');
    }
    if (/band_range_valid|band_fee_non_negative/.test(message)) {
        return new ValidationError('Each band needs a valid distance range and a non-negative fee');
    }
    return error;
};

export async function upsertFeeSettings(body = {}) {
    const data = feeColumns(body);
    const ranges = body.deliveryFeeRanges;

    try {
        const saved = await prisma.$transaction(async (tx) => {
            const existing = await tx.foodFeeSettings.findFirst({ orderBy: { createdAt: 'desc' } });

            // One settings row, edited in place — the Mongo version called this
            // the "single active doc pattern".
            const row = existing
                ? await tx.foodFeeSettings.update({ where: { id: existing.id }, data })
                : await tx.foodFeeSettings.create({ data: { isActive: body.isActive !== false, ...data } });

            if (ranges !== undefined) {
                // Replaced wholesale, in the same transaction as the settings.
                // Bands have no stable identity for the admin to edit one by
                // one, and a partial apply would price from a mixed ladder.
                await tx.deliveryFeeBand.deleteMany({ where: { feeSettingsId: row.id } });
                const rows = bandRows(ranges);
                if (rows.length) {
                    await tx.deliveryFeeBand.createMany({
                        data: rows.map((band) => ({ ...band, feeSettingsId: row.id })),
                    });
                }
            }

            return tx.foodFeeSettings.findUnique({ where: { id: row.id }, include: FEE_INCLUDE });
        });

        return serializeFeeSettings(saved);
    } catch (error) {
        throw asBandError(error);
    }
}

// ─── Referral settings ───────────────────────────────────────────────────────

const serializeReferralSettings = (doc) =>
    doc
        ? {
            ...doc,
            referralRewardUser: Number(doc.referralRewardUser),
            referralRewardDelivery: Number(doc.referralRewardDelivery),
        }
        : null;

export async function getReferralSettings() {
    const doc = await prisma.foodReferralSettings.findFirst({
        where: { isActive: true },
        orderBy: { createdAt: 'desc' },
    });
    return { referralSettings: serializeReferralSettings(doc) };
}

export async function upsertReferralSettings(body = {}) {
    // Rewards and limits are money and quota, so a negative is clamped rather
    // than stored.
    const nonNegative = (value) => Math.max(0, Number(value) || 0);

    const data = {};
    if (body.referralRewardUser !== undefined) data.referralRewardUser = nonNegative(body.referralRewardUser);
    if (body.referralRewardDelivery !== undefined) {
        data.referralRewardDelivery = nonNegative(body.referralRewardDelivery);
    }
    if (body.referralLimitUser !== undefined) data.referralLimitUser = nonNegative(body.referralLimitUser);
    if (body.referralLimitDelivery !== undefined) {
        data.referralLimitDelivery = nonNegative(body.referralLimitDelivery);
    }
    if (body.referralLinkUser !== undefined) data.referralLinkUser = String(body.referralLinkUser || '').trim();
    if (body.referralLinkDelivery !== undefined) {
        data.referralLinkDelivery = String(body.referralLinkDelivery || '').trim();
    }
    if (body.isActive !== undefined) data.isActive = Boolean(body.isActive);

    const saved = await prisma.$transaction(async (tx) => {
        const existing = await tx.foodReferralSettings.findFirst({
            where: { isActive: true },
            orderBy: { createdAt: 'desc' },
        });

        if (existing) {
            if (!Object.keys(data).length) return existing;
            return tx.foodReferralSettings.update({ where: { id: existing.id }, data });
        }

        return tx.foodReferralSettings.create({ data: { isActive: body.isActive !== false, ...data } });
    });

    return serializeReferralSettings(saved);
}

// ─── Safety / emergency reports ──────────────────────────────────────────────

export async function getSafetyEmergencyReports(query = {}) {
    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 10, 1), 100);
    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    const skip = (page - 1) * limit;

    const where = {};
    if (SAFETY_STATUSES.includes(String(query.status))) where.status = String(query.status);
    if (SAFETY_PRIORITIES.includes(String(query.priority))) where.priority = String(query.priority);

    if (query.search && String(query.search).trim()) {
        const contains = { contains: String(query.search).trim().slice(0, 120), mode: 'insensitive' };
        where.OR = [{ userName: contains }, { userEmail: contains }, { message: contains }];
    }

    const [safetyEmergencies, total] = await Promise.all([
        prisma.foodSafetyEmergencyReport.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            skip,
            take: limit,
        }),
        prisma.foodSafetyEmergencyReport.count({ where }),
    ]);

    return {
        safetyEmergencies,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 },
    };
}

/** Apply one field to a report, returning null if it no longer exists. */
const updateSafetyReport = async (id, data) => {
    if (!isId(id)) throw new ValidationError('Invalid report id');

    const { count } = await prisma.foodSafetyEmergencyReport.updateMany({
        where: { id: String(id) },
        data,
    });
    if (!count) return null;

    return prisma.foodSafetyEmergencyReport.findUnique({ where: { id: String(id) } });
};

export async function updateSafetyEmergencyStatus(id, status) {
    const next = String(status);
    if (!SAFETY_STATUSES.includes(next)) throw new ValidationError('Invalid status');
    return updateSafetyReport(id, { status: next });
}

export async function updateSafetyEmergencyPriority(id, priority) {
    const next = String(priority);
    if (!SAFETY_PRIORITIES.includes(next)) throw new ValidationError('Invalid priority');
    return updateSafetyReport(id, { priority: next });
}

export async function deleteSafetyEmergencyReport(id) {
    if (!isId(id)) throw new ValidationError('Invalid report id');

    const report = await prisma.foodSafetyEmergencyReport.findUnique({ where: { id: String(id) } });
    if (!report) return null;

    await prisma.foodSafetyEmergencyReport.delete({ where: { id: String(id) } });
    return report;
}
