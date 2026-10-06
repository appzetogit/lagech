import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { ValidationError } from '../../../../core/auth/errors.js';
import { logger } from '../../../../utils/logger.js';
import { USED_ORDER_WHERE, couponRestaurantIds, effectiveCouponType } from '../../orders/services/couponRules.js';

/**
 * Admin coupons (Promotions -> Coupons), shaped like the old panel's
 * (6amMart) coupon page: a type (default, store wise, zone wise, free
 * delivery, first order), a title, a customer restriction, a per-customer
 * limit and dates.
 *
 * A coupon names its restaurants either singly (restaurantId) or as a list
 * (restaurantIds). Both are still supported because both exist in the data;
 * the list is the newer form.
 *
 * Restaurant-created offers (createdByRole RESTAURANT) live in the same table
 * and are listed here too; their funding split is left as the restaurant set
 * it unless the admin sends a new one.
 */

const num = (value) => Number(value || 0);

/** Hydrate every restaurant any of these offers names, in one query. */
const restaurantsNamedBy = async (offers) => {
    const ids = [...new Set(offers.flatMap((offer) => couponRestaurantIds(offer)).filter(isId))];
    if (!ids.length) return new Map();

    const rows = await prisma.foodRestaurant.findMany({
        where: { id: { in: ids } },
        select: { id: true, restaurantName: true },
    });
    return new Map(rows.map((r) => [r.id, r]));
};

const zonesNamedBy = async (offers) => {
    const ids = [...new Set(offers.flatMap((o) => o.zoneIds || []).map(String).filter(isId))];
    if (!ids.length) return new Map();
    const rows = await prisma.foodZone.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
    return new Map(rows.map((z) => [z.id, z]));
};

/**
 * Orders that used each coupon: placed with it applied, and not cancelled or
 * left unpaid -- the same count the per-customer limit uses.
 */
export const countCouponUses = async (offerIds) => {
    const ids = offerIds.filter(isId);
    if (!ids.length) return new Map();
    const rows = await prisma.foodOrder.groupBy({
        by: ['couponId'],
        where: { couponId: { in: ids }, ...USED_ORDER_WHERE },
        _count: { _all: true },
    });
    return new Map(rows.map((r) => [r.couponId, r._count._all]));
};

const TYPE_LABELS = {
    default: 'Default',
    store_wise: 'Store wise',
    zone_wise: 'Zone wise',
    free_delivery: 'Free delivery',
    first_order: 'First order',
};

const toRow = (o, index, { byId, zoneById, uses, now }) => {
    const endTs = o.endDate ? new Date(o.endDate).getTime() : null;
    const isExpired = Boolean(endTs && now >= endTs);
    const isScheduled = Boolean(o.startDate && now < new Date(o.startDate).getTime());
    const couponType = effectiveCouponType(o);

    const selectedIds = couponRestaurantIds(o);
    const restaurantNames = selectedIds.map((id) => byId.get(String(id))?.restaurantName).filter(Boolean);
    const restaurantName =
        o.restaurantScope === 'selected' ? restaurantNames.join(', ') || 'Selected Restaurants' : 'All Restaurants';
    const zoneIds = (o.zoneIds || []).map(String);

    return {
        sl: index + 1,
        id: o.id,
        offerId: o.id,
        title: o.title || '',
        couponCode: o.couponCode,
        couponType,
        couponTypeLabel: TYPE_LABELS[couponType] || couponType,

        // Kept for the earlier list and the notification broadcast page.
        dishId: 'all',
        restaurantName,
        dishName: 'All Items',
        restaurantScope: o.restaurantScope,
        restaurantIds: selectedIds,
        restaurants: selectedIds.map((id) => ({ id, name: byId.get(String(id))?.restaurantName || '' })),
        zoneIds,
        zones: zoneIds.map((id) => ({ id, name: zoneById.get(id)?.name || '' })),

        // The enum's Prisma name is first_time; the UI says 'new'. A
        // three-way scope cannot collapse to two: a specific coupon labelled
        // 'all' would read as usable by everyone.
        customerGroup:
            o.customerScope === 'first_time' ? 'new' : o.customerScope === 'specific' ? 'specific' : 'all',
        customerScope: o.customerScope,
        customerIds: Array.isArray(o.customerIds) ? o.customerIds : [],
        customerCount: Array.isArray(o.customerIds) ? o.customerIds.length : 0,

        discountType: o.discountType,
        discountValue: num(o.discountValue),
        discountPercentage: o.discountType === 'percentage' ? num(o.discountValue) : 0,
        originalPrice: o.discountType === 'flat_price' ? num(o.discountValue) : 0,
        discountedPrice: 0,
        minOrderValue: num(o.minOrderValue),
        maxDiscount: o.maxDiscount === null ? null : num(o.maxDiscount),

        startDate: o.startDate || null,
        endDate: o.endDate || null,
        // Expiry is derived from the date, not stored -- a coupon whose end
        // date has passed reads inactive even before the sweep runs.
        status: isExpired ? 'inactive' : o.status || 'active',
        // The switch itself, as the admin set it.
        isActive: o.status === 'active',
        isExpired,
        isScheduled,
        showInCart: o.showInCart !== false,

        usageLimit: o.usageLimit ?? null,
        perUserLimit: o.perUserLimit ?? null,
        usedCount: o.usedCount ?? 0,
        totalUses: uses.get(o.id) || 0,

        createdByRole: o.createdByRole || 'ADMIN',
        adminBearPercentage: num(o.adminBearPercentage),
        restaurantBearPercentage: num(o.restaurantBearPercentage),
        createdAt: o.createdAt,
    };
};

