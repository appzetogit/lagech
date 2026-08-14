import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { ValidationError } from '../../../../core/auth/errors.js';

/**
 * Restaurant commissions and the delivery payout slabs, extracted from
 * admin.service.js.
 *
 * Two shape changes came with Postgres. The nested `defaultCommission`
 * subdocument is two columns (commissionType / commissionValue), rebuilt on the
 * way out because the admin screens read it nested. And the slab overlap rule,
 * which was a JS pass over every rule before each write, is now also a database
 * EXCLUDE constraint — see constraints.sql. The JS check stays for the clear
 * error message; the constraint is what makes it true under concurrency.
 */

/** Flat columns → the nested shape the admin screens read. */
const toDefaultCommission = (row) => ({
    type: row.commissionType || 'percentage',
    value: Number(row.commissionValue) || 0,
});

const serializeCommission = (row, index = 0) => ({
    _id: row.id,
    id: row.id,
    sl: index + 1,
    restaurantId: row.restaurantId,
    restaurantName: row.restaurant?.restaurantName || '',
    restaurant: row.restaurant
        ? { _id: row.restaurant.id, name: row.restaurant.restaurantName }
        : null,
    defaultCommission: toDefaultCommission(row),
    notes: row.notes || '',
    status: row.status !== false,
});

/** The nested input the admin screens still send → flat columns. */
const fromDefaultCommission = (defaultCommission = {}) => {
    // 'amount' is the flat-fee type; the validator and the enum both use it.
    const type = defaultCommission?.type === 'amount' ? 'amount' : 'percentage';
    const value = Number(defaultCommission?.value);

    if (!Number.isFinite(value) || value < 0) {
        throw new ValidationError('Commission value must be a non-negative number');
    }
    // A percentage over 100 would pay the platform more than the order was
    // worth; the database CHECK refuses it too.
    if (type === 'percentage' && value > 100) {
        throw new ValidationError('A percentage commission cannot exceed 100');
    }

    return { commissionType: type, commissionValue: value };
};

const WITH_RESTAURANT = { restaurant: { select: { id: true, restaurantName: true } } };

export async function getRestaurantCommissions() {
    const list = await prisma.foodRestaurantCommission.findMany({
        orderBy: { createdAt: 'desc' },
        include: WITH_RESTAURANT,
    });
    return { commissions: list.map(serializeCommission) };
}

export async function getRestaurantCommissionBootstrap() {
    // Imported lazily: getRestaurants still lives in admin.service.js, which
    // re-exports this file, so a top-level import would be circular.
    const { getRestaurants } = await import('./admin.service.js');

    const [commissionsData, restaurantsData] = await Promise.all([
        getRestaurantCommissions(),
        getRestaurants({ status: 'approved', limit: 1000, page: 1 }),
    ]);

    const configured = new Set(commissionsData.commissions.map((c) => String(c.restaurantId)));

    const restaurants = (restaurantsData.restaurants || []).map((r) => {
        const id = String(r.id || r._id || '');
        return {
            _id: id,
            name: r.restaurantName || r.name || '',
            // The human-facing code the admin screens show, not the row id.
            restaurantId: id ? `REST${id.slice(-6).padStart(6, '0')}` : '',
            ownerName: r.ownerName || '',
            hasCommissionSetup: configured.has(id),
        };
    });

    return { commissions: commissionsData.commissions, restaurants };
}

export async function getRestaurantCommissionById(id) {
    if (!isId(id)) return null;

    const doc = await prisma.foodRestaurantCommission.findUnique({
        where: { id: String(id) },
        include: WITH_RESTAURANT,
    });
    return doc ? serializeCommission(doc) : null;
}

export async function createRestaurantCommission(body = {}) {
    if (!isId(body.restaurantId)) throw new ValidationError('Invalid restaurant id');

    try {
        const created = await prisma.foodRestaurantCommission.create({
            data: {
                restaurantId: String(body.restaurantId),
                ...fromDefaultCommission(body.defaultCommission),
                notes: body.notes || '',
                status: true,
            },
            include: WITH_RESTAURANT,
        });
        return serializeCommission(created);
    } catch (error) {
        // restaurantId is unique, so the insert settles it rather than a lookup
        // that two admins could both pass.
        if (error?.code === 'P2002') {
            throw new ValidationError('Commission already exists for this restaurant');
        }
        if (error?.code === 'P2003') throw new ValidationError('Restaurant not found');
        throw error;
    }
}

export async function updateRestaurantCommission(id, body = {}) {
    if (!isId(id)) return null;

    const { count } = await prisma.foodRestaurantCommission.updateMany({
        where: { id: String(id) },
        data: { ...fromDefaultCommission(body.defaultCommission), notes: body.notes || '' },
    });
    if (!count) return null;

    return getRestaurantCommissionById(id);
}

export async function deleteRestaurantCommission(id) {
    if (!isId(id)) return null;
    const { count } = await prisma.foodRestaurantCommission.deleteMany({ where: { id: String(id) } });
    return count ? { id: String(id) } : null;
}

