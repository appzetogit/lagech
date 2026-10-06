import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { ValidationError, NotFoundError } from '../../../../core/auth/errors.js';
import {
    PAYEE_TYPES,
    normalizeMethodFields,
    validatePayoutValues,
    payoutSnapshot,
} from './payoutMethods.util.js';

/**
 * Payout method types (admin) and each payee's chosen method (restaurant
 * panel, rider app).
 *
 * Methods are additive. The bank and UPI columns on restaurants and riders are
 * still what the daily payout run prefers; a chosen method is what it falls
 * back to, and it is snapshotted onto every withdrawal so the admin can see
 * where to send the money.
 */

const serializeMethod = (row) => ({
    id: row.id,
    name: row.name,
    fields: Array.isArray(row.fields) ? row.fields : [],
    isActive: row.isActive,
    isDefault: row.isDefault,
    sortOrder: row.sortOrder,
    ...(row._count ? { payeeCount: row._count.details } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
});

const isTrue = (value) => value === true || value === 'true';

const readMethodBody = (body = {}, { partial = false } = {}) => {
    const data = {};
    if (!partial || body.name !== undefined) {
        const name = String(body.name ?? '').trim().slice(0, 80);
        if (!name) throw new ValidationError('Method name is required');
        data.name = name;
    }
    if (!partial || body.fields !== undefined) data.fields = normalizeMethodFields(body.fields);
    if (body.isActive !== undefined) data.isActive = isTrue(body.isActive);
    if (body.isDefault !== undefined) data.isDefault = isTrue(body.isDefault);
    if (body.sortOrder !== undefined) {
        const order = Number(body.sortOrder);
        data.sortOrder = Number.isFinite(order) ? Math.trunc(order) : 0;
    }
    // A switched-off method cannot be the one payees are offered first.
    if (data.isDefault && data.isActive === false) {
        throw new ValidationError('A switched-off method cannot be the default');
    }
    return data;
};

/** Every method, for the admin page, with how many payees use each. */
export async function listWithdrawalMethods(query = {}) {
    const search = String(query.search || '').trim();
    const rows = await prisma.foodWithdrawalMethod.findMany({
        where: search ? { name: { contains: search, mode: 'insensitive' } } : {},
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        include: { _count: { select: { details: true } } },
    });
    return { methods: rows.map(serializeMethod) };
}

/** What a restaurant or rider may choose from: active methods, default first. */
export async function listActiveWithdrawalMethods() {
    const rows = await prisma.foodWithdrawalMethod.findMany({
        where: { isActive: true },
        orderBy: [{ isDefault: 'desc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map(serializeMethod);
}

/** Write a method, keeping at most one default -- in the same transaction. */
async function saveMethod(id, data) {
    return prisma.$transaction(async (tx) => {
        if (data.isDefault) {
            await tx.foodWithdrawalMethod.updateMany({
                where: { isDefault: true, ...(id ? { id: { not: id } } : {}) },
                data: { isDefault: false },
            });
        }
        const row = id
            ? await tx.foodWithdrawalMethod.update({ where: { id }, data })
            : await tx.foodWithdrawalMethod.create({ data });
        return serializeMethod(row);
    });
}

export async function createWithdrawalMethod(body = {}) {
    return saveMethod(null, readMethodBody(body));
}

export async function updateWithdrawalMethod(id, body = {}) {
    if (!isId(id)) throw new ValidationError('Invalid method id');
    const existing = await prisma.foodWithdrawalMethod.findUnique({ where: { id: String(id) } });
    if (!existing) throw new NotFoundError('Withdrawal method not found');

    const data = readMethodBody(body, { partial: true });
    if (data.isActive === false && (data.isDefault ?? existing.isDefault)) {
        // Switching off the default leaves no default rather than a dead one.
        data.isDefault = false;
    }
    if (data.isDefault && !(data.isActive ?? existing.isActive)) {
        throw new ValidationError('Switch the method on before making it the default');
    }
    return saveMethod(existing.id, data);
}

/**
 * Deleting a method someone is paid by would strand their details, so it is
 * refused with how many payees use it; switching it off is the way out.
 */
export async function deleteWithdrawalMethod(id) {
    if (!isId(id)) throw new ValidationError('Invalid method id');
    const inUse = await prisma.foodPayoutMethodDetail.count({ where: { methodId: String(id) } });
    if (inUse > 0) {
        throw new ValidationError(
            `${inUse} restaurant(s) or rider(s) are paid by this method. Switch it off instead; they keep their details.`,
        );
    }
    const { count } = await prisma.foodWithdrawalMethod.deleteMany({ where: { id: String(id) } });
    if (!count) throw new NotFoundError('Withdrawal method not found');
    return { id: String(id), deleted: true };
}

// ─── Payees ──────────────────────────────────────────────────────────────────

const assertPayee = (ownerType, ownerId) => {
    if (!PAYEE_TYPES.includes(ownerType)) throw new ValidationError('Unknown payee type');
    if (!isId(ownerId)) throw new ValidationError('Invalid payee');
};

/** A payee's chosen method and values, plus the methods they could switch to. */
export async function getPayoutDetails(ownerType, ownerId) {
    assertPayee(ownerType, ownerId);
    const [detail, methods] = await Promise.all([
        prisma.foodPayoutMethodDetail.findUnique({
            where: { ownerType_ownerId: { ownerType, ownerId: String(ownerId) } },
            include: { method: true },
        }),
        listActiveWithdrawalMethods(),
    ]);
    return {
        selected: detail
            ? {
                methodId: detail.methodId,
                methodName: detail.method?.name || '',
                // A method the admin has since switched off is still shown, so
                // the payee knows to choose another.
                methodIsActive: Boolean(detail.method?.isActive),
                values: detail.values || {},
                updatedAt: detail.updatedAt,
            }
            : null,
        methods,
    };
}

/** Choose a method and fill its fields. Only an active method can be chosen. */
export async function savePayoutDetails(ownerType, ownerId, body = {}) {
    assertPayee(ownerType, ownerId);
    const methodId = String(body.methodId || '').trim();
    if (!isId(methodId)) throw new ValidationError('Choose a payout method');

    const method = await prisma.foodWithdrawalMethod.findUnique({ where: { id: methodId } });
    if (!method || !method.isActive) throw new ValidationError('That payout method is not available');

    const values = validatePayoutValues(method.fields || [], body.values);
    await prisma.foodPayoutMethodDetail.upsert({
        where: { ownerType_ownerId: { ownerType, ownerId: String(ownerId) } },
        create: { ownerType, ownerId: String(ownerId), methodId, values },
        update: { methodId, values },
    });
    return getPayoutDetails(ownerType, ownerId);
}

/**
 * Snapshots for many payees at once, as a Map of ownerId -> snapshot, for the
 * payout run and admin lists. Payees with no chosen method are absent.
 */
export async function getPayoutSnapshots(ownerType, ownerIds = [], db = prisma) {
    const ids = [...new Set((ownerIds || []).map(String))].filter(isId);
    if (!ids.length) return new Map();
    const rows = await db.foodPayoutMethodDetail.findMany({
        where: { ownerType, ownerId: { in: ids } },
        include: { method: true },
    });
    return new Map(
        rows
            .map((row) => [row.ownerId, payoutSnapshot(row.method, row.values || {})])
            .filter(([, snapshot]) => snapshot && snapshot.fields.length),
    );
}

/** One payee's snapshot, or null. Never throws: a payout must not fail on it. */
export async function getPayoutSnapshot(ownerType, ownerId, db = prisma) {
    try {
        return (await getPayoutSnapshots(ownerType, [ownerId], db)).get(String(ownerId)) || null;
    } catch {
        return null;
    }
}