const hydrate = async (list) => {
    const [byId, zoneById, uses] = await Promise.all([
        restaurantsNamedBy(list),
        zonesNamedBy(list),
        countCouponUses(list.map((o) => o.id)),
    ]);
    return { byId, zoneById, uses, now: Date.now() };
};

/** Query: search (title or code), couponType. */
export async function getAllOffers(query = {}) {
    const where = {};
    const search = String(query.search || '').trim().slice(0, 80);
    if (search) {
        where.OR = [
            { title: { contains: search, mode: 'insensitive' } },
            { couponCode: { contains: search, mode: 'insensitive' } },
        ];
    }
    if (query.couponType && Object.keys(TYPE_LABELS).includes(String(query.couponType))) {
        where.couponType = String(query.couponType);
    }

    const list = await prisma.foodOffer.findMany({ where, orderBy: { createdAt: 'desc' } });
    const ctx = await hydrate(list);
    const offers = list.map((o, index) => toRow(o, index, ctx));
    return { offers, total: offers.length };
}

/** One coupon for the edit form, with the named customers resolved. */
export async function getAdminOffer(id) {
    if (!isId(id)) return null;
    const offer = await prisma.foodOffer.findUnique({ where: { id: String(id) } });
    if (!offer) return null;
    const row = toRow(offer, 0, await hydrate([offer]));
    const customerIds = row.customerIds.filter(isId);
    const customers = customerIds.length
        ? await prisma.foodUser.findMany({
            where: { id: { in: customerIds } },
            select: { id: true, name: true, phone: true },
        })
        : [];
    return { ...row, customers };
}

/** The columns a validated body writes. Undefined keys are left alone on update. */
const columnsFrom = (body) => {
    const couponType = body.couponType || (
        body.restaurantScope === 'selected'
            ? 'store_wise'
            : body.isFirstOrderOnly || body.customerScope === 'first_time' ? 'first_order' : 'default'
    );
    const selected = (body.restaurantScope || (couponType === 'store_wise' ? 'selected' : 'all')) === 'selected';
    const restaurantIds = selected
        ? [...new Set([...(body.restaurantIds || []), body.restaurantId].filter(Boolean).map(String))].filter(isId)
        : [];
    return {
        title: body.title ?? undefined,
        couponCode: body.couponCode,
        couponType,
        discountType: body.discountType,
        discountValue: body.discountValue,
        customerScope: body.customerScope,
        restaurantScope: selected ? 'selected' : 'all',
        restaurantId: selected ? restaurantIds[0] || null : null,
        restaurantIds,
        zoneIds: couponType === 'zone_wise' ? (body.zoneIds || []).map(String).filter(isId) : [],
        customerIds: body.customerIds ?? [],
        minOrderValue: body.minOrderValue ?? 0,
        maxDiscount: body.maxDiscount ?? null,
        usageLimit: body.usageLimit ?? null,
        perUserLimit: body.perUserLimit ?? null,
        startDate: body.startDate ? new Date(body.startDate) : null,
        endDate: body.endDate ? new Date(body.endDate) : null,
        isFirstOrderOnly: couponType === 'first_order' || Boolean(body.isFirstOrderOnly),
    };
};