export async function toggleRestaurantCommissionStatus(id) {
    if (!isId(id)) return null;

    const current = await prisma.foodRestaurantCommission.findUnique({
        where: { id: String(id) },
        select: { status: true },
    });
    if (!current) return null;

    await prisma.foodRestaurantCommission.update({
        where: { id: String(id) },
        data: { status: !current.status },
    });
    return getRestaurantCommissionById(id);
}

// ─── Delivery payout slabs ───────────────────────────────────────────────────

const serializeRule = (row, index = 0) => ({
    _id: row.id,
    id: row.id,
    sl: index + 1,
    name: row.name || '',
    // Decimal columns; the admin table does arithmetic on these.
    minDistance: Number(row.minDistance),
    maxDistance: row.maxDistance === null ? null : Number(row.maxDistance),
    commissionPerKm: Number(row.commissionPerKm),
    basePayout: Number(row.basePayout),
    status: row.status !== false,
});

export async function getDeliveryCommissionRules() {
    const list = await prisma.foodDeliveryCommissionRule.findMany({
        orderBy: { createdAt: 'desc' },
    });
    return { commissions: list.map(serializeRule) };
}

/**
 * The slab ladder has to be continuous and non-overlapping.
 *
 * Kept in JS so the admin gets a sentence naming the problem. The database
 * enforces the overlap half as well (delivery_commission_rule_no_overlap),
 * because this check reads the current set and then writes — two admins saving
 * at once each validate against a set missing the other's slab.
 */
function validateCommissionRuleSet(rules) {
    const active = (rules || []).filter((r) => r && r.status !== false);
    if (!active.length) throw new ValidationError('A base slab with minDistance = 0 is required');

    const baseRules = active.filter((r) => Number(r.minDistance || 0) === 0);
    if (baseRules.length !== 1) {
        throw new ValidationError('A base slab with minDistance = 0 is required');
    }

    const sorted = [...active].sort((a, b) => Number(a.minDistance || 0) - Number(b.minDistance || 0));

    for (let i = 0; i < sorted.length; i += 1) {
        const min = Number(sorted[i].minDistance || 0);
        const max = sorted[i].maxDistance == null ? null : Number(sorted[i].maxDistance);

        if (max != null && max <= min) {
            throw new ValidationError('maxDistance must be greater than minDistance');
        }

        if (i > 0) {
            const prevMin = Number(sorted[i - 1].minDistance || 0);
            // A null upper bound means "and everything beyond".
            const prevMax = sorted[i - 1].maxDistance == null ? Infinity : Number(sorted[i - 1].maxDistance);

            if (min < prevMax) throw new ValidationError('Distance slabs must not overlap');
            if (min === prevMin) {
                throw new ValidationError('Distance slabs must not share the same minDistance');
            }
        }
    }
}

/** Turn the database's exclusion violation back into the admin-facing message. */
const asOverlapError = (error) => {
    if (error?.code === 'P2010' || /no_overlap/.test(error?.message || '')) {
        return new ValidationError('Distance slabs must not overlap');
    }
    return error;
};

const ruleFields = (body = {}) => ({
    minDistance: Number(body.minDistance) || 0,
    maxDistance: body.maxDistance == null ? null : Number(body.maxDistance),
    commissionPerKm: Number(body.commissionPerKm) || 0,
    basePayout: Number(body.basePayout) || 0,
});

export async function createDeliveryCommissionRule(body = {}) {
    const existing = await prisma.foodDeliveryCommissionRule.findMany();
    validateCommissionRuleSet([
        ...existing.map(serializeRule),
        { ...ruleFields(body), status: body.status ?? true },
    ]);

    try {
        const created = await prisma.foodDeliveryCommissionRule.create({
            data: { name: body.name || '', ...ruleFields(body), status: body.status ?? true },
        });
        return serializeRule(created);
    } catch (error) {
        throw asOverlapError(error);
    }
}

export async function updateDeliveryCommissionRule(id, body = {}) {
    if (!isId(id)) return null;

    const existing = await prisma.foodDeliveryCommissionRule.findMany();
    if (!existing.some((r) => r.id === String(id))) return null;

    validateCommissionRuleSet(
        existing.map((r) =>
            r.id === String(id)
                ? { ...serializeRule(r), ...ruleFields(body), status: r.status !== false }
                : serializeRule(r)
        )
    );

    try {
        const updated = await prisma.foodDeliveryCommissionRule.update({
            where: { id: String(id) },
            data: { name: body.name || '', ...ruleFields(body) },
        });
        return serializeRule(updated);
    } catch (error) {
        throw asOverlapError(error);
    }
}

export async function deleteDeliveryCommissionRule(id) {
    if (!isId(id)) return null;
    const { count } = await prisma.foodDeliveryCommissionRule.deleteMany({ where: { id: String(id) } });
    return count ? { id: String(id) } : null;
}

export async function toggleDeliveryCommissionRuleStatus(id, status) {
    if (!isId(id)) return null;

    const { count } = await prisma.foodDeliveryCommissionRule.updateMany({
        where: { id: String(id) },
        data: { status: Boolean(status) },
    });
    if (!count) return null;

    const updated = await prisma.foodDeliveryCommissionRule.findUnique({ where: { id: String(id) } });
    return serializeRule(updated);
}