const notifyInvitedRestaurants = async (offer) => {
    const invited = offer.restaurantScope === 'selected' ? couponRestaurantIds(offer) : [];
    if (!invited.length) return;
    try {
        const { notifyOwnersSafely } = await import('../../../../core/notifications/firebase.service.js');
        await notifyOwnersSafely(
            invited.map((ownerId) => ({ ownerType: 'RESTAURANT', ownerId })),
            {
                title: 'New Campaign Invitation!',
                body: `You have been invited to join a new campaign: "${offer.couponCode}". Check it out now!`,
                image: 'https://i.ibb.co/5GzXz7r/Switcheats-Brand-Image.png',
                data: {
                    type: 'campaign_invitation',
                    offerId: offer.id,
                    couponCode: offer.couponCode,
                },
            },
        );
    } catch (e) {
        logger.error('Failed to send campaign invitation notification:', e);
    }
};

export async function createAdminOffer(body = {}) {
    const columns = columnsFrom(body);
    let offer;
    try {
        offer = await prisma.foodOffer.create({
            data: {
                ...columns,
                title: columns.title ?? '',
                // Created already expired: start inactive rather than appearing
                // live until a sweep notices.
                status:
                    columns.endDate && columns.endDate.getTime() <= Date.now()
                        ? 'inactive'
                        : 'active',
                showInCart: true,
                createdByRole: 'ADMIN',
                // An admin campaign is platform-funded by default.
                adminBearPercentage: body.adminBearPercentage ?? 100,
                restaurantBearPercentage: body.restaurantBearPercentage ?? 0,
            },
        });
    } catch (error) {
        // couponCode is unique; the insert settles it rather than a prior lookup.
        if (error?.code === 'P2002') throw new ValidationError('Coupon code already exists');
        throw error;
    }

    await notifyInvitedRestaurants(offer);
    return offer;
}

export async function updateAdminOffer(id, body = {}) {
    if (!isId(id)) return null;
    const columns = columnsFrom(body);
    const data = Object.fromEntries(Object.entries(columns).filter(([, v]) => v !== undefined));
    if (body.adminBearPercentage !== undefined) data.adminBearPercentage = body.adminBearPercentage;
    if (body.restaurantBearPercentage !== undefined) data.restaurantBearPercentage = body.restaurantBearPercentage;
    try {
        const { count } = await prisma.foodOffer.updateMany({ where: { id: String(id) }, data });
        if (!count) return null;
    } catch (error) {
        if (error?.code === 'P2002') throw new ValidationError('Coupon code already exists');
        throw error;
    }
    return prisma.foodOffer.findUnique({ where: { id: String(id) } });
}

/** The list's status switch. Switching on an expired coupon is allowed; it still reads expired. */
export async function setAdminOfferStatus(id, status) {
    if (!isId(id)) return null;
    const { count } = await prisma.foodOffer.updateMany({ where: { id: String(id) }, data: { status } });
    if (!count) return null;
    return prisma.foodOffer.findUnique({ where: { id: String(id) } });
}

export async function updateAdminOfferCartVisibility(offerId, itemId, showInCart) {
    if (!isId(offerId) || !itemId) return null;

    const { count } = await prisma.foodOffer.updateMany({
        where: { id: String(offerId) },
        data: { showInCart: Boolean(showInCart) },
    });
    if (!count) return null;

    return prisma.foodOffer.findUnique({ where: { id: String(offerId) } });
}

export async function deleteAdminOffer(id) {
    if (!isId(id)) return null;

    // Usage rows cascade from the offer (onDelete: Cascade); orders keep their
    // couponCode and lose only the couponId link (onDelete: SetNull).
    const { count } = await prisma.foodOffer.deleteMany({ where: { id: String(id) } });
    return count ? { id: String(id) } : null;
}

/** Sweep coupons whose end date has passed. Run by scripts/run-scheduled-jobs.js. */
export async function expireExpiredOffers() {
    const { count } = await prisma.foodOffer.updateMany({
        where: { status: 'active', endDate: { lte: new Date() } },
        data: { status: 'inactive' },
    });
    return { expired: count };
}
